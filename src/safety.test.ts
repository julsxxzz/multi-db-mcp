import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertReadOnlyStatement, isLocalHost } from './safety.js';

test('isLocalHost accepts only loopback literals', () => {
  for (const h of ['localhost', 'LOCALHOST', 'db.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ['10.0.0.5', '192.168.1.10', 'prod.example.com', 'localhost.example.com', 'my-localhost', '0.0.0.0', '128.0.0.1']) {
    assert.equal(isLocalHost(h), false, h);
  }
});

test('read statements are allowed', () => {
  for (const sql of [
    'SELECT 1',
    '  select * from t',
    '(SELECT 1) UNION (SELECT 2)',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    '-- comment\nSELECT 1',
    '/* c */ SELECT 1',
    '# mysql comment\nSHOW TABLES',
    'EXPLAIN SELECT 1',
    'DESCRIBE users',
  ]) {
    assert.doesNotThrow(() => assertReadOnlyStatement(sql), sql);
  }
});

test('write and session statements are rejected', () => {
  for (const sql of [
    'DELETE FROM users',
    'update users set x = 1',
    'DROP TABLE users',
    'INSERT INTO t VALUES (1)',
    'SET SESSION transaction_read_only = OFF',
    'COMMIT',
    '/* SELECT */ DELETE FROM t',
    '-- SELECT\nTRUNCATE t',
    '/*!50000 DROP TABLE t */ SELECT 1',
    "SELECT * FROM t INTO OUTFILE '/tmp/x'",
    '',
    '   ',
  ]) {
    assert.throws(() => assertReadOnlyStatement(sql), undefined, sql);
  }
});
