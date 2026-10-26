// Small declarative validation: each entity lists its fields once, and clean() turns an
// untrusted JSON body into a row for the database or throws a 400 with per-field messages.
const { CURRENCIES, toMinor } = require('../../shared/money.mjs');
const { isDate } = require('../../shared/dates.mjs');

class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
const COUNTRY = /^[A-Z]{2}$/;

function asList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(/[\s,;]+/);
  return [];
}

const types = {
  text(v, f) {
    const s = String(v).trim();
    if (f.max && s.length > f.max) throw `at most ${f.max} characters`;
    return s;
  },
  int(v, f) {
    const n = Number(v);
    if (!Number.isInteger(n)) throw 'must be a whole number';
    if (f.min !== undefined && n < f.min) throw `must be ≥ ${f.min}`;
    if (f.max !== undefined && n > f.max) throw `must be ≤ ${f.max}`;
    return n;
  },
  bool(v) {
    return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
  },
  date(v) {
    if (!isDate(v)) throw 'must be a date (YYYY-MM-DD)';
    return v;
  },
  enum(v, f) {
    if (!f.values.includes(v)) throw `must be one of ${f.values.join(', ')}`;
    return v;
  },
  currency(v) {
    if (!CURRENCIES.includes(v)) throw `must be one of ${CURRENCIES.join(', ')}`;
    return v;
  },
  country(v) {
    const c = String(v).trim().toUpperCase();
    if (!COUNTRY.test(c)) throw 'must be a 2-letter country code';
    return c;
  },
  countries(v) {
    const list = asList(v).map((c) => String(c).trim()).filter(Boolean);
    if (!list.length) return JSON.stringify(['worldwide']);
    const out = list.map((c) => (c.toLowerCase() === 'worldwide' ? 'worldwide' : c.toUpperCase()));
    for (const c of out) if (c !== 'worldwide' && !COUNTRY.test(c)) throw `"${c}" is not a 2-letter country code`;
    return JSON.stringify([...new Set(out)]);
  },
  emails(v) {
    const list = asList(v).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
    for (const e of list) if (!EMAIL.test(e)) throw `"${e}" is not a valid email`;
    return JSON.stringify([...new Set(list)]);
  },
  email(v) {
    const e = String(v).trim().toLowerCase();
    if (!EMAIL.test(e)) throw 'is not a valid email';
    return e;
  },
  // Amount typed as a decimal ("1627,50") stored as minor units of the row's currency.
  money(v, f, body) {
    const minor = toMinor(v, body[f.currencyField || 'currency'] || 'EUR');
    if (Number.isNaN(minor)) throw 'must be an amount like 1627.50';
    if (minor !== null && f.min !== undefined && minor < f.min) throw 'must not be negative';
    return minor;
  },
};

// spec: { field: { type, required, ...options } }. partial = PATCH semantics (only given keys).
function clean(spec, body, { partial = false } = {}) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'expected a JSON object');
  const row = {};
  const errors = {};
  for (const [name, f] of Object.entries(spec)) {
    const present = Object.prototype.hasOwnProperty.call(body, name);
    if (partial && !present) continue;
    const v = body[name];
    if (f.type === 'bool' && (v === undefined || v === null || v === '')) {
      if (!partial || present) row[name] = f.default ?? 0;
      continue;
    }
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (empty && f.type !== 'bool' && f.type !== 'countries' && f.type !== 'emails') {
      if (f.required) errors[name] = 'is required';
      else if (present || !partial) row[name] = f.default !== undefined ? f.default : null;
      continue;
    }
    try {
      row[name] = types[f.type](v, f, body);
    } catch (msg) {
      if (typeof msg !== 'string') throw msg;
      errors[name] = msg;
    }
  }
  if (Object.keys(errors).length) {
    const first = Object.entries(errors)[0];
    throw new HttpError(400, `${first[0]} ${first[1]}`, errors);
  }
  return row;
}

module.exports = { clean, HttpError, EMAIL };
