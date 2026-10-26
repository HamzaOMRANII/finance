// Calendar helpers. Every date in the app is a plain 'YYYY-MM-DD' string in the business
// timezone (Africa/Lagos, UTC+1, no DST), so there is no time-of-day arithmetic anywhere.

export const TIMEZONE = 'Africa/Lagos';

const pad = (n) => String(n).padStart(2, '0');

export function ymd(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function parse(date) {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parse(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

// Today in the business timezone.
export function today(timeZone = TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(date, n) {
  const { y, m, d } = parse(date);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

// Adds months and clamps to the month's length. `anchorDay` keeps a bill due on the 31st
// on the last day of short months without drifting to the 28th forever after February.
export function addMonths(date, n, anchorDay) {
  const { y, m, d } = parse(date);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return ymd(ny, nm, Math.min(anchorDay || d, daysInMonth(ny, nm)));
}

export function diffDays(from, to) {
  const a = parse(from);
  const b = parse(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

// 0 = Sunday ... 6 = Saturday
export function weekday(date) {
  const { y, m, d } = parse(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWeekend(date) {
  const w = weekday(date);
  return w === 0 || w === 6;
}

export function monthStart(date) {
  const { y, m } = parse(date);
  return ymd(y, m, 1);
}

export function monthEnd(date) {
  const { y, m } = parse(date);
  return ymd(y, m, daysInMonth(y, m));
}

export function isLastDayOfMonth(date) {
  return date === monthEnd(date);
}

// Last Monday-Friday of the month that contains `date`.
export function lastBusinessDay(date) {
  let d = monthEnd(date);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

// Months per billing cycle; one-time bills never repeat.
export const CYCLE_MONTHS = { 'one-time': 0, monthly: 1, quarterly: 3, yearly: 12 };

export function nextOccurrence(date, cycle, anchorDay) {
  const months = CYCLE_MONTHS[cycle];
  return months ? addMonths(date, months, anchorDay) : null;
}

const MONTHS = {
  EN: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  FR: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};

export function monthName(m, lang = 'EN') {
  return (MONTHS[lang] || MONTHS.EN)[m - 1];
}

// "26 October 2026" / "26 octobre 2026"
export function formatDate(date, lang = 'EN') {
  if (!date) return '—';
  const { y, m, d } = parse(date);
  return `${d} ${monthName(m, lang)} ${y}`;
}
