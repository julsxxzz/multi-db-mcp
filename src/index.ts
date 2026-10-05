#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { type DatabaseConfig, loadConfig } from './config.js';
import { MysqlDriver } from './drivers/mysql.js';
import { PostgresDriver } from './drivers/postgres.js';
import type { Driver, QueryResult } from './drivers/types.js';

const configPath =
  process.env.MULTI_DB_CONFIG ?? process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'databases.json');
const config = loadConfig(configPath);
for (const b of config.broken) console.error(`[multi-db-mcp] skipping '${b.name}': ${b.error}`);

const drivers = new Map<string, Driver>();

function getDriver(name: string): { cfg: DatabaseConfig; driver: Driver } {
  const cfg = config.databases.get(name);
  if (!cfg) {
    const broken = config.broken.find((b) => b.name === name);
    throw new Error(
      broken
        ? `Database '${name}' is misconfigured: ${broken.error}`
        : `Unknown database '${name}'. Available: ${[...config.databases.keys()].join(', ') || '(none)'}`,
    );
  }
  let driver = drivers.get(name);
  if (!driver) {
    driver = cfg.engine === 'postgres' ? new PostgresDriver(cfg) : new MysqlDriver(cfg);
    drivers.set(name, driver);
  }
  return { cfg, driver };
}

function formatResult(r: QueryResult): string {
  const lines = [JSON.stringify({ columns: r.columns, rowCount: r.rowCount, truncated: r.truncated })];
  for (const row of r.rows) lines.push(JSON.stringify(row));
  if (r.truncated) lines.push(`… showing first ${r.rows.length} of ${r.rowCount} rows; narrow the query or raise maxRows.`);
  return lines.join('\n');
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (err: unknown) => ({ isError: true, ...text(err instanceof Error ? err.message : String(err)) });

const names = [...config.databases.keys()];
const databaseArg = (names.length > 0 ? z.enum(names as [string, ...string[]]) : z.string()).describe(
  'Database name from list_databases.',
);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const server = new McpServer(
  { name: 'multi-db', version: '1.0.0' },
  {
    instructions:
      'Read-only SQL access to several named databases (e.g. local, staging, production). ' +
      'Every call must name the database explicitly; call list_databases to see them. ' +
      'All statements run in read-only transactions; entries marked replicaRequired are also verified ' +
      'to be read replicas before each statement. Non-local entries that are not replicas are live ' +
      'primaries: keep queries narrow (WHERE on indexed columns, LIMIT) and avoid full-table scans.',
  },
);

server.registerTool(
  'list_databases',
  {
    title: 'List databases',
    description:
      'List configured databases with engine, host, and whether they are local and replica-only. ' +
      'Set checkConnections to connect to each one and report its version and replica status.',
    inputSchema: { checkConnections: z.boolean().optional().describe('Connect and report status (slower).') },
    annotations: readOnly,
  },
  async ({ checkConnections }) => {
    const entries = await Promise.all(
      [...config.databases.values()].map(async (cfg) => {
        const info: Record<string, unknown> = {
          name: cfg.name,
          engine: cfg.engine,
          description: cfg.description,
          host: cfg.host,
          database: cfg.database,
          local: cfg.isLocal,
          replicaRequired: cfg.requireReplica,
        };
        if (checkConnections) {
          try {
            const s = await getDriver(cfg.name).driver.status();
            info.status = {
              version: s.version,
              isReplica: s.isReplica,
              detail: s.detail,
              usable: !cfg.requireReplica || s.isReplica,
            };
          } catch (err) {
            info.status = { error: (err as Error).message };
          }
        }
        return info;
      }),
    );
    const misconfigured = config.broken.map((b) => ({ name: b.name, error: b.error }));
    return text(JSON.stringify({ databases: entries, ...(misconfigured.length ? { misconfigured } : {}) }, null, 2));
  },
);

server.registerTool(
  'query',
  {
    title: 'Run read-only SQL',
    description:
      'Run a single read-only SQL statement (SELECT, WITH, SHOW, EXPLAIN, DESCRIBE) against one database. ' +
      'Use params for values: $1, $2 placeholders on Postgres, ? on MySQL. ' +
      'Output: a JSON header line, then one JSON array per row.',
    inputSchema: {
      database: databaseArg,
      sql: z.string().min(1).describe('A single SQL statement.'),
      params: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe('Positional parameter values.'),
      maxRows: z.number().int().positive().max(5_000).optional().describe('Rows to return (default from config, usually 200).'),
    },
    annotations: readOnly,
  },
  async ({ database, sql, params, maxRows }) => {
    try {
      const { cfg, driver } = getDriver(database);
      return text(formatResult(await driver.query(sql, params ?? [], maxRows ?? cfg.maxRows)));
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  'list_tables',
  {
    title: 'List tables',
    description: "List tables and views with approximate row counts. Defaults to the connection's database/schema.",
    inputSchema: {
      database: databaseArg,
      schema: z.string().optional().describe('Schema (Postgres) or database (MySQL) to list.'),
    },
    annotations: readOnly,
  },
  async ({ database, schema }) => {
    try {
      return text(formatResult(await getDriver(database).driver.listTables(schema)));
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  'describe_table',
  {
    title: 'Describe table',
    description: 'Show the columns and indexes of a table.',
    inputSchema: {
      database: databaseArg,
      table: z.string().min(1),
      schema: z.string().optional().describe('Schema (Postgres) or database (MySQL); defaults to the current one.'),
    },
    annotations: readOnly,
  },
  async ({ database, table, schema }) => {
    try {
      const { columns, indexes } = await getDriver(database).driver.describeTable(table, schema);
      return text(`# columns\n${formatResult(columns)}\n\n# indexes\n${formatResult(indexes)}`);
    } catch (err) {
      return failure(err);
    }
  },
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled([...drivers.values()].map((d) => d.close()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
console.error(`[multi-db-mcp] ready with ${names.length} database(s) from ${config.path}`);
