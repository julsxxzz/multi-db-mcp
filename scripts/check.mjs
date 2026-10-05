#!/usr/bin/env node
// Starts the server the same way Claude does (stdio), then connects to every configured database
// and runs SELECT 1 through the real query path. Exits non-zero if anything is unusable.
//
// Usage: npm run check [-- --config <path>]

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({ options: { config: { type: 'string' } } });
const configPath = resolve(args.config ?? process.env.MULTI_DB_CONFIG ?? join(root, 'databases.json'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist', 'index.js')],
  env: { ...process.env, MULTI_DB_CONFIG: configPath },
  stderr: 'pipe',
});
let serverLog = '';
transport.stderr?.on('data', (chunk) => (serverLog += chunk));

const client = new Client({ name: 'multi-db-check', version: '1.0.0' });
try {
  await client.connect(transport);
} catch (err) {
  console.error(`✖ The server failed to start: ${err.message}\n${serverLog.trim()}`);
  process.exit(1);
}

const callText = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), text: r.content.map((c) => c.text).join('\n') };
};

const { databases, misconfigured = [] } = JSON.parse((await callText('list_databases', { checkConnections: true })).text);
let problems = 0;
console.log(`Checking ${databases.length} database(s) from ${configPath}\n`);

for (const db of databases) {
  const label = `${db.name.padEnd(16)} ${db.engine.padEnd(8)} ${db.host}`;
  const s = db.status;
  if ('error' in s) {
    problems++;
    console.log(`✖ ${label}\n    connection failed: ${s.error}`);
    continue;
  }
  if (!s.usable) {
    problems++;
    console.log(`✖ ${label}\n    requireReplica is set but the server is writable (${s.detail}); use the replica endpoint`);
    continue;
  }
  const q = await callText('query', { database: db.name, sql: 'SELECT 1 AS ok' });
  if (q.isError) {
    problems++;
    console.log(`✖ ${label}\n    connected, but SELECT 1 failed: ${q.text}`);
    continue;
  }
  const role = s.isReplica ? 'replica' : db.local ? 'local, read-only' : 'primary, read-only';
  const version = s.version.length > 60 ? `${s.version.slice(0, 57)}...` : s.version;
  console.log(`✔ ${label}\n    ${role} · ${version}`);
}
for (const m of misconfigured) {
  problems++;
  console.log(`✖ ${m.name.padEnd(16)} misconfigured: ${m.error}`);
}

await client.close();
console.log(problems ? `\n${problems} problem(s) found.` : '\nAll databases OK.');
process.exit(problems ? 1 : 0);
