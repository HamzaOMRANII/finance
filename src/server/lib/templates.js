// Email subjects and bodies. Client-facing ones follow the client's language (FR / EN);
// notifications to the owner are in English. Plain text only: it renders everywhere.
const config = require('../config');
const { formatMoney } = require('../../shared/money.mjs');
const D = require('../../shared/dates.mjs');

function invoiceEmail(v) {
  const amount = formatMoney(v.total, v.currency, v.language);
  const contact = v.client.contact_name;
  if (v.language === 'FR') {
    const due = v.payment_terms_days === 0 ? 'à réception' : `au plus tard le ${D.formatDate(v.due_date, 'FR')}`;
    return {
      subject: `Facture ${v.number} — ${v.issuer.legal_name}`,
      text: [
        contact ? `Bonjour ${contact},` : 'Bonjour,',
        '',
        `Veuillez trouver ci-joint la facture ${v.number} d’un montant de ${amount}${periodText(v, 'FR')}.`,
        `Le règlement est attendu ${due}, en indiquant ${v.number} comme référence de paiement.`,
        '',
        'Je reste à votre disposition pour toute question.',
        '',
        'Cordialement,',
        v.issuer.legal_name,
        v.issuer.phone || '',
      ].join('\n').trim(),
    };
  }
  const due = v.payment_terms_days === 0 ? 'upon receipt' : `by ${D.formatDate(v.due_date, 'EN')}`;
  return {
    subject: `Invoice ${v.number} — ${v.issuer.legal_name}`,
    text: [
      contact ? `Hello ${contact},` : 'Hello,',
      '',
      `Please find attached invoice ${v.number} for ${amount}${periodText(v, 'EN')}.`,
      `Payment is due ${due}; please use ${v.number} as the payment reference.`,
      '',
      'Let me know if you have any questions.',
      '',
      'Best regards,',
      v.issuer.legal_name,
      v.issuer.phone || '',
    ].join('\n').trim(),
  };
}

function periodText(v, lang) {
  if (!v.service_period_start || !v.service_period_end) return '';
  const a = D.formatDate(v.service_period_start, lang);
  const b = D.formatDate(v.service_period_end, lang);
  return lang === 'FR' ? `, pour la période du ${a} au ${b}` : `, covering ${a} to ${b}`;
}

function clientReminderEmail(v, daysLate) {
  const outstanding = formatMoney(v.total - (v.amount_received || 0), v.currency, v.language);
  if (v.language === 'FR') {
    return {
      subject: `Rappel : facture ${v.number}`,
      text: [
        v.client.contact_name ? `Bonjour ${v.client.contact_name},` : 'Bonjour,',
        '',
        `Sauf erreur de ma part, la facture ${v.number} du ${D.formatDate(v.issue_date, 'FR')} (${outstanding}) reste en attente de règlement, ${daysLate} jours après son échéance.`,
        'Si le paiement a déjà été effectué, merci de ne pas tenir compte de ce message.',
        '',
        'Cordialement,',
        v.issuer.legal_name,
      ].join('\n'),
    };
  }
  return {
    subject: `Reminder: invoice ${v.number}`,
    text: [
      v.client.contact_name ? `Hello ${v.client.contact_name},` : 'Hello,',
      '',
      `A friendly reminder that invoice ${v.number} dated ${D.formatDate(v.issue_date, 'EN')} (${outstanding}) is still open, ${daysLate} days after its due date.`,
      'If you have already paid, please disregard this message.',
      '',
      'Best regards,',
      v.issuer.legal_name,
    ].join('\n'),
  };
}

const link = (p) => `${config.publicUrl}${p}`;

module.exports = { invoiceEmail, clientReminderEmail, link };
