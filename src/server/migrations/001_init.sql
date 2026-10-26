-- FinTrack schema v1.
-- Money columns are INTEGER minor units (see src/shared/money.mjs). Dates are 'YYYY-MM-DD'
-- strings in Africa/Lagos; timestamps are ISO-8601 UTC strings. JSON columns hold arrays/objects.

-- ---------------------------------------------------------------- app plumbing
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                                  -- JSON
);

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                         -- scrypt$N$r$p$salt$hash
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,                         -- sha256 of the cookie token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- expenses side
CREATE TABLE cards (
  id               INTEGER PRIMARY KEY,
  label            TEXT NOT NULL,
  bank             TEXT,
  network          TEXT,                               -- visa, mastercard, amex, unionpay, ...
  -- Only the last 4 digits, ever. No PAN, CVV or PIN column exists, and this one cannot hold more.
  last4            TEXT NOT NULL CHECK (length(last4) = 4 AND last4 GLOB '[0-9][0-9][0-9][0-9]'),
  expiry_month     INTEGER CHECK (expiry_month BETWEEN 1 AND 12),
  expiry_year      INTEGER CHECK (expiry_year BETWEEN 2000 AND 2100),
  currency         TEXT CHECK (currency IN ('EUR','USD','TND','VND')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','standby','blocked','expired')),
  usable_countries TEXT NOT NULL DEFAULT '["worldwide"]',   -- JSON array of ISO-2 codes or "worldwide"
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Bills I pay (the brief's "invoices" table; named bills to keep it apart from outgoing_invoices).
-- due_date is the open occurrence. Paying a recurring bill logs the payment and rolls due_date
-- forward one cycle; next_due_date is always the occurrence after due_date.
CREATE TABLE bills (
  id               INTEGER PRIMARY KEY,
  title            TEXT NOT NULL,
  vendor           TEXT NOT NULL,
  receiver_name    TEXT,                               -- company or person who gets the money
  receiver_country TEXT,                               -- ISO-2
  amount           INTEGER,                            -- NULL = amount still unknown (TODO)
  currency         TEXT NOT NULL DEFAULT 'EUR' CHECK (currency IN ('EUR','USD','TND','VND')),
  billing_cycle    TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('one-time','monthly','quarterly','yearly')),
  anchor_day       INTEGER CHECK (anchor_day BETWEEN 1 AND 31),
  due_date         TEXT NOT NULL,
  next_due_date    TEXT,
  status           TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','paid','overdue','cancelled')),
  paid_date        TEXT,
  payment_card_id  INTEGER REFERENCES cards(id) ON DELETE SET NULL,
  category         TEXT,
  receipt_file     TEXT,                               -- path relative to the receipts folder
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX bills_due ON bills(status, due_date);

CREATE TABLE payments_log (
  id              INTEGER PRIMARY KEY,
  bill_id         INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  paid_date       TEXT NOT NULL,
  period_due_date TEXT NOT NULL,                       -- which occurrence this payment settled
  amount          INTEGER,
  currency        TEXT NOT NULL,
  card_id         INTEGER REFERENCES cards(id) ON DELETE SET NULL,
  card_label      TEXT,                                -- snapshot, survives card deletion
  receipt_file    TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX payments_bill ON payments_log(bill_id, paid_date);

-- ---------------------------------------------------------------- income side
CREATE TABLE issuer_profiles (
  id               INTEGER PRIMARY KEY,
  prefix           TEXT NOT NULL UNIQUE CHECK (prefix GLOB '[A-Z]*' AND length(prefix) BETWEEN 2 AND 8),
  legal_name       TEXT NOT NULL,
  title_line       TEXT,                               -- e.g. "Software engineer — independent consultant"
  address          TEXT,
  country          TEXT,
  tax_id           TEXT,                               -- EIN / tax number; NULL while pending
  email            TEXT,
  phone            TEXT,
  bank_beneficiary TEXT,
  bank_name        TEXT,
  bank_iban        TEXT,
  bank_swift       TEXT,
  bank_account     TEXT,
  bank_address     TEXT,
  bank_currency    TEXT,
  bank_extra       TEXT,                               -- correspondent bank etc.
  payment_note     TEXT,                               -- printed under the bank details
  footer_text      TEXT,                               -- default legal mentions / footer
  logo_file        TEXT,                               -- optional custom logo; default is the brand mark
  default_currency TEXT NOT NULL DEFAULT 'EUR' CHECK (default_currency IN ('EUR','USD','TND','VND')),
  is_default       INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX issuer_single_default ON issuer_profiles(is_default) WHERE is_default = 1;

CREATE TABLE clients (
  id                        INTEGER PRIMARY KEY,
  company_name              TEXT NOT NULL,
  contact_name              TEXT,
  billing_emails            TEXT NOT NULL DEFAULT '[]',   -- JSON array
  cc_emails                 TEXT NOT NULL DEFAULT '[]',   -- JSON array
  phone                     TEXT,
  address                   TEXT,
  country                   TEXT,
  registration_id           TEXT,                         -- SIREN/SIRET, company number
  vat_number                TEXT,
  currency                  TEXT NOT NULL DEFAULT 'EUR' CHECK (currency IN ('EUR','USD','TND','VND')),
  payment_terms_days        INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  legal_mentions            TEXT,                         -- exact VAT / reverse-charge wording, from the owner
  invoice_note              TEXT,                         -- other text printed on every invoice
  language                  TEXT NOT NULL DEFAULT 'EN' CHECK (language IN ('FR','EN')),
  default_issuer_profile_id INTEGER REFERENCES issuer_profiles(id) ON DELETE SET NULL,
  client_reminders          INTEGER NOT NULL DEFAULT 0 CHECK (client_reminders IN (0,1)),
  notes                     TEXT,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE recurring_invoice_schedules (
  id                 INTEGER PRIMARY KEY,
  name               TEXT,
  client_id          INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  issuer_profile_id  INTEGER NOT NULL REFERENCES issuer_profiles(id) ON DELETE RESTRICT,
  -- [{description, quantity, unit, unit_price (minor), variable_quantity}]; {month} {year} placeholders
  line_items         TEXT NOT NULL DEFAULT '[]',
  tax_lines          TEXT NOT NULL DEFAULT '[]',        -- [{label, rate}] rate in percent
  currency           TEXT NOT NULL DEFAULT 'EUR' CHECK (currency IN ('EUR','USD','TND','VND')),
  frequency          TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly','quarterly','custom')),
  interval_months    INTEGER NOT NULL DEFAULT 1 CHECK (interval_months BETWEEN 1 AND 24),
  send_rule          TEXT NOT NULL DEFAULT 'last_business_day' CHECK (send_rule IN ('last_business_day','fixed_day')),
  send_day           INTEGER CHECK (send_day BETWEEN 1 AND 31),
  mode               TEXT NOT NULL DEFAULT 'approve_first' CHECK (mode IN ('auto_send','approve_first')),
  approval_lead_days INTEGER NOT NULL DEFAULT 3 CHECK (approval_lead_days BETWEEN 0 AND 14),
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  next_run_date      TEXT NOT NULL,                     -- send date of the next invoice
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Gapless numbering: one row per issuer and year, bumped inside the same transaction that
-- gives an invoice its number. Numbers are only handed out when an invoice is finalized.
CREATE TABLE invoice_counters (
  issuer_profile_id INTEGER NOT NULL REFERENCES issuer_profiles(id) ON DELETE RESTRICT,
  kind              TEXT NOT NULL CHECK (kind IN ('invoice','credit_note')),
  year              INTEGER NOT NULL,
  last_number       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (issuer_profile_id, kind, year)
);

CREATE TABLE outgoing_invoices (
  id                   INTEGER PRIMARY KEY,
  invoice_number       TEXT UNIQUE,                     -- NULL until finalized; never reused
  client_id            INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  issuer_profile_id    INTEGER NOT NULL REFERENCES issuer_profiles(id) ON DELETE RESTRICT,
  schedule_id          INTEGER REFERENCES recurring_invoice_schedules(id) ON DELETE SET NULL,
  period_key           TEXT,                            -- '2026-10' for scheduled ones: one invoice per period
  language             TEXT NOT NULL CHECK (language IN ('FR','EN')),
  currency             TEXT NOT NULL CHECK (currency IN ('EUR','USD','TND','VND')),
  issue_date           TEXT,
  scheduled_send_date  TEXT,
  service_period_start TEXT,
  service_period_end   TEXT,
  due_date             TEXT,
  line_items           TEXT NOT NULL DEFAULT '[]',      -- [{description, quantity, unit, unit_price, amount}]
  subtotal             INTEGER NOT NULL DEFAULT 0,
  tax_lines            TEXT NOT NULL DEFAULT '[]',      -- [{label, rate, amount}]
  tax_total            INTEGER NOT NULL DEFAULT 0,
  total                INTEGER NOT NULL DEFAULT 0,
  legal_mentions       TEXT,
  invoice_note         TEXT,
  issuer_snapshot      TEXT,                            -- JSON copy of issuer + client at finalization,
  client_snapshot      TEXT,                            -- so later profile edits never change a sent invoice
  status               TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','pending_approval','approved','sent','paid','partially_paid','overdue','void')),
  approved_at          TEXT,
  pdf_path             TEXT,                            -- relative to the issued-invoices folder
  sent_at              TEXT,
  sent_to              TEXT,                            -- JSON {to:[], cc:[]}
  paid_date            TEXT,
  amount_received      INTEGER NOT NULL DEFAULT 0,
  is_legacy            INTEGER NOT NULL DEFAULT 0,      -- imported, issued before FinTrack
  notes                TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (schedule_id, period_key)
);
CREATE INDEX outgoing_status ON outgoing_invoices(status, due_date);
CREATE INDEX outgoing_client ON outgoing_invoices(client_id, issue_date);

-- A sent invoice is frozen: only payment tracking, status and notes may change afterwards.
CREATE TRIGGER outgoing_invoices_immutable
BEFORE UPDATE ON outgoing_invoices
WHEN OLD.sent_at IS NOT NULL AND (
     NEW.invoice_number       IS NOT OLD.invoice_number
  OR NEW.client_id            IS NOT OLD.client_id
  OR NEW.issuer_profile_id    IS NOT OLD.issuer_profile_id
  OR NEW.language             IS NOT OLD.language
  OR NEW.currency             IS NOT OLD.currency
  OR NEW.issue_date           IS NOT OLD.issue_date
  OR NEW.service_period_start IS NOT OLD.service_period_start
  OR NEW.service_period_end   IS NOT OLD.service_period_end
  OR NEW.due_date             IS NOT OLD.due_date
  OR NEW.line_items           IS NOT OLD.line_items
  OR NEW.subtotal             IS NOT OLD.subtotal
  OR NEW.tax_lines            IS NOT OLD.tax_lines
  OR NEW.tax_total            IS NOT OLD.tax_total
  OR NEW.total                IS NOT OLD.total
  OR NEW.legal_mentions       IS NOT OLD.legal_mentions
  OR NEW.invoice_note         IS NOT OLD.invoice_note
  OR NEW.issuer_snapshot      IS NOT OLD.issuer_snapshot
  OR NEW.client_snapshot      IS NOT OLD.client_snapshot
  OR NEW.pdf_path             IS NOT OLD.pdf_path
  OR NEW.sent_at              IS NOT OLD.sent_at
  OR NEW.sent_to              IS NOT OLD.sent_to
  OR NEW.status IN ('draft','pending_approval','approved')
)
BEGIN
  SELECT RAISE(ABORT, 'invoice already sent: it is immutable, issue a credit note instead');
END;

-- Numbered invoices are never deleted (void them instead).
CREATE TRIGGER outgoing_invoices_no_delete
BEFORE DELETE ON outgoing_invoices
WHEN OLD.invoice_number IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'numbered invoices cannot be deleted');
END;

CREATE TABLE invoice_payments (
  id         INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES outgoing_invoices(id) ON DELETE RESTRICT,
  paid_date  TEXT NOT NULL,
  amount     INTEGER NOT NULL CHECK (amount > 0),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Corrections to a sent invoice. Same numbering rules, own sequence (<PREFIX>-CN-YYYY-####).
CREATE TABLE credit_notes (
  id                INTEGER PRIMARY KEY,
  credit_number     TEXT NOT NULL UNIQUE,
  invoice_id        INTEGER NOT NULL REFERENCES outgoing_invoices(id) ON DELETE RESTRICT,
  issuer_profile_id INTEGER NOT NULL REFERENCES issuer_profiles(id) ON DELETE RESTRICT,
  issue_date        TEXT NOT NULL,
  reason            TEXT NOT NULL,
  line_items        TEXT NOT NULL DEFAULT '[]',
  subtotal          INTEGER NOT NULL,
  tax_lines         TEXT NOT NULL DEFAULT '[]',
  tax_total         INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL,                  -- positive number = amount credited
  currency          TEXT NOT NULL,
  pdf_path          TEXT,
  sent_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER credit_notes_immutable
BEFORE UPDATE ON credit_notes
WHEN NEW.credit_number IS NOT OLD.credit_number OR NEW.invoice_id IS NOT OLD.invoice_id
  OR NEW.issue_date IS NOT OLD.issue_date OR NEW.reason IS NOT OLD.reason
  OR NEW.line_items IS NOT OLD.line_items OR NEW.subtotal IS NOT OLD.subtotal
  OR NEW.tax_lines IS NOT OLD.tax_lines OR NEW.tax_total IS NOT OLD.tax_total
  OR NEW.total IS NOT OLD.total OR NEW.currency IS NOT OLD.currency
  OR (OLD.pdf_path IS NOT NULL AND NEW.pdf_path IS NOT OLD.pdf_path)
BEGIN
  SELECT RAISE(ABORT, 'credit notes are immutable');
END;

CREATE TRIGGER credit_notes_no_delete
BEFORE DELETE ON credit_notes
BEGIN
  SELECT RAISE(ABORT, 'credit notes cannot be deleted');
END;

CREATE TABLE invoice_events (
  id             INTEGER PRIMARY KEY,
  invoice_id     INTEGER REFERENCES outgoing_invoices(id) ON DELETE RESTRICT,
  credit_note_id INTEGER REFERENCES credit_notes(id) ON DELETE RESTRICT,
  schedule_id    INTEGER REFERENCES recurring_invoice_schedules(id) ON DELETE SET NULL,
  type           TEXT NOT NULL,   -- created, approved, numbered, sent, reminder_owner, reminder_client, payment, paid, voided, credit_note, ...
  detail         TEXT,            -- JSON
  actor          TEXT NOT NULL DEFAULT 'user',          -- user | automation
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX events_invoice ON invoice_events(invoice_id, created_at);

-- ---------------------------------------------------------------- automation bookkeeping
-- Every email goes through here first. The UNIQUE key makes a second run on the same day a no-op.
CREATE TABLE email_log (
  id          INTEGER PRIMARY KEY,
  dedupe_key  TEXT NOT NULL UNIQUE,   -- e.g. 'invoice-send:12', 'reminder-owner:12', 'bills-report:2026-10'
  kind        TEXT NOT NULL,
  recipients  TEXT NOT NULL,          -- JSON {to, cc, bcc}
  subject     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  error       TEXT,
  message_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at     TEXT
);

CREATE TABLE job_runs (
  id          INTEGER PRIMARY KEY,
  job         TEXT NOT NULL,
  run_date    TEXT NOT NULL,
  dry_run     INTEGER NOT NULL,
  ok          INTEGER,
  summary     TEXT,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
