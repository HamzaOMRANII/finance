// .docx -> .pdf with headless LibreOffice (apt: libreoffice-writer-nogui + fonts-crosextra-carlito,
// Carlito being metric-compatible with the template's Calibri). Conversions run one at a time:
// LibreOffice cannot share a profile between concurrent processes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const config = require('../config');

const PROFILE = path.join(config.ROOT, 'data', '.cache', 'lo-profile');
let queue = Promise.resolve();

function run(docx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fintrack-docx-'));
  const input = path.join(dir, 'invoice.docx');
  fs.writeFileSync(input, docx);
  return new Promise((resolve, reject) => {
    execFile(config.soffice, [
      `-env:UserInstallation=file://${PROFILE}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, input,
    ], { timeout: 90_000 }, (err, stdout, stderr) => {
      const out = path.join(dir, 'invoice.pdf');
      try {
        if (err || !fs.existsSync(out)) throw new Error(`LibreOffice conversion failed: ${err?.message || stderr || stdout}`);
        resolve(fs.readFileSync(out));
      } catch (e) {
        reject(e);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

function docxToPdf(docx) {
  const job = queue.then(() => run(docx));
  queue = job.catch(() => {});
  return job;
}

module.exports = { docxToPdf };
