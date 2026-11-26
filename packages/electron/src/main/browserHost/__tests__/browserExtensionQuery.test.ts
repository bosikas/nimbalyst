// @vitest-environment node
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { scopeBrowserExtensionQuery } from '../browserExtensionQuery';

it('binds session data and extension CTEs to the authorized workspace', () => {
  const sql = 'WITH bounds(session_id) AS (VALUES ($1)) SELECT m.id FROM ai_agent_messages m NOT INDEXED JOIN bounds b ON b.session_id = m.session_id';
  const result = scopeBrowserExtensionQuery(sql, ['session'], '/workspace', 'sqlite');
  expect(result.params).toEqual(['session', '/workspace']);
  expect(result.sql).toContain('FROM main.ai_sessions WHERE workspace_id = $2');
  expect(result.sql).toContain('FROM main.ai_agent_messages WHERE session_id IN (SELECT id FROM ai_sessions)');
  expect(result.sql).toContain(sql.slice(5));
});

it('cannot return another workspace through joins, CTEs or UNION branches', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE ai_sessions(id TEXT, workspace_id TEXT);
      CREATE TABLE ai_agent_messages(id TEXT, session_id TEXT);
      INSERT INTO ai_sessions VALUES ('mine', '/workspace'), ('theirs', '/other');
      INSERT INTO ai_agent_messages VALUES ('mine-message', 'mine'), ('theirs-message', 'theirs');
    `);
    const query = scopeBrowserExtensionQuery(`
      WITH selected AS (SELECT id FROM ai_sessions)
      SELECT id FROM selected UNION SELECT m.id FROM ai_agent_messages m NOT INDEXED
      JOIN ai_sessions s ON s.id = m.session_id ORDER BY id
    `, [], '/workspace', 'sqlite');
    const rows = db.prepare(query.sql).all({ 1: query.params[0] }) as Array<{ id: string }>;
    expect(rows.map(({ id }) => id)).toEqual(['mine', 'mine-message']);
  } finally {
    db.close();
  }
});

it.each([
  'SELECT * FROM main.ai_sessions',
  'SELECT * FROM ai_sessions, private_settings',
  'SELECT * FROM (private_settings)',
  'SELECT * FROM ai_sessions UNION SELECT * FROM sqlite_master',
  'SELECT id FROM ai_sessions UNION TABLE private_settings',
  'SELECT pg_read_file(\'/etc/passwd\') FROM ai_sessions',
  'WITH private_settings AS (SELECT * FROM private_settings) SELECT * FROM private_settings',
  'SELECT * FROM ai_sessions WHERE id IN (WITH private_settings AS (SELECT 1) SELECT * FROM private_settings)',
  'SELECT s.id FROM ai_sessions s JOIN (SELECT 1 AS window) a ON a.window = 1, private_settings p',
  'SELECT * FROM ai_sessions; SELECT * FROM private_settings',
])('rejects queries that can escape the workspace projection (%s)', (sql) => {
  expect(() => scopeBrowserExtensionQuery(sql, [], '/workspace', 'sqlite')).toThrow('Unsupported browser extension query');
});
