import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const hash = (token) => createHash('sha256').update(token).digest('hex');

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      demo INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deadlines (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      course TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS unique_deadline
      ON deadlines (owner, date, course, title, kind, COALESCE(time, ''));
    CREATE INDEX IF NOT EXISTS owner_deadlines ON deadlines (owner, date, time);
  `);

  const addSession = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)');
  const getSession = db.prepare('SELECT subject, email, name, demo FROM sessions WHERE token_hash = ? AND expires_at > ?');
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const expireSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const listDeadlines = db.prepare(`
    SELECT id, course, title, kind, date, time
    FROM deadlines
    WHERE owner = ?
    ORDER BY date, time IS NULL, time, course, title, id
  `);
  const insertDeadline = db.prepare('INSERT INTO deadlines VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');

  return {
    startSession(user) {
      const token = randomBytes(32).toString('base64url');
      const now = Date.now();
      expireSessions.run(now);
      addSession.run(hash(token), user.subject, user.email, user.name, Number(user.demo), now + sessionLifetime);
      return token;
    },
    getUser(token) {
      return token ? getSession.get(hash(token), Date.now()) ?? null : null;
    },
    endSession(token) {
      if (token) deleteSession.run(hash(token));
    },
    listDeadlines(owner) {
      return listDeadlines.all(owner);
    },
    saveDeadlines(owner, items) {
      db.exec('BEGIN IMMEDIATE');
      try {
        let added = 0;
        for (const { course, title, kind, date, time } of items) {
          added += insertDeadline.run(randomUUID(), owner, course, title, kind, date, time).changes;
        }
        db.exec('COMMIT');
        return added;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}
