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
const { HttpError } = require('./validate');
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

// Month names and abbreviations, English and French ("Oct", "Sept", "août", "déc.").
const MONTH_WORDS = [
  ['jan', 'janv'], ['feb', 'fev', 'fév', 'févr'], ['mar', 'mars'], ['apr', 'avr'], ['may', 'mai'], ['jun', 'juin'],
  ['jul', 'juil'], ['aug', 'aou', 'aoû', 'août'], ['sep', 'sept'], ['oct'], ['nov'], ['dec', 'déc'],
];
const MONTH_RE = '(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|january|february|march|april|may|june|july|august|september|october|november|december|[a-zéû]{3,5}\\.?)';

function monthNumber(word) {
  const w = word.toLowerCase().replace('.', '');
  const i = MONTH_WORDS.findIndex((alts) => alts.some((a) => w === a || (w.length > 3 && w.startsWith(a.slice(0, 3)) && w.startsWith(alts[0]))));
  return i < 0 ? 0 : i + 1;
}

// Every date in the text with its position: 2026-10-14, Oct 14, 2026, 14 Oct 2026, 10 Sept 2026, 14.10.2026, 10/04/2026 (US).
function allDates(text) {
  const out = [];
  const add = (i, y, mo, d) => { const v = D.ymd(+y, +mo, +d); if (mo && D.isDate(v)) out.push({ i, d: v }); };
  let m;
  const iso = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;
  while ((m = iso.exec(text))) add(m.index, m[1], m[2], m[3]);
  const mdy = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(20\\d\\d)\\b`, 'gi');
  while ((m = mdy.exec(text))) add(m.index, m[3], monthNumber(m[1]), m[2]);
  const dmy = new RegExp(`\\b(\\d{1,2})(?:er)?\\s+${MONTH_RE}\\s+(20\\d\\d)\\b`, 'gi');
  while ((m = dmy.exec(text))) add(m.index, m[3], monthNumber(m[2]), m[1]);
  // dotted = European (14.10.2026); slashed = US when the first part cannot be a day-first month
  const num = /\b(\d{1,2})([./])(\d{1,2})\2(20\d\d)\b/g;
  while ((m = num.exec(text))) {
    const usFirst = m[2] === '/' && +m[1] <= 12 && /\$|\bUSD\b/.test(text);
    if (usFirst) add(m.index, m[4], m[1], m[3]); else add(m.index, m[4], m[3], m[1]);
  }
  return out.sort((a, b) => a.i - b.i);
}

function findDate(text) {
  const valid = allDates(text);
  // prefer a date right after "due" / "date of issue" / "Date:"
  const keyed = valid.find((c) => /(due|issue|date|datum)[^\n]{0,40}$/i.test(text.slice(Math.max(0, c.i - 45), c.i)));
  return (keyed || valid[0])?.d || null;
}

// First date written after one of the keywords (same line or the next ~80 characters).
function dateAfter(text, keyword) {
  const re = new RegExp(keyword.source, 'gi');
  const dates = allDates(text);
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const hit = dates.find((c) => c.i >= end && c.i - end <= 80);
    if (hit) return hit.d;
  }
  return null;
}

function findCycle(text) {
  if (/\b(yearly|annual(ly)?|per year|\/\s*(year|yr)|annuel)\b/i.test(text)) return 'yearly';
  if (/\b(quarterly|per quarter|trimestriel)\b/i.test(text)) return 'quarterly';
  if (/(\/\s*mo(nth)?\b|\bper month\b|\bmonthly\b|\bmensuel|\bfor 1 month\b|\(monthly\))/i.test(text)) return 'monthly';
  return null;
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
    billing_cycle: findCycle(text),
    next_due_date: dateAfter(text, /next (credit card )?(charge|billing|payment)( date)?|renews? on|due on \(after\)|next due|prochain (prélèvement|paiement)/),
  };
}

const BILL_PROMPT = 'This is a bill or receipt I paid. Reply with only a JSON object: {"vendor": string, "receiver_name": string|null, "receiver_country": ISO-2|null, "amount": "total paid as a decimal string", "currency": "EUR"|"USD"|"TND"|"VND"|null, "date": "YYYY-MM-DD"|null, "title": "short description", "billing_cycle": "one-time"|"monthly"|"quarterly"|"yearly"|null, "next_due_date": "YYYY-MM-DD of the next charge if written"|null}. Use null for anything you cannot read.';

async function claudeJson(full, prompt, maxTokens = 400) {
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
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [part, {
          type: 'text',
          text: prompt,
        }],
      }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = body.content?.find((c) => c.type === 'text')?.text || '';
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

async function claudeExtract(full) {
  const json = await claudeJson(full, BILL_PROMPT);
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
    billing_cycle: D.CYCLE_MONTHS[json.billing_cycle] !== undefined ? json.billing_cycle : null,
    next_due_date: D.isDate(json.next_due_date || '') ? json.next_due_date : null,
  };
}

async function extract(rel, { useAi = false } = {}) {
  return extractFile(resolveInside(config.receiptsDir, rel), rel, { useAi });
}

async function extractFile(full, rel, { useAi = false } = {}) {
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

// ------------------------------------------------------------------ upload / delete

const MAX_UPLOAD = 2 * 1024 * 1024; // nginx accepts 2 MB bodies for this site

// Stores an uploaded file in the receipts folder (by year) under a safe, unused name.
function save(name, buffer) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (!['.pdf', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new HttpError(400, 'only PDF, PNG, JPG or WEBP files');
  if (!buffer.length) throw new HttpError(400, 'empty file');
  if (ext === '.pdf' && buffer.subarray(0, 5).toString() !== '%PDF-') throw new HttpError(400, 'this is not a PDF file');
  const base = path.basename(String(name), path.extname(String(name))).replace(/[^\w.\- ()]/g, '_').slice(0, 80) || 'receipt';
  const dir = path.join(config.receiptsDir, D.today().slice(0, 4));
  fs.mkdirSync(dir, { recursive: true });
  let file = `${base}${ext}`;
  for (let n = 2; fs.existsSync(path.join(dir, file)); n++) file = `${base} (${n})${ext}`;
  fs.writeFileSync(path.join(dir, file), buffer, { flag: 'wx' });
  return path.relative(config.receiptsDir, path.join(dir, file)).split(path.sep).join('/');
}

function linkOf(rel) {
  const bill = db.get('SELECT id, vendor FROM bills WHERE receipt_file = ?', rel);
  if (bill) return `bill #${bill.id} ${bill.vendor}`;
  const pay = db.get('SELECT bill_id FROM payments_log WHERE receipt_file = ?', rel);
  return pay ? `a payment of bill #${pay.bill_id}` : null;
}

// Receipts linked to a bill or a payment are proof of payment: they cannot be deleted.
// Deleted files go to the hidden .deleted folder (kept, not listed), never straight to nothing.
function remove(rel) {
  const full = resolveInside(config.receiptsDir, rel);
  const link = linkOf(rel);
  if (link) throw new HttpError(409, `this receipt is linked to ${link}; remove it there first`);
  const bin = path.join(config.receiptsDir, '.deleted');
  fs.mkdirSync(bin, { recursive: true });
  fs.renameSync(full, path.join(bin, `${new Date().toISOString().replace(/[:.]/g, '-')}_${path.basename(full)}`));
}

// ------------------------------------------------------------------ outgoing invoice analysis

const INVOICE_PROMPT = 'This is an invoice I issued to a client. Reply with only a JSON object: {"invoice_number": string|null, "client_name": string|null, "issuer_name": string|null, "language": "FR"|"EN", "currency": "EUR"|"USD"|"TND"|"VND"|null, "issue_date": "YYYY-MM-DD"|null, "due_date": "YYYY-MM-DD"|null, "service_period_start": "YYYY-MM-DD"|null, "service_period_end": "YYYY-MM-DD"|null, "line_items": [{"description": string, "detail": string|null, "quantity": number, "unit_price": "decimal string"}], "total": "decimal string"|null}. Use null for anything you cannot read.';

const FR_WORDS = /\b(facture|montant|échéance|prestations|période|désignation|TVA)\b/i;

// Lines of a table "description … qty  unit price  amount", plus the indented lines under it as detail.
function findLineItems(text, currency) {
  const money = '(-?\\d{1,3}(?:[ \\u00a0\\u202f.,]\\d{3})*(?:[.,]\\d{1,2})?)\\s?[€$₫]?';
  const row = new RegExp(`^\\s*(\\S.*?\\S)\\s{2,}(?:.*?\\s{2,})?(\\d+(?:[.,]\\d+)?)\\s{2,}[€$]?\\s?${money}\\s{2,}[€$]?\\s?${money}\\s*$`);
  const lines = text.split('\n');
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = row.exec(lines[i]);
    if (!m || /total|sous-total|subtotal|tva|vat/i.test(m[1])) continue;
    const unit = toMinor(m[3], currency || 'EUR');
    if (!Number.isFinite(unit)) continue;
    const detail = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() && !row.test(lines[j]) && detail.length < 8; j++) detail.push(lines[j].trim());
    items.push({ description: m[1].replace(/\s{2,}.*$/, ''), detail: detail.join(' ') || undefined, quantity: Number(m[2].replace(',', '.')), unit_price: unit });
  }
  return items;
}

function findPeriod(text) {
  // "01–31 août 2026" / "1-31 October 2026"
  const m = new RegExp(`\\b(\\d{1,2})\\s*[–-]\\s*(\\d{1,2})\\s+${MONTH_RE}\\s+(20\\d\\d)`, 'i').exec(text);
  if (m) {
    const mo = monthNumber(m[3]);
    const a = D.ymd(+m[4], mo, +m[1]);
    const b = D.ymd(+m[4], mo, +m[2]);
    if (mo && D.isDate(a) && D.isDate(b)) return { start: a, end: b };
  }
  const start = dateAfter(text, /(période|period)[^\n]{0,30}?(du|from)?/);
  const end = start ? dateAfter(text.slice(text.search(/(période|period)/i) + 20), /\b(au|to|–|-)\b/) : null;
  return start ? { start, end } : null;
}

// Reads an invoice I issued (PDF or image) to pre-fill the invoice editor. Nothing is stored.
async function analyseInvoice(full, { useAi = false } = {}) {
  const isPdf = full.toLowerCase().endsWith('.pdf');
  const text = isPdf ? await pdfText(full) : '';
  const hasText = text.replace(/\s/g, '').length > 40;
  const aiAvailable = config.anthropic.enabled && !!config.anthropic.apiKey;
  const out = { method: hasText ? 'text' : 'none', ai_available: aiAvailable, fields: {} };
  if (hasText) {
    const currency = findCurrency(text);
    const totalText = findAmount(text);
    const period = findPeriod(text);
    out.fields = stripNulls({
      invoice_number: (text.match(/\b(?:INV|HOLLC|FA|FACT|INVOICE)[-_/]?\d{2,4}(?:[-_/]\d{1,4}){0,3}\b/i) || [])[0] || null,
      language: FR_WORDS.test(text) ? 'FR' : 'EN',
      currency,
      issue_date: dateAfter(text, /(date de (la )?facture|invoice date|date of issue|issued?( on)?|date)\s*:?/) || findDate(text),
      due_date: dateAfter(text, /(échéance|due date|payment due|due on|à payer avant)[^\n]{0,30}?:?/),
      service_period_start: period?.start || null,
      service_period_end: period?.end || null,
      total: totalText && currency ? toMinor(totalText, currency) : null,
      line_items: findLineItems(text, currency),
    });
    out.text = text;
  }
  if ((useAi || !hasText) && aiAvailable) {
    try {
      const j = await claudeJson(full, INVOICE_PROMPT, 1500);
      const currency = CURRENCIES.includes(j.currency) ? j.currency : out.fields.currency || 'EUR';
      out.fields = {
        ...out.fields,
        ...stripNulls({
          invoice_number: j.invoice_number, client_name: j.client_name, issuer_name: j.issuer_name,
          language: ['FR', 'EN'].includes(j.language) ? j.language : null, currency,
          issue_date: D.isDate(j.issue_date || '') ? j.issue_date : null,
          due_date: D.isDate(j.due_date || '') ? j.due_date : null,
          service_period_start: D.isDate(j.service_period_start || '') ? j.service_period_start : null,
          service_period_end: D.isDate(j.service_period_end || '') ? j.service_period_end : null,
          total: j.total ? toMinor(j.total, currency) : null,
        }),
        line_items: Array.isArray(j.line_items) && j.line_items.length
          ? j.line_items.map((it) => ({ description: String(it.description || ''), detail: it.detail || undefined, quantity: Number(it.quantity) || 1, unit_price: toMinor(String(it.unit_price ?? '0'), currency) || 0 }))
          : out.fields.line_items || [],
      };
      out.method = 'claude';
    } catch (err) {
      out.ai_error = err.message;
    }
  }
  if (out.method === 'none') out.note = aiAvailable ? 'no text layer and Claude extraction failed' : 'scanned document with no text layer: fill the invoice by hand, or enable RECEIPTS_AI in .env';
  // match the client and the issuer by name in the document
  const hay = `${out.fields.client_name || ''}\n${out.fields.issuer_name || ''}\n${out.text || ''}`.toLowerCase();
  const client = db.all('SELECT id, company_name FROM clients').find((c) => c.company_name && hay.includes(c.company_name.toLowerCase()));
  const issuer = db.all('SELECT id, legal_name, prefix FROM issuer_profiles').sort((a, b) => b.legal_name.length - a.legal_name.length)
    .find((i) => hay.includes(i.legal_name.toLowerCase()));
  if (client) out.fields.client_id = client.id;
  const n = out.fields.invoice_number;
  if (n && db.get('SELECT 1 FROM outgoing_invoices WHERE invoice_number = ? OR requested_number = ? UNION ALL SELECT 1 FROM credit_notes WHERE credit_number = ?', n, n, n)) out.number_taken = true;
  if (issuer) out.fields.issuer_profile_id = issuer.id;
  delete out.text;
  return out;
}

module.exports = { extract, extractFile, list, detect, save, remove, analyseInvoice, MAX_UPLOAD };
