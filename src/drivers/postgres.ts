import pg from 'pg';
import type { DatabaseConfig } from '../config.js';
import { assertReadOnlyStatement, NotReplicaError } from '../safety.js';
import { type Driver, type QueryResult, type ServerStatus, toResult } from './types.js';

const META_MAX_ROWS = 5_000;

export class PostgresDriver implements Driver {
  private readonly pool: pg.Pool;

  constructor(private readonly cfg: DatabaseConfig) {
    this.pool = new pg.Pool({
      host: cfg.host,
      port: cfg.port ?? 5432,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ssl: cfg.ssl,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      application_name: 'multi-db-mcp',
    });
    // An idle connection dropped by the server must not crash the MCP process.
    this.pool.on('error', (err) => console.error(`[${cfg.name}] idle connection error: ${err.message}`));
  }

  private async readStatus(client: pg.PoolClient): Promise<ServerStatus> {
    const { rows } = await client.query<{ in_recovery: boolean; version: string }>(
      'SELECT pg_is_in_recovery() AS in_recovery, version() AS version',
    );
    return {
      isReplica: rows[0].in_recovery,
      detail: `pg_is_in_recovery() = ${rows[0].in_recovery}`,
      version: rows[0].version,
    };
  }

  /**
   * Run `fn` inside a READ ONLY transaction that is always rolled back. The replica check runs
   * inside the same transaction so it hits the same backend even behind a transaction pooler.
   */
  private async withSession<T>(fn: (client: pg.PoolClient) => Promise<T>, enforceReplica = true): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN READ ONLY');
      if (enforceReplica && this.cfg.requireReplica) {
        const status = await this.readStatus(client);
        if (!status.isReplica) throw new NotReplicaError(this.cfg.name, status.detail);
      }
      await client.query(`SET LOCAL statement_timeout = ${Math.trunc(this.cfg.timeoutMs)}`);
      return await fn(client);
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      client.release(broken);
    }
  }

  status(): Promise<ServerStatus> {
    return this.withSession((c) => this.readStatus(c), false);
  }

  private async run(client: pg.PoolClient, sql: string, params: unknown[], maxRows: number): Promise<QueryResult> {
    // Extended protocol rejects multi-statement strings, so "SELECT 1; COMMIT; DROP ..." can't escape the transaction.
    const res = await client.query({ text: sql, values: params, rowMode: 'array', queryMode: 'extended' } as pg.QueryArrayConfig);
    return toResult(res.fields?.map((f) => f.name) ?? [], res.rows ?? [], maxRows);
  }

  query(sql: string, params: unknown[], maxRows: number): Promise<QueryResult> {
    assertReadOnlyStatement(sql);
    return this.withSession((c) => this.run(c, sql, params, maxRows));
  }

  listTables(schema?: string): Promise<QueryResult> {
    const sql = `
      SELECT t.table_schema AS schema, t.table_name AS name, t.table_type AS type, c.reltuples::bigint AS approx_rows
      FROM information_schema.tables t
      LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
      LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
      WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema') AND t.table_schema NOT LIKE 'pg_toast%'
        AND ($1::text IS NULL OR t.table_schema = $1)
      ORDER BY 1, 2`;
    return this.withSession((c) => this.run(c, sql, [schema ?? null], META_MAX_ROWS));
  }

  describeTable(table: string, schema?: string): Promise<{ columns: QueryResult; indexes: QueryResult }> {
    return this.withSession(async (c) => {
      const columns = await this.run(
        c,
        `SELECT column_name AS name, data_type AS type, character_maximum_length AS max_length,
                is_nullable AS nullable, column_default AS default
         FROM information_schema.columns
         WHERE table_schema = COALESCE($1, current_schema()) AND table_name = $2
         ORDER BY ordinal_position`,
        [schema ?? null, table],
        META_MAX_ROWS,
      );
      if (columns.rowCount === 0) throw new Error(`Table '${schema ? `${schema}.` : ''}${table}' not found.`);
      const indexes = await this.run(
        c,
        `SELECT indexname AS name, indexdef AS definition FROM pg_indexes
         WHERE schemaname = COALESCE($1, current_schema()) AND tablename = $2 ORDER BY indexname`,
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
