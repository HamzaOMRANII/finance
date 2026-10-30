/**
 * FinTrack server: the Vite build (./dist) + the JSON API, on node:http with no framework.
 *
 * Runs under pm2, listens on localhost only, and sits behind nginx (TLS, gate, rate limit).
 * - /api/*   JSON API (session cookie + CSRF header, see src/server/auth.js)
 * - /healthz for pm2 / uptime checks
 * - anything else: static files from dist/, SPA fallback to index.html
 *
 * Env: see .env.example
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./server/config');
const db = require('./server/db');
const auth = require('./server/auth');
const api = require('./server/api');
const { sendJson, readJson, readBody, HttpError } = require('./server/http');

const ROOT = config.distDir;
const INDEX = path.join(ROOT, 'index.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Strict by default; the PDF preview iframe and receipt previews are same-origin.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "frame-src 'self' blob:",
    "object-src 'self' blob:",
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

if (!config.sessionSecret && config.production) {
  console.error('[finance] SESSION_SECRET is not set in .env');
  process.exit(1);
}

db.open();

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(INDEX)) return send(res, 503, { 'Content-Type': 'text/plain' }, 'Build missing: run "npm run build".');
  const target = path.normalize(path.join(ROOT, pathname));
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden');
  const file = pathname.endsWith('/') || !path.extname(pathname) ? INDEX : target;
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

async function handleApi(req, res, url) {
  const found = api.match(req.method, url.pathname);
  if (!found) throw new HttpError(404, 'no such endpoint');
  if (found.methodNotAllowed) throw new HttpError(405, 'method not allowed');
  const { route, params } = found;
  const session = route.opts.public ? null : auth.requireSession(req, { csrf: req.method !== 'GET' });
  // raw routes get the request bytes (file uploads), everything else JSON
  const body = req.method === 'GET' ? {} : route.opts.raw ? await readBody(req, route.opts.raw) : await readJson(req);
  const out = await route.handler({ req, res, params, query: url.searchParams, body, session });
  if (!res.headersSent && out !== undefined) sendJson(res, 200, out);
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
    decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain' }, 'Bad request');
  }

  if (url.pathname === '/healthz') return send(res, 200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, 'ok');

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      const status = err.status || (/constraint|immutable|cannot be deleted/i.test(err.message) ? 409 : 500);
      if (status >= 500) console.error('[finance]', req.method, url.pathname, err);
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? 'internal error' : err.message, fields: err.fields });
      else res.destroy();
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }, 'Method not allowed');
  serveStatic(req, res, decodeURIComponent(url.pathname));
});

server.listen(config.port, config.host, () => {
  console.log(`[finance] FinTrack on http://${config.host}:${config.port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
