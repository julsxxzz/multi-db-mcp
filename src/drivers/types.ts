export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** Rows returned by the server before truncation. */
  rowCount: number;
  truncated: boolean;
}

export interface ServerStatus {
  /** Whether the server reports itself as a replica / read-only. */
  isReplica: boolean;
  /** Human-readable evidence, e.g. "pg_is_in_recovery() = true". */
  detail: string;
  version: string;
}

export interface Driver {
  /** Connect and report replica status without enforcing it. */
  status(): Promise<ServerStatus>;
  /** Run a single read-only statement with all safety checks applied. */
  query(sql: string, params: unknown[], maxRows: number): Promise<QueryResult>;
  listTables(schema?: string): Promise<QueryResult>;
  describeTable(table: string, schema?: string): Promise<{ columns: QueryResult; indexes: QueryResult }>;
  close(): Promise<void>;
}

/** Make driver values JSON-friendly (bigint, Buffer, Date). */
export function normalizeValue(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (Buffer.isBuffer(v)) {
    const hex = v.subarray(0, 64).toString('hex');
    return v.length > 64 ? `0x${hex}… (${v.length} bytes)` : `0x${hex}`;
  }
  return v;
}

export function toResult(columns: string[], rows: unknown[][], maxRows: number): QueryResult {
  return {
    columns,
    rows: rows.slice(0, maxRows).map((r) => r.map(normalizeValue)),
    rowCount: rows.length,
    truncated: rows.length > maxRows,
  };
}
