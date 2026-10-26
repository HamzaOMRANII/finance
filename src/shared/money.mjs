// Money helpers shared by the server, the automations and the React client.
// Amounts are stored as integers in minor units (cents, millimes, dong) so sums never drift.

export const CURRENCIES = ['EUR', 'USD', 'TND', 'VND'];

// Number of decimals of each currency's minor unit.
export const DECIMALS = { EUR: 2, USD: 2, TND: 3, VND: 0 };

export const SYMBOLS = { EUR: '€', USD: '$', TND: 'DT', VND: '₫' };

export function decimalsOf(currency) {
  return DECIMALS[currency] ?? 2;
}

// "1 627,50" / "1627.5" / 1627.5 -> 162750 (EUR). Returns null for empty input, NaN for junk.
export function toMinor(value, currency) {
  if (value === null || value === undefined || value === '') return null;
  let s = String(value).trim().replace(/[\s  ]/g, '');
  // "1.627,50" or "1627,50": the last comma is the decimal separator
  if (s.includes(',') && (!s.includes('.') || s.lastIndexOf(',') > s.lastIndexOf('.'))) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  const d = decimalsOf(currency);
  const [int, frac = ''] = s.replace('-', '').split('.');
  const minor = Number(int) * 10 ** d + Number((frac + '0'.repeat(d)).slice(0, d) || 0);
  return s.startsWith('-') ? -minor : minor;
}

export function fromMinor(minor, currency) {
  if (minor === null || minor === undefined) return null;
  return minor / 10 ** decimalsOf(currency);
}

// Display format. lang 'FR' gives "1 627,00 €", 'EN' gives "€1,627.00".
export function formatMoney(minor, currency, lang = 'EN') {
  if (minor === null || minor === undefined) return '—';
  const locale = lang === 'FR' ? 'fr-FR' : 'en-US';
  const d = decimalsOf(currency);
  const text = new Intl.NumberFormat(locale, {
    style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d,
  }).format(minor / 10 ** d);
  // Intl uses narrow no-break spaces in fr-FR; pdf fonts and plain text are happier with a normal one.
  return text.replace(/[  ]/g, ' ');
}

// Quantity (may be fractional: 12.5 days) x unit price (minor) -> line amount (minor), rounded half up.
export function lineAmount(quantity, unitPriceMinor) {
  return Math.round(Number(quantity || 0) * Number(unitPriceMinor || 0));
}

// rates: { EUR: 1, USD: 0.92, ... } = how many EUR one unit of the currency is worth.
// Returns the EUR amount in EUR minor units (cents), or null when the rate is unknown.
export function toEurMinor(minor, currency, rates) {
  if (minor === null || minor === undefined) return null;
  if (currency === 'EUR') return minor;
  const rate = Number(rates?.[currency]);
  if (!rate) return null;
  return Math.round(fromMinor(minor, currency) * rate * 100);
}
