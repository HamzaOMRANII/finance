// Safe access to the receipts and issued-invoices folders. Paths from the client are always
// relative; they are resolved, symlinks included, and must stay inside their folder.
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./validate');

const TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function resolveInside(baseDir, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new HttpError(400, 'bad path');
  const base = fs.realpathSync(baseDir);
  const candidate = path.resolve(base, rel);
  if (!candidate.startsWith(base + path.sep)) throw new HttpError(404, 'not found');
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new HttpError(404, 'not found');
  }
  if (!real.startsWith(base + path.sep)) throw new HttpError(404, 'not found');
  if (!TYPES[path.extname(real).toLowerCase()]) throw new HttpError(404, 'not found');
  if (!fs.statSync(real).isFile()) throw new HttpError(404, 'not found');
  return real;
}

// Streams a file with headers that keep it private and stop the browser from sniffing types.
function serveFile(res, full, { download = false, name } = {}) {
  const type = TYPES[path.extname(full).toLowerCase()];
  const filename = (name || path.basename(full)).replace(/[^\w.\- ()]/g, '_');
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': fs.statSync(full).size,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
  });
  fs.createReadStream(full).pipe(res);
}

function listFiles(baseDir) {
  const out = [];
  if (!fs.existsSync(baseDir)) return out;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && TYPES[path.extname(e.name).toLowerCase()]) {
        const st = fs.statSync(full);
        out.push({ path: path.relative(baseDir, full).split(path.sep).join('/'), size: st.size, modified: st.mtime.toISOString() });
      }
    }
  };
  walk(baseDir, 0);
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

module.exports = { resolveInside, serveFile, listFiles, TYPES };
