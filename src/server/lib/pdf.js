// Branded invoice / credit note PDF (pdfkit, fonts embedded). Same family as the web app:
// navy header band with the omranisystems mark, Sora headings, Inter text, JetBrains Mono figures,
// petrol and gold accents. The page itself stays white so it prints well.
const path = require('node:path');
const PDFDocument = require('pdfkit');
const fontkit = require('fontkit');
const config = require('../config');
const { formatMoney } = require('../../shared/money.mjs');
const D = require('../../shared/dates.mjs');

const C = {
  navy950: '#050B14',
  navy900: '#0A1524',
  navy700: '#1A3350',
  petrol: '#1C6E7A',
  petrolBright: '#2FD1D9',
  gold: '#C9A24D',
  ink: '#0A1524',
  muted: '#4F6377',
  dim: '#7C8FA2',
  line: '#D7E0E8',
  zebra: '#F4F7FA',
  danger: '#EF4444',
};

const FONT_DIR = path.join(config.assetsDir, 'fonts');
const FONTS = {
  sora: 'Sora-SemiBold.ttf',
  soraBold: 'Sora-Bold.ttf',
  soraLight: 'Sora-Light.ttf',
  inter: 'Inter-Regular.ttf',
  interMed: 'Inter-Medium.ttf',
  interSemi: 'Inter-SemiBold.ttf',
  interBold: 'Inter-Bold.ttf',
  mono: 'JetBrainsMono-Regular.ttf',
  monoMed: 'JetBrainsMono-Medium.ttf',
};

// Sora has no Vietnamese glyphs; user-provided text falls back to Inter when needed.
const soraCheck = fontkit.openSync(path.join(FONT_DIR, FONTS.soraBold));
const soraCovers = (s) => [...String(s)].every((ch) => ch.trim() === '' || soraCheck.hasGlyphForCodePoint(ch.codePointAt(0)));

const L = {
  FR: {
    invoice: 'FACTURE', credit_note: 'AVOIR', draft: 'BROUILLON',
    number: 'Numéro', date: 'Date d’émission', due: 'Échéance', on_receipt: 'Dès réception', currency: 'Devise',
    period: 'Période de service', from: 'Émetteur — prestataire', to: 'Destinataire — client',
    tax_id: 'N° fiscal', vat: 'N° de TVA', reg: 'SIREN / SIRET', email: 'E-mail', phone: 'Téléphone',
    description: 'Description', qty: 'Qté', unit_price: 'Prix unitaire', amount: 'Montant',
    subtotal: 'Sous-total', total: 'Total dû', total_cn: 'Total crédité',
    payment: 'Informations de paiement', beneficiary: 'Bénéficiaire', bank: 'Banque', iban: 'IBAN', swift: 'SWIFT / BIC',
    account: 'Numéro de compte', bank_address: 'Adresse du bénéficiaire', bank_currency: 'Devise de réception',
    reference: 'Référence de paiement', instructions: 'Modalités de paiement', legal: 'Mentions légales', note: 'Note',
    original: 'Facture d’origine', reason: 'Motif', page: 'Page',
  },
  EN: {
    invoice: 'INVOICE', credit_note: 'CREDIT NOTE', draft: 'DRAFT',
    number: 'Number', date: 'Issue date', due: 'Due date', on_receipt: 'Due on receipt', currency: 'Currency',
    period: 'Service period', from: 'From — provider', to: 'Bill to — client',
    tax_id: 'Tax ID / EIN', vat: 'VAT number', reg: 'Company number', email: 'Email', phone: 'Phone',
    description: 'Description', qty: 'Qty', unit_price: 'Unit price', amount: 'Amount',
    subtotal: 'Subtotal', total: 'Total due', total_cn: 'Total credited',
    payment: 'Payment details', beneficiary: 'Beneficiary', bank: 'Bank', iban: 'IBAN', swift: 'SWIFT / BIC',
    account: 'Account number', bank_address: 'Beneficiary address', bank_currency: 'Receiving currency',
    reference: 'Payment reference', instructions: 'Payment instructions', legal: 'Legal mentions', note: 'Note',
    original: 'Original invoice', reason: 'Reason', page: 'Page',
  },
};

const PAGE = { w: 595.28, h: 841.89, m: 48 };
const BOTTOM = PAGE.h - 58;

// The omranisystems mark (same geometry as the web Logo), drawn on the navy band. The mask of
// the SVG version is reproduced by painting the cut-outs in the band colour.
function drawMark(doc, x, y, size) {
  const s = size / 124;
  doc.save().translate(x - 4 * s, y - 4 * s).scale(s);
  doc.circle(60, 60, 46).lineWidth(9).strokeColor('#FFFFFF').stroke();
  doc.path('M116 32H52Q40 32 40 44V48Q40 60 52 60H68Q80 60 80 72V76Q80 88 68 88H4').lineWidth(21).strokeColor(C.navy900).stroke();
  doc.circle(100, 100, 21.5).fillColor(C.navy900).fill();
  doc.path('M102 32H52Q40 32 40 44V48Q40 60 52 60H68Q80 60 80 72V76Q80 88 68 88H18').lineWidth(11).strokeColor(C.petrolBright).stroke();
  doc.circle(100, 100, 19).fillColor(C.gold).fill();
  doc.path('M88 108L96 100L102 105L112 93M105 93H112V100').lineWidth(3.5).lineCap('round').lineJoin('round').strokeColor(C.navy900).stroke();
  doc.restore();
}

function renderInvoicePdf(v) {
  const lang = v.language === 'FR' ? 'FR' : 'EN';
  const t = L[lang];
  const money = (minor) => formatMoney(minor, v.currency, lang);
  const isCredit = v.kind === 'credit_note';

  const doc = new PDFDocument({
    size: 'A4', margin: PAGE.m, bufferPages: true,
    info: {
      Title: `${isCredit ? t.credit_note : t.invoice} ${v.number || t.draft}`,
      Author: v.issuer.legal_name,
      Creator: 'FinTrack — finance.omranisystems.com',
    },
  });
  for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, path.join(FONT_DIR, file));
  const head = (s, bold = true) => (soraCovers(s) ? (bold ? 'soraBold' : 'sora') : 'interBold');

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const W = PAGE.w - PAGE.m * 2;
  let y = 0;
  const ensure = (h) => {
    if (y + h > BOTTOM) {
      doc.addPage();
      y = PAGE.m;
    }
  };

  // ---------- header band
  doc.rect(0, 0, PAGE.w, 118).fill(C.navy900);
  doc.rect(0, 118, PAGE.w, 3).fill(C.petrol);
  doc.rect(0, 118, 120, 3).fill(C.gold);
  drawMark(doc, PAGE.m, 30, 58);
  const nameX = PAGE.m + 74;
  doc.font(head(v.issuer.legal_name)).fontSize(19).fillColor('#FFFFFF')
    .text(v.issuer.legal_name, nameX, 36, { width: 270, lineBreak: false, ellipsis: true });
  if (v.issuer.title_line) {
    doc.font('inter').fontSize(8.5).fillColor('#90A5B9').text(v.issuer.title_line.toUpperCase(), nameX, 62, { width: 260, characterSpacing: 0.8 });
  }
  doc.font('mono').fontSize(8).fillColor('#5C7186').text('finance.omranisystems.com', nameX, 86);

  const title = isCredit ? t.credit_note : t.invoice;
  doc.font('soraBold').fontSize(24).fillColor('#FFFFFF').text(title, PAGE.m, 34, { width: W, align: 'right' });
  doc.font('monoMed').fontSize(11).fillColor(v.draft ? C.gold : C.petrolBright)
    .text(v.number || t.draft, PAGE.m, 66, { width: W, align: 'right' });

  if (v.draft) {
    doc.save().rotate(-30, { origin: [PAGE.w / 2, PAGE.h / 2] });
    doc.font('soraBold').fontSize(80).fillColor(C.gold).fillOpacity(0.08)
      .text(t.draft, -100, PAGE.h / 2 - 50, { width: PAGE.w + 200, align: 'center', lineBreak: false });
    doc.restore().fillOpacity(1);
  }

  // ---------- key facts row
  y = 138;
  const facts = [
    [t.number, v.number || '—'],
    [t.date, D.formatDate(v.issue_date, lang)],
    isCredit
      ? [t.original, v.original_number || '—']
      : [t.due, v.payment_terms_days === 0 ? t.on_receipt : D.formatDate(v.due_date, lang)],
    [t.currency, v.currency],
  ];
  const fw = W / facts.length;
  facts.forEach(([k, val], i) => {
    const x = PAGE.m + i * fw;
    doc.font('interSemi').fontSize(7).fillColor(C.dim).text(k.toUpperCase(), x, y, { width: fw - 8, characterSpacing: 0.8 });
    doc.font(i === 0 || (isCredit && i === 2) ? 'monoMed' : 'interSemi').fontSize(10.5).fillColor(C.ink).text(val, x, y + 12, { width: fw - 8 });
  });
  y += 36;
  if (v.service_period_start && v.service_period_end) {
    doc.font('interSemi').fontSize(7).fillColor(C.dim).text(t.period.toUpperCase(), PAGE.m, y, { characterSpacing: 0.8 });
    doc.font('inter').fontSize(10).fillColor(C.ink)
      .text(`${D.formatDate(v.service_period_start, lang)} – ${D.formatDate(v.service_period_end, lang)}`, PAGE.m, y + 12);
    y += 28;
  }
  if (isCredit) {
    doc.font('interSemi').fontSize(7).fillColor(C.dim).text(t.reason.toUpperCase(), PAGE.m, y, { characterSpacing: 0.8 });
    doc.font('inter').fontSize(10).fillColor(C.ink).text(v.reason, PAGE.m, y + 12, { width: W });
    y = doc.y + 12;
  }

  // ---------- parties
  y += 6;
  const colW = (W - 24) / 2;
  const party = (x, label, name, lines) => {
    doc.rect(x, y, colW, 2).fill(C.petrol);
    doc.font('interSemi').fontSize(7).fillColor(C.petrol).text(label.toUpperCase(), x, y + 9, { characterSpacing: 0.9 });
    doc.font(head(name)).fontSize(12).fillColor(C.ink).text(name, x, y + 22, { width: colW });
    let py = doc.y + 3;
    for (const [k, val] of lines) {
      if (!val) continue;
      if (k) {
        doc.font('inter').fontSize(8.5).fillColor(C.dim).text(`${k} `, x, py, { continued: true })
          .fillColor(C.ink).text(val, { width: colW });
      } else {
        doc.font('inter').fontSize(9).fillColor(C.ink).text(val, x, py, { width: colW });
      }
      py = doc.y + 2;
    }
    return py;
  };
  const is = v.issuer;
  const cl = v.client;
  const y1 = party(PAGE.m, t.from, is.legal_name, [
    ['', is.address], ['', countryName(is.country, lang)], [t.tax_id, is.tax_id], [t.email, is.email], [t.phone, is.phone],
  ]);
  const y2 = party(PAGE.m + colW + 24, t.to, cl.company_name, [
    ['', cl.contact_name], ['', cl.address], ['', countryName(cl.country, lang)],
    [t.reg, cl.registration_id], [t.vat, cl.vat_number], [t.phone, cl.phone],
  ]);
  y = Math.max(y1, y2) + 14;

  // ---------- line items table
  const cols = [
    { key: 'description', label: t.description, w: W - 70 - 95 - 95, align: 'left' },
    { key: 'qty', label: t.qty, w: 70, align: 'right' },
    { key: 'unit_price', label: t.unit_price, w: 95, align: 'right' },
    { key: 'amount', label: t.amount, w: 95, align: 'right' },
  ];
  const tableHeader = () => {
    doc.rect(PAGE.m, y, W, 22).fill(C.navy900);
    let x = PAGE.m;
    for (const c of cols) {
      doc.font('interSemi').fontSize(7.5).fillColor('#FFFFFF')
        .text(c.label.toUpperCase(), x + 8, y + 7.5, { width: c.w - 16, align: c.align, characterSpacing: 0.7 });
      x += c.w;
    }
    y += 22;
  };
  ensure(60);
  tableHeader();
  v.line_items.forEach((it, i) => {
    const descW = cols[0].w - 16;
    doc.font('interMed').fontSize(9.5);
    const hDesc = doc.heightOfString(it.description, { width: descW });
    doc.font('inter').fontSize(8);
    const hDetail = it.detail ? doc.heightOfString(it.detail, { width: descW }) + 3 : 0;
    const rowH = Math.max(26, hDesc + hDetail + 16);
    if (y + rowH > BOTTOM) {
      doc.addPage();
      y = PAGE.m;
      tableHeader();
    }
    if (i % 2 === 1) doc.rect(PAGE.m, y, W, rowH).fill(C.zebra);
    doc.font('interMed').fontSize(9.5).fillColor(C.ink).text(it.description, PAGE.m + 8, y + 8, { width: descW });
    if (it.detail) doc.font('inter').fontSize(8).fillColor(C.muted).text(it.detail, PAGE.m + 8, doc.y + 3, { width: descW });
    const qty = `${fmtQty(it.quantity, lang)}${it.unit ? ` ${it.unit}` : ''}`;
    let x = PAGE.m + cols[0].w;
    for (const [c, val] of [[cols[1], qty], [cols[2], money(it.unit_price)], [cols[3], money(it.amount)]]) {
      doc.font('mono').fontSize(9).fillColor(C.ink).text(val, x + 8, y + 8.5, { width: c.w - 16, align: 'right' });
      x += c.w;
    }
    y += rowH;
    doc.moveTo(PAGE.m, y).lineTo(PAGE.m + W, y).lineWidth(0.6).strokeColor(C.line).stroke();
  });

  // ---------- totals
  y += 12;
  const tw = 230;
  const tx = PAGE.m + W - tw;
  ensure(40 + 18 * (v.tax_lines.length + 1));
  const totalRow = (label, val, opts = {}) => {
    doc.font(opts.bold ? 'interSemi' : 'inter').fontSize(opts.bold ? 10 : 9).fillColor(opts.color || C.muted)
      .text(label, tx + 10, y + (opts.pad || 0), { width: 120 });
    doc.font(opts.bold ? 'monoMed' : 'mono').fontSize(opts.bold ? 11 : 9).fillColor(opts.color || C.ink)
      .text(val, tx + 110, y + (opts.pad || 0), { width: tw - 120, align: 'right' });
    y += opts.h || 18;
  };
  totalRow(t.subtotal, money(v.subtotal));
  for (const tl of v.tax_lines) totalRow(`${tl.label} (${fmtQty(tl.rate, lang)} %)`, money(tl.amount));
  y += 4;
  doc.rect(tx, y, tw, 32).fill(C.navy900);
  doc.rect(tx, y, 3, 32).fill(C.gold);
  doc.font('soraBold').fontSize(10).fillColor('#FFFFFF').text((isCredit ? t.total_cn : t.total).toUpperCase(), tx + 14, y + 11, { width: 110, characterSpacing: 0.6 });
  doc.font('monoMed').fontSize(13).fillColor(C.petrolBright).text(money(v.total), tx + 110, y + 9, { width: tw - 122, align: 'right' });
  y += 40;

  // ---------- text blocks
  const block = (label, text, accent = C.petrol) => {
    if (!text || !String(text).trim()) return;
    doc.font('inter').fontSize(8.5);
    const h = doc.heightOfString(text, { width: W - 14 }) + 22;
    ensure(Math.min(h, 200));
    doc.rect(PAGE.m, y, 2, Math.min(h - 6, BOTTOM - y)).fill(accent);
    doc.font('interSemi').fontSize(7).fillColor(accent).text(label.toUpperCase(), PAGE.m + 12, y, { characterSpacing: 0.9 });
    doc.font('inter').fontSize(8.5).fillColor(C.muted).text(text, PAGE.m + 12, y + 12, { width: W - 14 });
    y = doc.y + 10;
  };

  if (!isCredit) {
    const bank = [
      [t.beneficiary, is.bank_beneficiary], [t.bank, is.bank_name], [t.iban, is.bank_iban], [t.swift, is.bank_swift],
      [t.account, is.bank_account], [t.bank_address, is.bank_address], [t.bank_currency, is.bank_currency],
      [t.reference, v.number || t.draft],
    ].filter(([, val]) => val);
    if (bank.length > 1) {
      ensure(24 + bank.length * 14);
      doc.rect(PAGE.m, y, W, 2).fill(C.gold);
      doc.font('interSemi').fontSize(7).fillColor(C.gold).text(t.payment.toUpperCase(), PAGE.m, y + 9, { characterSpacing: 0.9 });
      y += 24;
      for (const [k, val] of bank) {
        doc.font('inter').fontSize(8.5).fillColor(C.dim).text(k, PAGE.m, y, { width: 130 });
        doc.font(/IBAN|SWIFT|compte|Account|Référence|reference/i.test(k) ? 'mono' : 'inter').fontSize(8.5).fillColor(C.ink)
          .text(val, PAGE.m + 135, y, { width: W - 135 });
        y = Math.max(y + 12, doc.y + 1);
      }
      if (is.bank_extra) {
        doc.font('inter').fontSize(8).fillColor(C.muted).text(is.bank_extra, PAGE.m + 135, y, { width: W - 135 });
        y = doc.y + 2;
      }
      y += 8;
    }
    block(t.instructions, is.payment_note, C.gold);
  }
  block(t.legal, v.legal_mentions);
  block(t.note, v.invoice_note);
  block('', is.footer_text, C.dim);

  // ---------- footer on every page
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // writing below the margin would otherwise open a new page
    const fy = PAGE.h - 44;
    doc.moveTo(PAGE.m, fy).lineTo(PAGE.m + W, fy).lineWidth(0.6).strokeColor(C.line).stroke();
    const left = [is.legal_name, is.email, is.phone].filter(Boolean).join('  ·  ');
    doc.font('inter').fontSize(7.5).fillColor(C.dim).text(left, PAGE.m, fy + 8, { width: W - 80, lineBreak: false, ellipsis: true });
    doc.font('mono').fontSize(7.5).fillColor(C.dim)
      .text(`${v.number || t.draft} · ${t.page} ${i + 1}/${range.count}`, PAGE.m, fy + 8, { width: W, align: 'right', lineBreak: false });
  }

  doc.end();
  return done;
}

function fmtQty(n, lang) {
  return new Intl.NumberFormat(lang === 'FR' ? 'fr-FR' : 'en-US', { maximumFractionDigits: 3 }).format(Number(n)).replace(/[  ]/g, ' ');
}

function countryName(code, lang) {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([lang === 'FR' ? 'fr' : 'en'], { type: 'region' }).of(code);
  } catch {
    return code;
  }
}

module.exports = { renderInvoicePdf, drawMark, BRAND: C };
