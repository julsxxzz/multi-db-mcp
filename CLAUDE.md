# multi-db-mcp

MCP server giving Claude read-only SQL access to several named MySQL/Postgres databases.
Source is in `src/` (TypeScript, built to `dist/`); `README.md` has the safety model and config reference.

## Setting it up for the user

When the user asks to set up, install or configure this server, follow these steps in order.

1. **Prerequisites.** Check `node --version`; it must be 20.12 or newer. Then run `npm install`.

2. **Collect the databases.** Ask the user for each database they want: a short name (e.g. `local`,
   `staging`, `hotfix`, `production`), the engine (`mysql` or `postgres`), host, port, database name
   and username, and whether it must only ever reach a read replica. If the user points you to
   their application's datasource config, you can read hosts, ports and database names from it.
   **Never ask the user to paste passwords into the chat, and never read or print them.**

3. **Write `databases.json`** in the repo root, based on `databases.example.json`:
   - Passwords are always `"${NAME_DB_PASSWORD}"` env references, never literal values.
   - Set `"requireReplica": true` on entries that must only reach a replica (typically production).
   - Use `"ssl": true` for remote hosts unless the user says otherwise. For AWS RDS / Aurora
     certificate errors, the user needs to download Amazon's `global-bundle.pem`, save it as
     `certs/rds-global-bundle.pem`, and use `"ssl": { "caFile": "certs/rds-global-bundle.pem" }`.
   - For entries that point at primaries, suggest a lower `timeoutMs` (e.g. 10000).

4. **Run `npm run setup`.** It builds the server, validates `databases.json`, adds empty
   placeholders to `.env` for missing password variables, and registers the server in the Claude
   Desktop config (backing it up first). Fix any `✖` entries it reports and re-run it.
   - It finds the config automatically; if it can't, ask the user where Claude Desktop is installed
     and pass `-- --desktop-config <path>`.
   - If the user uses the Claude Code CLI instead of Claude Desktop, pass `-- --skip-register` and
     have them run the `claude mcp add` command from the README.

5. **Ask the user to fill in `.env`.** Tell them the file's path and the variable names setup
   listed, and wait for them to confirm. Recommend a read-only database user
   (`GRANT SELECT, SHOW VIEW ON <db>.* TO ...`), especially for primaries.

6. **Run `npm run check`.** It connects to every database the same way Claude will. For each `✖`:
   - *connection failed / timeout*: VPN, firewall or wrong host/port.
   - *Access denied*: wrong user or password; ask the user to recheck `.env`.
   - *requireReplica is set but the server is writable*: the host is the primary; ask for the
     replica / reader endpoint.
   - *certificate errors*: see the SSL note in step 3.
   Re-run until it reports `All databases OK`.

7. **Finish.** Tell the user to fully quit Claude Desktop (from the tray / menu bar icon, not just
   closing the window), reopen it and start a new session. They can confirm by asking Claude to
   "list the databases with checkConnections on".

To update an existing install later: `git pull`, then `npm install` and `npm run setup`.

## Development

- `npm run build`: compile to `dist/`
- `npm test`: safety unit tests (`src/safety.test.ts`)
- `npm run check`: end-to-end check against the configured databases
- Logs go to stderr only; stdout is the MCP protocol stream.
- Every statement must go through a driver's `withSession` (read-only transaction, always rolled
  back, plus the replica check when `requireReplica` is set). Don't add a code path that skips it.
