// Nightly backup: a consistent SQLite snapshot + receipts + issued invoices, as one
// tar.gz in BACKUP_DIR. Keeps the 14 newest archives. The only files this script ever deletes
// are its own old archives in BACKUP_DIR; issued invoices are never touched.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { backup } = require('node:sqlite');
const config = require('../src/server/config');
const db = require('../src/server/db');
const { runJob } = require('./lib/job');

const KEEP = 14;
const NAME = /^fintrack-\d{8}-\d{4,6}\.tar\.gz$/;

runJob('backup', async ({ dryRun, log }) => {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const archive = path.join(config.backupDir, `fintrack-${stamp}.tar.gz`);
  const list = () => (fs.existsSync(config.backupDir) ? fs.readdirSync(config.backupDir).filter((f) => NAME.test(f)).sort() : []);
  const existing = list();
  const prune = existing.slice(0, Math.max(0, existing.length + 1 - KEEP));

  if (dryRun) {
    log(`[dry-run] would write ${archive} (db + ${path.relative(config.ROOT, config.receiptsDir)} + ${path.relative(config.ROOT, config.issuedDir)})`);
    log(`[dry-run] ${existing.length} archive(s) present; would delete ${prune.length}: ${prune.join(', ') || 'none'}`);
    return 'dry run';
  }

  fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  const work = fs.mkdtempSync(path.join(config.backupDir, '.work-'));
  try {
    await backup(db.open(), path.join(work, 'fintrack.db'));
    execFileSync('tar', [
      '-czf', archive,
      '-C', work, 'fintrack.db',
      '-C', path.dirname(config.receiptsDir), path.basename(config.receiptsDir),
      '-C', path.dirname(config.issuedDir), path.basename(config.issuedDir),
    ]);
    fs.chmodSync(archive, 0o600);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const size = (fs.statSync(archive).size / 1024).toFixed(0);
  log(`wrote ${archive} (${size} KB)`);
  const after = list();
  for (const f of after.slice(0, Math.max(0, after.length - KEEP))) {
    fs.unlinkSync(path.join(config.backupDir, f));
    log(`deleted old archive ${f}`);
  }
  return `${path.basename(archive)} ${size} KB, kept ${Math.min(after.length, KEEP)}`;
});
