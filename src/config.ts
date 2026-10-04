import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { isLocalHost } from './safety.js';

const sslSchema = z.union([
  z.boolean(),
  z.object({
    rejectUnauthorized: z.boolean().optional(),
    /** Path to a CA bundle (e.g. the AWS RDS global bundle), relative to the config file. */
    caFile: z.string().optional(),
  }),
]);

const databaseSchema = z.object({
  engine: z.enum(['mysql', 'postgres']),
  description: z.string().optional(),
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  user: z.string().min(1),
  password: z.string().optional(),
  database: z.string().optional(),
  ssl: sslSchema.optional(),
  /**
   * Force the replica check even for a localhost host. Use this for SSH tunnels / port
   * forwards to remote servers, which look like localhost but are not.
   */
  requireReplica: z.boolean().optional(),
  maxRows: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const configSchema = z.object({
  defaults: z
    .object({
      maxRows: z.number().int().positive().default(200),
      timeoutMs: z.number().int().positive().default(15_000),
    })
    .default({ maxRows: 200, timeoutMs: 15_000 }),
  databases: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), z.unknown()),
});

export type RawDatabaseConfig = z.infer<typeof databaseSchema>;

export interface DatabaseConfig extends Omit<RawDatabaseConfig, 'ssl' | 'requireReplica' | 'maxRows' | 'timeoutMs'> {
  name: string;
  isLocal: boolean;
  requireReplica: boolean;
  maxRows: number;
  timeoutMs: number;
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string };
}

/** A database entry that could not be loaded; kept so list_databases can explain why. */
export interface BrokenDatabase {
  name: string;
  error: string;
}

export interface LoadedConfig {
  path: string;
  databases: Map<string, DatabaseConfig>;
  broken: BrokenDatabase[];
}

/** Replace ${VAR} with process.env.VAR in every string; throws if a variable is unset. */
function interpolate(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`environment variable ${name} is not set`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)]));
  }
  return value;
}

function parseDatabase(
  name: string,
  raw: unknown,
  defaults: { maxRows: number; timeoutMs: number },
  configDir: string,
): DatabaseConfig {
  const parsed = databaseSchema.strict().parse(interpolate(raw));
  const isLocal = isLocalHost(parsed.host);
  if (!isLocal && parsed.requireReplica === false) {
    throw new Error(`requireReplica cannot be disabled for non-local host '${parsed.host}'`);
  }

  let ssl: DatabaseConfig['ssl'];
  if (typeof parsed.ssl === 'object') {
    ssl = {
      rejectUnauthorized: parsed.ssl.rejectUnauthorized ?? true,
      ca: parsed.ssl.caFile ? readFileSync(resolve(configDir, parsed.ssl.caFile), 'utf8') : undefined,
    };
  } else {
    ssl = parsed.ssl;
  }

  return {
    ...parsed,
    name,
    isLocal,
    requireReplica: parsed.requireReplica ?? !isLocal,
    maxRows: parsed.maxRows ?? defaults.maxRows,
    timeoutMs: parsed.timeoutMs ?? defaults.timeoutMs,
    ssl,
  };
}

export function loadConfig(path: string): LoadedConfig {
  const configPath = resolve(path);
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath} (set MULTI_DB_CONFIG or copy databases.example.json)`);
  }
  const configDir = dirname(configPath);

  // Secrets can live in a .env next to the config; variables already set (e.g. by the MCP client) win.
  const envPath = resolve(configDir, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const config = configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  const databases = new Map<string, DatabaseConfig>();
  const broken: BrokenDatabase[] = [];

  // One bad entry (e.g. a missing password variable) shouldn't take down the others.
  for (const [name, raw] of Object.entries(config.databases)) {
    try {
      databases.set(name, parseDatabase(name, raw, config.defaults, configDir));
    } catch (err) {
      const message = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
      broken.push({ name, error: message });
    }
  }

  return { path: configPath, databases, broken };
}
