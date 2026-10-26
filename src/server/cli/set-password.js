// npm run set-password -- [username] [password]
// Creates the single user or resets its password. Without a password, a random one is printed once.
const crypto = require('node:crypto');
const db = require('../db');
const { hashPassword } = require('../auth');

const username = process.argv[2] || 'admin';
const password = process.argv[3] || crypto.randomBytes(12).toString('base64url');
if (password.length < 12) {
  console.error('password must be at least 12 characters');
  process.exit(1);
}

db.open();
const existing = db.get('SELECT id FROM users WHERE username = ?', username);
if (existing) {
  db.update('users', existing.id, { password_hash: hashPassword(password) });
  db.run('DELETE FROM sessions WHERE user_id = ?', existing.id);
} else {
  if (db.get('SELECT COUNT(*) AS n FROM users').n) {
    console.error('FinTrack is single-user and a user already exists; pass its username to reset the password.');
    process.exit(1);
  }
  db.insert('users', { username, password_hash: hashPassword(password) });
}
console.log(`user: ${username}`);
if (!process.argv[3]) console.log(`password: ${password}`);
