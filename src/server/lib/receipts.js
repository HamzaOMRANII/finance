// Receipts import: text from PDFs (pdftotext), simple detection of vendor / amount / date /
// currency, and optionally Claude for scans and images (RECEIPTS_AI=true + ANTHROPIC_API_KEY).
// The result only pre-fills a bill form; nothing here writes to the database.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const config = require('../config');
const db = require('../db');
const { resolveInside, listFiles } = require('./files');
const { toMinor, CURRENCIES } = require('../../shared/money.mjs');
const D = require('../../shared/dates.mjs');

const KNOWN_VENDORS = [
  { vendor: 'Anthropic', match: /anthropic|claude\s+(pro|max|team)/i, country: 'IE' },
  { vendor: 'Contabo', match: /contabo/i, country: 'DE' },
  { vendor: 'Cloudflare', match: /cloudflare/i, country: 'US' },
  { vendor: 'Dropbox Fax', match: /dropbox|hellofax/i, country: 'US' },
  { vendor: 'Tello', match: /tello/i, country: 'US' },
  { vendor: 'Northwest Registered Agent', match: /northwest registered agent/i, country: 'US' },
];

function pdfText(full) {
  return new Promise((resolve) => {
    execFile('pdftotext', ['-layout', '-l', '5', full, '-'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      resolve(err ? '' : String(out));
    });
  });
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function findDate(text) {
  const candidates = [];
  const iso = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;
  const en = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(20\d\d)\b/gi;
  const eu = /\b(\d{1,2})[./](\d{1,2})[./](20\d\d)\b/g;
  let m;
  while ((m = iso.exec(text))) candidates.push({ i: m.index, d: D.ymd(+m[1], +m[2], +m[3]) });
  while ((m = en.exec(text))) candidates.push({ i: m.index, d: D.ymd(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]) });
  while ((m = eu.exec(text))) candidates.push({ i: m.index, d: D.ymd(+m[3], +m[2], +m[1]) });
  const valid = candidates.filter((c) => D.isDate(c.d)).sort((a, b) => a.i - b.i);
  // prefer a date right after "due" / "date of issue" / "Date:"
  const keyed = valid.find((c) => /(due|issue|date|datum)[^\n]{0,40}$/i.test(text.slice(Math.max(0, c.i - 45), c.i)));
  return (keyed || valid[0])?.d || null;
}

function findCurrency(text) {
  const counts = {
    EUR: (text.match(/€|\bEUR\b/g) || []).length,
    USD: (text.match(/\$|\bUSD\b/g) || []).length,
    VND: (text.match(/₫|\bVND\b/g) || []).length,
    TND: (text.match(/\bTND\b|\bDT\b/g) || []).length,
  };
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] ? best[0] : null;
}

// Amount on a "total"-like line: the last money figure of the strongest keyword line.
function findAmount(text) {
  const lines = text.split('\n');
  const keys = [/amount due/i, /total d[uû]/i, /cumulative gross/i, /\bgrand total\b/i, /^\s*total\b/i, /\btotal\b/i, /\bpaid:/i];
  const money = /(?:[€$₫]\s?)?-?\d{1,3}(?:[ ,.  ]\d{3})*(?:[.,]\d{1,3})?(?:\s?[€$₫])?/g;
  for (const k of keys) {
    for (const line of lines) {
      if (!k.test(line)) continue;
      const nums = (line.match(money) || []).map((s) => s.trim()).filter((s) => /\d/.test(s) && /[€$₫]|[.,]\d{2}\b/.test(s));
      if (nums.length) return nums[nums.length - 1].replace(/[€$₫\s]/g, '');
    }
  }
  return null;
}

function detect(text) {
  const known = KNOWN_VENDORS.find((v) => v.match.test(text));
  const currency = findCurrency(text);
  const amountText = findAmount(text);
  const amount = amountText && currency ? toMinor(amountText, currency) : null;
  return {
    vendor: known?.vendor || null,
    receiver_country: known?.country || null,
    currency,
    amount: Number.isFinite(amount) ? amount : null,
    date: findDate(text),
  };
}

async function claudeExtract(full) {
  const ext = path.extname(full).toLowerCase();
  const data = fs.readFileSync(full).toString('base64');
  const media = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext];
  const part = ext === '.pdf'
    ? { type: 'document', source: { type: 'base64', media_type: media, data } }
    : { type: 'image', source: { type: 'base64', media_type: media, data } };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.anthropic.model,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [part, {
          type: 'text',
          text: 'This is a bill or receipt I paid. Reply with only a JSON object: {"vendor": string, "receiver_name": string|null, "receiver_country": ISO-2|null, "amount": "total paid as a decimal string", "currency": "EUR"|"USD"|"TND"|"VND"|null, "date": "YYYY-MM-DD"|null, "title": "short description"}. Use null for anything you cannot read.',
        }],
      }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = body.content?.find((c) => c.type === 'text')?.text || '';
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const currency = CURRENCIES.includes(json.currency) ? json.currency : null;
  const amount = json.amount && currency ? toMinor(json.amount, currency) : null;
  return {
    vendor: json.vendor || null,
    receiver_name: json.receiver_name || null,
    receiver_country: /^[A-Z]{2}$/.test(json.receiver_country || '') ? json.receiver_country : null,
    title: json.title || null,
    currency,
    amount: Number.isFinite(amount) ? amount : null,
    date: D.isDate(json.date || '') ? json.date : null,
  };
}

async function extract(rel, { useAi = false } = {}) {
  const full = resolveInside(config.receiptsDir, rel);
  const isPdf = full.toLowerCase().endsWith('.pdf');
  const text = isPdf ? await pdfText(full) : '';
  const hasText = text.replace(/\s/g, '').length > 40;
  const result = { file: rel, method: 'text', text_excerpt: text.trim().slice(0, 1500), fields: hasText ? detect(text) : {} };
  if (!hasText) result.method = 'none';
  const aiAvailable = config.anthropic.enabled && !!config.anthropic.apiKey;
  result.ai_available = aiAvailable;
  if ((useAi || !hasText) && aiAvailable) {
    try {
      result.fields = { ...result.fields, ...stripNulls(await claudeExtract(full)) };
      result.method = 'claude';
    } catch (err) {
      result.ai_error = err.message;
    }
  }
  if (!hasText && result.method === 'none') {
    result.note = aiAvailable ? 'no text layer and Claude extraction failed' : 'scanned document with no text layer: fill the form by hand, or enable RECEIPTS_AI in .env';
  }
  // Suggest the existing bill for this vendor so confirming updates it instead of duplicating.
  if (result.fields.vendor) {
    const bill = db.get("SELECT id, title FROM bills WHERE lower(vendor) = lower(?) AND status != 'cancelled' ORDER BY due_date LIMIT 1", result.fields.vendor);
    if (bill) result.matching_bill = bill;
  }
  return result;
}

const stripNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

function list() {
  const linked = new Map();
  for (const b of db.all('SELECT id, vendor, receipt_file FROM bills WHERE receipt_file IS NOT NULL')) linked.set(b.receipt_file, `bill #${b.id} ${b.vendor}`);
  for (const p of db.all('SELECT bill_id, receipt_file FROM payments_log WHERE receipt_file IS NOT NULL')) linked.set(p.receipt_file, `payment of bill #${p.bill_id}`);
  return listFiles(config.receiptsDir).map((f) => ({ ...f, linked_to: linked.get(f.path) || null }));
}

module.exports = { extract, list, detect };
