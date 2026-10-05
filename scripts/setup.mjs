#!/usr/bin/env node
// Validates databases.json, adds missing ${VAR} keys to .env, and registers the server with
// Claude Desktop (whose config is also loaded by Code tab sessions).
//
// Usage: npm run setup [-- --config <path>] [--desktop-config <path>] [--name <name>] [--skip-register] [--dry-run]

import { appendFileSync, copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    config: { type: 'string' },
    'desktop-config': { type: 'string' },
    name: { type: 'string', default: 'multi-db' },
    'skip-register': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

// 1. Prerequisites
if (typeof process.loadEnvFile !== 'function') fail(`Node ${process.versions.node} is too old; install Node 20.12+ (22+ recommended).`);
const serverEntry = join(root, 'dist', 'index.js');
if (!existsSync(serverEntry)) fail('dist/index.js is missing; run `npm install` and `npm run build` first.');

const configPath = resolve(args.config ?? process.env.MULTI_DB_CONFIG ?? join(root, 'databases.json'));
if (!existsSync(configPath)) {
  fail(`${configPath} does not exist. Create it from databases.example.json (see README "Config reference").`);
}

// 2. .env: make sure every ${VAR} referenced by the config has a line, without printing any values.
const referenced = [...new Set([...readFileSync(configPath, 'utf8').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))];
const envPath = join(dirname(configPath), '.env');
const envValues = new Map();
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) envValues.set(m[1], m[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
}
const toAdd = referenced.filter((v) => !envValues.has(v) && process.env[v] === undefined);
if (toAdd.length) {
  if (args['dry-run']) console.log(`• would add to ${envPath}: ${toAdd.join(', ')}`);
  else {
    const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    appendFileSync(envPath, prefix + toAdd.map((v) => `${v}=`).join('\n') + '\n');
    console.log(`✔ added empty ${toAdd.join(', ')} to ${envPath}`);
  }
}
const unfilled = referenced.filter((v) => process.env[v] === undefined && !envValues.get(v));

// 3. Validate the config with the server's own loader.
const { loadConfig } = await import(pathToFileURL(join(root, 'dist', 'config.js')).href);
const config = loadConfig(configPath);
console.log(`\nDatabases in ${configPath}:`);
for (const db of config.databases.values()) {
  const kind = db.requireReplica ? 'replica only' : db.isLocal ? 'local' : 'remote, read-only';
  console.log(`  ✔ ${db.name.padEnd(16)} ${db.engine.padEnd(8)} ${db.host}${db.port ? `:${db.port}` : ''}  (${kind})`);
}
for (const b of config.broken) console.log(`  ✖ ${b.name.padEnd(16)} ${b.error}`);

// 4. Register with Claude Desktop.
function findDesktopConfig() {
  if (args['desktop-config']) return resolve(args['desktop-config']);
  const dirs = [];
  if (process.platform === 'win32') {
    dirs.push(join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude'));
    // Microsoft Store installs keep their config in a virtualized folder.
    const pkgs = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Packages');
    if (existsSync(pkgs)) {
      for (const d of readdirSync(pkgs)) if (d.startsWith('Claude_')) dirs.push(join(pkgs, d, 'LocalCache', 'Roaming', 'Claude'));
    }
  } else if (process.platform === 'darwin') {
    dirs.push(join(homedir(), 'Library', 'Application Support', 'Claude'));
  } else {
    dirs.push(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Claude'));
  }
  const files = dirs.map((d) => join(d, 'claude_desktop_config.json'));
  return files.find(existsSync) ?? files.find((f) => existsSync(dirname(f)));
}

let registered = false;
if (!args['skip-register']) {
  const desktopConfig = findDesktopConfig();
  if (!desktopConfig) {
    fail('Could not find the Claude Desktop config folder. Is Claude Desktop installed? Pass --desktop-config <path>.');
  }
  let current = {};
  if (existsSync(desktopConfig)) {
    try {
      current = JSON.parse(readFileSync(desktopConfig, 'utf8'));
    } catch (err) {
      fail(`${desktopConfig} is not valid JSON (${err.message}); fix it before registering.`);
    }
  }
  // Absolute node path so it works even when node isn't on the PATH Claude Desktop sees.
  const entry = { command: process.execPath, args: [serverEntry], env: { MULTI_DB_CONFIG: configPath } };
  console.log('');
  if (isDeepStrictEqual(current.mcpServers?.[args.name], entry)) {
    console.log(`✔ '${args.name}' is already registered in ${desktopConfig}`);
    registered = true;
  } else if (args['dry-run']) {
    console.log(`• would set mcpServers.${args.name} in ${desktopConfig} to:\n${JSON.stringify(entry, null, 2)}`);
  } else {
    if (existsSync(desktopConfig)) {
      const backup = `${desktopConfig}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      copyFileSync(desktopConfig, backup);
      console.log(`✔ backed up existing config to ${backup}`);
    }
    const next = { ...current, mcpServers: { ...current.mcpServers, [args.name]: entry } };
    writeFileSync(desktopConfig, JSON.stringify(next, null, 2) + '\n');
    console.log(`✔ registered '${args.name}' in ${desktopConfig}`);
    registered = true;
  }
}

// 5. Next steps
console.log('\nNext steps:');
let step = 1;
if (unfilled.length) console.log(`  ${step++}. Fill in ${unfilled.join(', ')} in ${envPath}`);
if (config.broken.length) console.log(`  ${step++}. Fix the entries marked ✖ above, then re-run npm run setup`);
console.log(`  ${step++}. Run \`npm run check\` to test every connection`);
if (registered) console.log(`  ${step++}. Fully quit Claude Desktop (tray / menu bar icon) and reopen it, then start a new session`);
