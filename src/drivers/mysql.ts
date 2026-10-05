import mysql from 'mysql2/promise';
import type { DatabaseConfig } from '../config.js';
import { assertReadOnlyStatement, NotReplicaError } from '../safety.js';
import { type Driver, type QueryResult, type ServerStatus, toResult } from './types.js';

const META_MAX_ROWS = 5_000;
const READ_ONLY_VARS = ['read_only', 'super_read_only', 'innodb_read_only'];

export class MysqlDriver implements Driver {
  private readonly pool: mysql.Pool;
  /** Server-side timeout statement this server accepts; null if none does. */
  private timeoutStatement: string | null | undefined;

  constructor(private readonly cfg: DatabaseConfig) {
    this.pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port ?? 3306,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ssl: cfg.ssl === true ? {} : cfg.ssl || undefined,
      connectionLimit: 2,
      maxIdle: 2,
      idleTimeout: 30_000,
      connectTimeout: 10_000,
      // Never allow "SELECT 1; DROP TABLE x" style batches.
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      // Return DATE/DATETIME as the stored strings instead of shifting them into the local timezone.
      dateStrings: true,
    });
  }

  private async readStatus(conn: mysql.PoolConnection): Promise<ServerStatus> {
    // SHOW VARIABLES works on MySQL, MariaDB and Aurora even where some variables don't exist.
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${[...READ_ONLY_VARS, 'version', 'version_comment'].map(() => '?').join(', ')})`,
      [...READ_ONLY_VARS, 'version', 'version_comment'],
    );
    const vars = Object.fromEntries(rows.map((r) => [String(r.Variable_name), String(r.Value)]));
    const present = READ_ONLY_VARS.filter((v) => v in vars);
    return {
      // Classic replicas set read_only/super_read_only; Aurora readers set innodb_read_only.
      isReplica: present.some((v) => vars[v] === 'ON' || vars[v] === '1'),
      detail: present.map((v) => `${v}=${vars[v]}`).join(', '),
      version: [vars.version, vars.version_comment].filter(Boolean).join(' '),
    };
  }

  private async setTimeout(conn: mysql.PoolConnection): Promise<void> {
    if (this.timeoutStatement === undefined) {
      const ms = Math.trunc(this.cfg.timeoutMs);
      // MySQL takes milliseconds, MariaDB takes seconds; remember whichever the server accepts.
      for (const candidate of [`SET SESSION max_execution_time = ${ms}`, `SET SESSION max_statement_time = ${ms / 1000}`]) {
        try {
          await conn.query(candidate);
          this.timeoutStatement = candidate;
          return;
        } catch {
          // try the next flavor
        }
      }
      // Neither exists (very old server); the client-side timeout in run() still applies.
      this.timeoutStatement = null;
    } else if (this.timeoutStatement) {
      await conn.query(this.timeoutStatement);
    }
  }

  /**
   * Run `fn` inside a READ ONLY transaction that is always rolled back. The session is also put in
   * READ ONLY mode, which blocks DDL even though DDL implicitly commits the open transaction.
   */
  private async withSession<T>(fn: (conn: mysql.PoolConnection) => Promise<T>, enforceReplica = true): Promise<T> {
    const conn = await this.pool.getConnection();
    let broken = false;
    try {
      await conn.query('SET SESSION TRANSACTION READ ONLY');
      await this.setTimeout(conn);
      await conn.query('START TRANSACTION READ ONLY');
      if (enforceReplica && this.cfg.requireReplica) {
        const status = await this.readStatus(conn);
        if (!status.isReplica) throw new NotReplicaError(this.cfg.name, status.detail);
      }
      return await fn(conn);
    } finally {
      try {
        await conn.query('ROLLBACK');
      } catch {
        broken = true;
      }
      if (broken) conn.destroy();
      else conn.release();
    }
  }

  status(): Promise<ServerStatus> {
    return this.withSession((c) => this.readStatus(c), false);
  }

  private async run(conn: mysql.PoolConnection, sql: string, params: unknown[], maxRows: number): Promise<QueryResult> {
    const [rows, fields] = await conn.query<mysql.RowDataPacket[][]>({
      sql,
      values: params,
      rowsAsArray: true,
      timeout: this.cfg.timeoutMs + 5_000,
    });
    return toResult(fields?.map((f) => f.name) ?? [], Array.isArray(rows) ? rows : [], maxRows);
  }

  query(sql: string, params: unknown[], maxRows: number): Promise<QueryResult> {
    assertReadOnlyStatement(sql);
    return this.withSession((c) => this.run(c, sql, params, maxRows));
  }

  listTables(schema?: string): Promise<QueryResult> {
    const sql = `
      SELECT table_schema AS \`schema\`, table_name AS name, table_type AS type, table_rows AS approx_rows
      FROM information_schema.tables
      WHERE table_schema = COALESCE(?, DATABASE())
         OR (COALESCE(?, DATABASE()) IS NULL
             AND table_schema NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema'))
      ORDER BY table_schema, table_name`;
    return this.withSession((c) => this.run(c, sql, [schema ?? null, schema ?? null], META_MAX_ROWS));
  }

  describeTable(table: string, schema?: string): Promise<{ columns: QueryResult; indexes: QueryResult }> {
    return this.withSession(async (c) => {
      const columns = await this.run(
        c,
        `SELECT column_name AS name, column_type AS type, is_nullable AS nullable,
                column_default AS \`default\`, column_key AS \`key\`, extra
         FROM information_schema.columns
         WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?
         ORDER BY ordinal_position`,
        [schema ?? null, table],
        META_MAX_ROWS,
      );
      if (columns.rowCount === 0) throw new Error(`Table '${schema ? `${schema}.` : ''}${table}' not found.`);
      const indexes = await this.run(
        c,
        `SELECT index_name AS name, non_unique,
                GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
         FROM information_schema.statistics
         WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?
         GROUP BY index_name, non_unique
         ORDER BY index_name`,
        [schema ?? null, table],
        META_MAX_ROWS,
      );
      return { columns, indexes };
    });
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
