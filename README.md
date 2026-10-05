# multi-db-mcp

An MCP server for read-only SQL against several named databases (local, staging, production, …)
from one place. It supports MySQL (including MariaDB and Aurora) and Postgres.

## Safety model

Every database, local or remote, is **read-only**. Remote primaries (e.g. staging, hotfix) are
allowed; add `"requireReplica": true` to entries that must only ever reach a replica (e.g. production).

| Rule | How it's enforced |
| --- | --- |
| Nothing writes | Every statement runs in `BEGIN READ ONLY` / `START TRANSACTION READ ONLY`, which is always rolled back. MySQL sessions are also set to `SESSION TRANSACTION READ ONLY`, which blocks DDL. Postgres uses the extended protocol, and MySQL runs with `multipleStatements: false`, so a `SELECT 1; DROP …` batch is refused. A keyword allowlist (SELECT/WITH/SHOW/EXPLAIN/DESCRIBE/VALUES/TABLE) adds a quick first check. |
| No row locks | Locking reads (`FOR UPDATE`, `FOR SHARE`, `LOCK IN SHARE MODE`) are refused. MySQL allows them in read-only transactions, and on a primary they would block real writes. |
| Bounded cost | Each entry has a server-side statement timeout (`timeoutMs`), and results are capped at `maxRows`. On primaries, consider a lower `timeoutMs` so a heavy query can't load the server for long. |
| Optional: replica only | With `"requireReplica": true`, the server checks before **every** statement, on the same connection and inside the same transaction, for `pg_is_in_recovery() = true` (Postgres) or `read_only` / `super_read_only` / `innodb_read_only = ON` (MySQL). If the check fails, the statement is refused. Because it runs every time, a failover that promotes the replica to primary is caught right away. |

Even so, give each entry a database user that only has read access (e.g. `GRANT SELECT, SHOW VIEW`).
This matters most for entries that point at primaries, where the database user's grants are the
only protection outside this server.

## Setup

### Let Claude do it

Clone the repo, open the folder in Claude Code (the Claude Desktop Code tab or the CLI), and ask:

> Set up multi-db-mcp for me.

Claude follows [CLAUDE.md](CLAUDE.md). It asks which databases you want, writes `databases.json`,
registers the server with Claude Desktop and checks every connection. The only thing you do yourself
is type the passwords into `.env`; Claude never asks for them in the chat.

### By hand

```bash
npm install
cp databases.example.json databases.json   # edit it: your databases, passwords as ${VARS}
npm run setup                              # build, validate, stub .env, register with Claude Desktop
# fill in the passwords in .env
npm run check                              # connect to every database and run SELECT 1
```

Then fully quit and reopen Claude Desktop.

`npm run setup` options (after `--`):
- `--dry-run`: show what it would change without changing anything.
- `--skip-register`: don't touch the Claude Desktop config (e.g. when you use the Claude Code CLI).
- `--desktop-config <path>`: use this Claude Desktop config file instead of finding it automatically.
- `--config <path>`: use a `databases.json` somewhere else.

The registration uses the absolute paths of `node`, `dist/index.js` and `databases.json`, and backs
up the existing Claude Desktop config before changing it. Running it again is safe.

### Config files

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
      "requireReplica": true,      // optional: refuse unless the server is a read replica
      "maxRows": 200, "timeoutMs": 15000
    }
  }
}
```

The config is read from the `MULTI_DB_CONFIG` env var, then from the first CLI argument, then from
`databases.json` in the project root.

## Register with Claude manually

`npm run setup` registers the server with Claude Desktop for you. Use this section if you'd rather
do it by hand, or use the Claude Code CLI or a per-project `.mcp.json`.

The examples use `C:/dev/multi-db-mcp`; replace it with wherever you cloned the repo. Use forward
slashes in paths.

### Claude Desktop (Chat and Code tabs)

No CLI is needed. Servers in the desktop app's config also load in Code tab sessions.

1. In Claude Desktop, open **Settings → Developer → Edit Config**. This opens
   `claude_desktop_config.json` (`%APPDATA%\Claude\claude_desktop_config.json` on Windows,
   `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS).
2. Add a top-level `mcpServers` block, keeping the file's existing keys:

   ```json
   {
     "mcpServers": {
       "multi-db": {
         "command": "node",
         "args": ["C:/dev/multi-db-mcp/dist/index.js"]
       }
     }
   }
   ```

3. Fully quit Claude Desktop (from the tray / menu bar icon, not just closing the window), reopen it,
   and start a new session.

To use it in a single project only, put the same `mcpServers` block in a `.mcp.json` file at that
project's root. The Code tab asks you to approve it the first time.

### Claude Code CLI

```bash
claude mcp add multi-db --scope user -- node C:/dev/multi-db-mcp/dist/index.js
```

### Config stored elsewhere

If `databases.json` isn't in the repo root, point to it with `MULTI_DB_CONFIG`. In a JSON config,
add `"env": { "MULTI_DB_CONFIG": "C:/path/to/databases.json" }` next to `"args"`. With the CLI, use
`claude mcp add multi-db --scope user -e MULTI_DB_CONFIG=C:/path/to/databases.json -- node C:/dev/multi-db-mcp/dist/index.js`.

### Verify

Run `npm run check` to test every connection from the terminal, without restarting Claude.

In a new session, ask Claude to *"list the databases with checkConnections on"*. Every entry should
show `usable: true`. An entry with `requireReplica` that shows `usable: false` is pointing at a
primary; switch it to the replica / reader endpoint.

If Claude doesn't have the tools:
- **Wrong path:** check that the path to `dist/index.js` is correct and that you ran `npm run build`.
- **`node` not found:** if `node` isn't on your PATH, use the full path to `node.exe` as `command`.
- **Invalid JSON:** check that the config file is still valid JSON, then restart the app.
- **Logs:** Claude Desktop writes MCP logs to `%APPDATA%\Claude\logs\` on Windows and `~/Library/Logs/Claude/` on macOS.

## Tools

- `list_databases`: lists the configured entries. Pass `checkConnections: true` to also get each one's version and replica status.
- `query`: runs one read statement against a named database, with optional positional `params` and `maxRows`.
- `list_tables`: lists tables and views with approximate row counts.
- `describe_table`: shows a table's columns and indexes.

## Development

```bash
npm test          # safety unit tests
npm run check     # end-to-end check against the configured databases
npm run dev       # run from source with tsx
```
