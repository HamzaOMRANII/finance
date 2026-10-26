// One entry point for invoice documents. French invoices use the owner's Word template (PDF
// converted from the filled .docx); English invoices and credit notes use the pdfkit layout.
const { renderInvoicePdf } = require('./pdf');
const docx = require('./docx');
const { docxToPdf } = require('./convert');

const usesTemplate = (view) => view.kind === 'invoice' && view.language === 'FR' && docx.templateAvailable();

// -> { pdf: Buffer, docx: Buffer | null }
async function renderInvoice(view) {
  if (!usesTemplate(view)) return { pdf: await renderInvoicePdf(view), docx: null };
  const file = await docx.fillTemplate(view);
  return { pdf: await docxToPdf(file), docx: file };
}

module.exports = { renderInvoice, usesTemplate };
