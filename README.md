# multi-db-mcp

An MCP server for read-only SQL against several named databases (local, staging, production, …)
from one place. It supports MySQL (including MariaDB and Aurora) and Postgres.

## Safety model

| Rule | How it's enforced |
| --- | --- |
| Non-local databases must be read replicas | Before **every** statement, on the same connection and inside the same transaction, the server checks for `pg_is_in_recovery() = true` (Postgres) or `read_only` / `super_read_only` / `innodb_read_only = ON` (MySQL). If the check fails, the statement is refused. Because it runs every time, a failover that promotes the replica to primary is caught right away. |
| "Local" means a loopback address, written out in the config | Only `localhost`, `*.localhost`, `127.x.x.x` and `::1` count as local. Hostnames are not resolved, so an unfamiliar name is treated as remote and must be a replica. |
| Entries can't turn the replica check off | `requireReplica: false` on a non-local host is a config error, and that entry is not loaded. |
| SSH tunnels / port forwards | A tunnel to prod looks like `127.0.0.1`. Set `"requireReplica": true` on those entries. |
| Nothing writes | Every statement runs in `BEGIN READ ONLY` / `START TRANSACTION READ ONLY`, which is always rolled back. MySQL sessions are also set to `SESSION TRANSACTION READ ONLY`, which blocks DDL. Postgres uses the extended protocol, and MySQL runs with `multipleStatements: false`, so a `SELECT 1; DROP …` batch is refused. A keyword allowlist (SELECT/WITH/SHOW/EXPLAIN/DESCRIBE/VALUES/TABLE) adds a quick first check. |
| Bounded cost | Each entry has a server-side statement timeout (`timeoutMs`), and results are capped at `maxRows`. |

Even so, give each entry a database user that only has read access. These checks protect you, but
they shouldn't replace proper grants.

## Setup

```bash
npm install
npm run build
cp databases.example.json databases.json   # edit it
cp .env.example .env                       # put passwords here
```

Any string in `databases.json` can use `${ENV_VAR}`. Variables come from the MCP client's `env` or
from a `.env` file next to the config. Variables already set in the environment take priority.
If an entry is broken (for example, a variable is missing), that entry is skipped and reported by
`list_databases`; the other entries still work.

### Config reference

```jsonc
{
  "defaults": { "maxRows": 200, "timeoutMs": 15000 },
  "databases": {
    "<name>": {
      "engine": "mysql" | "postgres",
      "host": "...", "port": 3306, "user": "...", "password": "${VAR}", "database": "...",
      "description": "shown to the model",
      "ssl": true | { "rejectUnauthorized": true, "caFile": "certs/rds-global-bundle.pem" },
      "requireReplica": true,      // force the replica check on a localhost tunnel
      "maxRows": 200, "timeoutMs": 15000
    }
  }
}
```

The config is read from the `MULTI_DB_CONFIG` env var, then from the first CLI argument, then from
`databases.json` in the project root.

## Register with Claude Code

```bash
claude mcp add multi-db --scope user -- node D:/Projects/multi-db-mcp/dist/index.js
```

To use a config stored somewhere else, set the env var:
`claude mcp add multi-db --scope user -e MULTI_DB_CONFIG=C:/path/databases.json -- node D:/Projects/multi-db-mcp/dist/index.js`.

## Tools

- `list_databases`: lists the configured entries. Pass `checkConnections: true` to also get each one's version and replica status.
- `query`: runs one read statement against a named database, with optional positional `params` and `maxRows`.
- `list_tables`: lists tables and views with approximate row counts.
- `describe_table`: shows a table's columns and indexes.

## Development

```bash
npm test          # safety unit tests
npm run dev       # run from source with tsx
```
