// Runtime configuration: .env (gitignored) + process.env, with paths resolved once.
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // no .env: rely on the real environment
}

const env = process.env;
const abs = (p, fallback) => path.resolve(ROOT, p || fallback);

module.exports = {
  ROOT,
  port: Number(env.PORT) || 17000,
  host: env.HOST || '127.0.0.1',
  publicUrl: (env.PUBLIC_URL || 'https://finance.omranisystems.com').replace(/\/$/, ''),
  production: env.NODE_ENV === 'production',

  dbFile: abs(env.DB_FILE, 'data/fintrack.db'),
  receiptsDir: abs(env.RECEIPTS_DIR, 'data/receipts'),
  issuedDir: abs(env.ISSUED_DIR, 'data/issued-invoices'),
  backupDir: abs(env.BACKUP_DIR, '/root/backups/finance'),
  logsDir: abs(env.LOGS_DIR, 'automation/logs'),
  distDir: path.join(ROOT, 'dist'),
  assetsDir: path.join(ROOT, 'assets'),
  // The owner's French invoice template, used as-is (see src/server/lib/docx.js).
  invoiceTemplateFr: abs(env.INVOICE_TEMPLATE_FR, 'data/issued-invoices/template/Modele_Facture_FR.docx'),
  soffice: env.SOFFICE_BIN || 'soffice',

  sessionSecret: env.SESSION_SECRET || '',
  sessionDays: Number(env.SESSION_DAYS) || 7,

  ownerEmail: env.OWNER_EMAIL || '',
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 465,
    secure: env.SMTP_SECURE !== 'false',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
  },

  anthropic: {
    enabled: env.RECEIPTS_AI === 'true',
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  },
};
