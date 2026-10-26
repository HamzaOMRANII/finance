// French invoices from the owner's Word template (data/issued-invoices/template/Modele_Facture_FR.docx).
// The template is a filled-in example invoice, used as-is: this module never edits the file. It
// loads a copy and swaps the values, paragraph by paragraph, keeping each paragraph's formatting:
// a value is found as the paragraph that follows its label ("Numéro de facture :" -> next text),
// the line-item row is cloned once per line, and the payment / note paragraphs are matched by their
// opening words. Everything else (layout, colours, logo, signature) comes untouched from the file.
const fs = require('node:fs');
const JSZip = require('jszip');
const config = require('../config');
const { formatMoney } = require('../../shared/money.mjs');
const D = require('../../shared/dates.mjs');

function templateAvailable() {
  return fs.existsSync(config.invoiceTemplateFr);
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const textOf = (xml) => unesc((xml.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(''));

// Puts `value` in the paragraph's first text run and empties the others, so the first run's
// formatting (font, size, colour, bold) carries the new value.
function setParagraph(p, value) {
  let first = true;
  return p.replace(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g, () => {
    if (!first) return '<w:t></w:t>';
    first = false;
    return `<w:t xml:space="preserve">${esc(value)}</w:t>`;
  });
}

// Splits xml into an array of chunks where every <w:p>…</w:p> is its own element.
function splitParagraphs(xml) {
  const parts = [];
  const re = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let last = 0;
  let m;
  while ((m = re.exec(xml))) {
    parts.push({ xml: xml.slice(last, m.index) });
    parts.push({ xml: m[0], p: true, text: textOf(m[0]) });
    last = m.index + m[0].length;
  }
  parts.push({ xml: xml.slice(last) });
  return parts;
}

const FR_COUNTRY = { VN: 'Vietnam', FR: 'France', US: 'États-Unis', TN: 'Tunisie', DE: 'Allemagne', IE: 'Irlande', MY: 'Malaisie', CN: 'Chine' };
function country(code) {
  if (!code) return '';
  if (FR_COUNTRY[code]) return FR_COUNTRY[code];
  try { return new Intl.DisplayNames(['fr'], { type: 'region' }).of(code); } catch { return code; }
}
const oneLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const qty = (n) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(Number(n)).replace(/[  ]/g, ' ');
// The template's own money style: "1 627,00 €" with no-break spaces.
const eur = (minor, currency) => formatMoney(minor, currency, 'FR').replace(/ /g, ' ');

function periodText(v) {
  const a = v.service_period_start;
  const b = v.service_period_end;
  if (!a || !b) return '';
  const pa = D.parse(a);
  const pb = D.parse(b);
  if (pa.y === pb.y && pa.m === pb.m) return `${String(pa.d).padStart(2, '0')}–${pb.d} ${D.monthName(pb.m, 'FR')} ${pb.y}`;
  return `${D.formatDate(a, 'FR')} – ${D.formatDate(b, 'FR')}`;
}

function monthLabel(v) {
  const end = v.service_period_end || v.issue_date;
  if (!end) return '';
  const s = v.service_period_start && D.parse(v.service_period_start);
  const e = D.parse(end);
  if (s && (s.y !== e.y || s.m !== e.m)) return `${cap(D.monthName(s.m, 'FR'))} – ${D.monthName(e.m, 'FR')} ${e.y}`;
  return `${cap(D.monthName(e.m, 'FR'))} ${e.y}`;
}

// Values keyed by label; arrays are used in order for labels that appear more than once.
function labelValues(v) {
  const is = v.issuer;
  const cl = v.client;
  const number = v.number;
  return {
    'Numéro de facture :': [number],
    'Échéance de paiement :': [v.payment_terms_days === 0 ? 'Dès réception' : D.formatDate(v.due_date, 'FR')],
    'Date de facture :': [D.formatDate(v.issue_date, 'FR')],
    'Devise :': [v.currency],
    'Période de service :': [periodText(v)],
    'Nom légal complet :': [is.legal_name],
    'Adresse :': [oneLine(is.address), oneLine(cl.address)],
    'Pays :': [country(is.country), country(cl.country)],
    'E-mail :': [is.email],
    'Raison sociale :': [cl.company_name],
    'SIREN/SIRET :': [cl.registration_id],
    'N° de TVA :': [cl.vat_number],
    'Contact :': [cl.phone || cl.contact_name],
    'Sous-total :': [eur(v.subtotal, v.currency)],
    'TOTAL DÛ': [eur(v.total, v.currency)],
    'Bénéficiaire :': [is.bank_beneficiary],
    'Banque :': [is.bank_name],
    'SWIFT / BIC :': [is.bank_swift],
    'Numéro de compte :': [is.bank_account || is.bank_iban],
    'Adresse du bénéficiaire :': [is.bank_address],
    'Devise de réception :': [is.bank_currency],
    'Référence de paiement :': [number],
    'Banque correspondante :': [cap(String(is.bank_extra || '').replace(/^Banque correspondante\s*:\s*/i, ''))],
  };
}

// Clones the line-item row of the "Prestations" table once per line.
function fillItems(xml, v) {
  const firstCell = xml.indexOf('Services de développement');
  const anchor = firstCell >= 0 ? firstCell : xml.indexOf('Prix unitaire');
  if (anchor < 0) throw new Error('template: line-item table not found');
  let start = xml.lastIndexOf('<w:tr ', anchor);
  let end = xml.indexOf('</w:tr>', anchor) + 7;
  if (firstCell < 0) { // anchor was the header row: the item row is the next one
    start = end;
    end = xml.indexOf('</w:tr>', start) + 7;
  }
  const row = xml.slice(start, end);
  const rows = v.line_items.map((it) => {
    // the template row's minimum height fits description + detail; a one-line item does not need it
    const parts = splitParagraphs(it.detail ? row : row.replace(/<w:trHeight [^>]*\/>/, ''));
    let i = 0;
    const values = [it.description, it.detail || '', monthLabel(v), `${qty(it.quantity)}${it.unit ? ` ${it.unit}` : ''}`, eur(it.unit_price, v.currency), eur(it.amount, v.currency)];
    return parts.map((part) => {
      if (!part.p || !part.text.trim()) return part.xml;
      const value = values[i++];
      if (i === 2 && !value) return ''; // no detail line: drop the italic paragraph
      return setParagraph(part.xml, value ?? '');
    }).join('');
  });
  return xml.slice(0, start) + rows.join('') + xml.slice(end);
}

// The "TVA :" row: tax lines when there are any, else the client's legal mention, else removed.
function fillTax(xml, v) {
  const at = xml.indexOf('>TVA :<');
  if (at < 0) return xml;
  const start = xml.lastIndexOf('<w:tr ', at);
  const end = xml.indexOf('</w:tr>', at) + 7;
  const row = xml.slice(start, end);
  const taxes = v.tax_lines || [];
  if (!taxes.length && !v.legal_mentions) return xml.slice(0, start) + xml.slice(end);
  const rows = (taxes.length ? taxes : [null]).map((t) => {
    const parts = splitParagraphs(row);
    let i = 0;
    return parts.map((part) => {
      if (!part.p || !part.text.trim()) return part.xml;
      i++;
      if (i === 1) return t ? setParagraph(part.xml, `${t.label} (${qty(t.rate)} %) :`) : part.xml;
      return setParagraph(part.xml, t ? eur(t.amount, v.currency) : oneLine(v.legal_mentions));
    }).join('');
  });
  return xml.slice(0, start) + rows.join('') + xml.slice(end);
}

function fillDocument(xml, v) {
  xml = fillTax(fillItems(xml, v), v);
  const values = labelValues(v);
  const used = {};
  const parts = splitParagraphs(xml);
  const paras = parts.filter((p) => p.p);
  let pending = null;
  let headerName = false;
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    const t = p.text.trim();
    if (!t) continue;
    if (pending) { // this paragraph is the value of the previous label
      p.xml = setParagraph(p.xml, pending.value);
      pending = null;
      continue;
    }
    if (values[t]) {
      const n = used[t] = (used[t] || 0) + 1;
      const list = values[t];
      if (n <= list.length) pending = { value: list[n - 1] ?? '' };
      continue;
    }
    if (!headerName && i === 0) { // first paragraph: issuer name in the header
      p.xml = setParagraph(p.xml, v.issuer.legal_name);
      headerName = true;
    } else if (t.startsWith('Le paiement peut') && v.issuer.payment_note) {
      p.xml = setParagraph(p.xml, oneLine(v.issuer.payment_note));
    } else if (t.startsWith('Cette facture concerne') || (paras[i - 1] && paras[i - 1].text.trim() === 'Note comptable')) {
      p.xml = v.invoice_note ? setParagraph(p.xml, oneLine(v.invoice_note)) : setParagraph(p.xml, '');
    }
  }
  // Signature block at the end: name ... phone.
  const tail = paras.filter((p) => p.text.trim()).slice(-3);
  if (tail.length === 3 && /^\+?[\d\s()-]{6,}$/.test(tail[2].text.trim())) {
    tail[0].xml = setParagraph(tail[0].xml, v.issuer.legal_name);
    if (v.issuer.phone) tail[2].xml = setParagraph(tail[2].xml, v.issuer.phone);
  }
  return parts.map((p) => p.xml).join('');
}

// Returns the filled .docx as a Buffer.
async function fillTemplate(view) {
  const zip = await JSZip.loadAsync(fs.readFileSync(config.invoiceTemplateFr));
  const xml = await zip.file('word/document.xml').async('string');
  zip.file('word/document.xml', fillDocument(xml, view));
  const title = `Facture ${view.number}`;
  const core = zip.file('docProps/core.xml');
  if (core) {
    const c = await core.async('string');
    zip.file('docProps/core.xml', c.replace(/<dc:title>[^<]*<\/dc:title>/, `<dc:title>${esc(title)}</dc:title>`));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { fillTemplate, templateAvailable, fillDocument };
