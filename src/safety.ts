/**
 * Safety rules shared by every driver.
 *
 * Layers, from strongest to weakest:
 *   1. Non-local databases must report themselves as a replica / read-only server.
 *      This is verified on the same connection, right before every statement,
 *      so a failover that promotes the replica to primary is caught immediately.
 *   2. Every statement runs inside a READ ONLY transaction that is always rolled back.
 *   3. A lexical allowlist on the statement's first keyword (convenience, not a guarantee).
 */

export class NotReplicaError extends Error {
  constructor(database: string, host: string, isLocal: boolean, detail: string) {
    const why = isLocal ? 'it is configured with requireReplica' : `host '${host}' is not localhost`;
    super(
      `Refusing to query '${database}': ${why}, so it must be a read replica, ` +
        `but the server reports it is writable (${detail}). Point this entry at a replica endpoint.`,
    );
    this.name = 'NotReplicaError';
  }
}

export class ForbiddenStatementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenStatementError';
  }
}

/**
 * True only when the host literally refers to this machine. Hostnames are NOT resolved:
 * an unknown name is treated as remote, so mistakes fail towards requiring a replica.
 */
export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    /^127(\.\d{1,3}){3}$/.test(h) ||
    h === '::1' ||
    h === '0:0:0:0:0:0:0:1'
  );
}

const ALLOWED_FIRST_KEYWORDS = new Set(['select', 'with', 'show', 'explain', 'describe', 'desc', 'values', 'table']);

/** Skip leading whitespace, comments and opening parentheses to find the first keyword. */
function firstKeyword(sql: string): string | undefined {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(/^[\s(]+/, '');
    if (s.startsWith('/*!') || s.startsWith('/*+')) {
      // MySQL executable comments / optimizer hints run as code; don't skip over them.
      throw new ForbiddenStatementError('Statements starting with MySQL executable comments (/*! ... */) are not allowed.');
    }
    if (s.startsWith('--') || s.startsWith('#')) s = s.replace(/^(--|#)[^\n]*(\n|$)/, '');
    else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2);
    }
    if (s === before) break;
  }
  return /^[a-z]+/i.exec(s)?.[0]?.toLowerCase();
}

export function assertReadOnlyStatement(sql: string): void {
  const kw = firstKeyword(sql);
  if (!kw) throw new ForbiddenStatementError('Empty statement.');
  if (!ALLOWED_FIRST_KEYWORDS.has(kw)) {
    throw new ForbiddenStatementError(
      `Only read statements are allowed (${[...ALLOWED_FIRST_KEYWORDS].join(', ').toUpperCase()}); got '${kw.toUpperCase()}'.`,
    );
  }
  if (/\binto\s+(outfile|dumpfile)\b/i.test(sql)) {
    throw new ForbiddenStatementError('SELECT ... INTO OUTFILE/DUMPFILE is not allowed.');
  }
}
