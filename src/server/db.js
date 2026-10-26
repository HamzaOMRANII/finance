// SQLite through Node's built-in node:sqlite (no native build needed on this box).
// One connection per process; numbered SQL files in ./migrations are applied in order.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db;

function open(file = config.dbFile) {
  if (db) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(conn) {
  conn.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(conn.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const applied = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    conn.exec('BEGIN');
    try {
      conn.exec(sql);
      conn.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
      conn.exec('COMMIT');
      applied.push(name);
    } catch (err) {
      conn.exec('ROLLBACK');
      throw new Error(`migration ${name} failed: ${err.message}`);
    }
  }
  return applied;
}

// Runs fn inside a transaction (IMMEDIATE so two processes never hand out the same number).
// Nested calls join the outer transaction.
let depth = 0;
function tx(fn) {
  const conn = open();
  if (depth > 0) return fn(conn);
  conn.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn(conn);
    conn.exec('COMMIT');
    return out;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

const all = (sql, ...p) => open().prepare(sql).all(...p);
const get = (sql, ...p) => open().prepare(sql).get(...p);
const run = (sql, ...p) => open().prepare(sql).run(...p);

// INSERT from a plain object, returns the new id.
function insert(table, row) {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return Number(run(sql, ...cols.map((c) => row[c])).lastInsertRowid);
}

// UPDATE ... SET from a plain object; bumps updated_at when the table has one.
function update(table, id, row, { touch = true } = {}) {
  const cols = Object.keys(row);
  if (!cols.length) return;
  const sets = cols.map((c) => `${c} = ?`);
  if (touch) sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, ...cols.map((c) => row[c]), id);
}

function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : fallback;
}

function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, JSON.stringify(value));
}

function close() {
  if (db) db.close();
  db = undefined;
}

module.exports = { open, migrate, tx, all, get, run, insert, update, getSetting, setSetting, close };
