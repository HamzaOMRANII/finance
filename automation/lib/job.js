// Shared harness for the automation scripts:
//   --dry-run        print what would happen; no emails, no invoice numbers, no data changes
//                    (only the job_runs bookkeeping row is written)
//   --date YYYY-MM-DD pretend today is that day (Africa/Lagos), for testing and catch-up
//   --force          skip the script's own date guard (e.g. "last day of month")
// Each run is appended to automation/logs/<job>-YYYY-MM.log and recorded in job_runs.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const config = require('../../src/server/config');
const db = require('../../src/server/db');
const D = require('../../src/shared/dates.mjs');

function parseArgs(argv) {
  const args = { dryRun: false, force: false, date: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--date') args.date = argv[++i];
    else if (argv[i].startsWith('--date=')) args.date = argv[i].slice(7);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (args.date && !D.isDate(args.date)) throw new Error('--date must be YYYY-MM-DD');
  return args;
}

async function runJob(name, fn) {
  const args = parseArgs(process.argv.slice(2));
  const today = args.date || D.today();
  fs.mkdirSync(config.logsDir, { recursive: true });
  const logFile = path.join(config.logsDir, `${name}-${today.slice(0, 7)}.log`);
  const lines = [];
  const log = (...a) => {
    const line = util.format(...a);
    lines.push(line);
    console.log(line);
  };
  log(`\n=== ${name} ${new Date().toISOString()} today=${today}${args.dryRun ? ' DRY-RUN' : ''}${args.force ? ' FORCE' : ''}`);

  db.open();
  const runId = db.insert('job_runs', { job: name, run_date: today, dry_run: args.dryRun ? 1 : 0 });
  let ok = 1;
  let summary = '';
  try {
    summary = (await fn({ ...args, today, log })) || '';
    log(`--- done: ${summary}`);
  } catch (err) {
    ok = 0;
    summary = err.message;
    log(`!!! failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    db.run("UPDATE job_runs SET ok = ?, summary = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", ok, String(summary).slice(0, 500), runId);
    fs.appendFileSync(logFile, `${lines.join('\n')}\n`);
  }
}

module.exports = { runJob };
