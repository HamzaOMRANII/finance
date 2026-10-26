-- Invoice number format per issuer, e.g. 'INV-{YYYY}-{MM}-{NNN}' -> INV-2026-10-001.
-- Tokens: {PREFIX} {YYYY} {YY} {MM} and {N…} (the sequence, zero-padded to the number of N).
-- The sequence restarts every month when the format contains {MM}, every year otherwise, so
-- counters are now keyed by period ('2026' or '2026-10') instead of year.
ALTER TABLE issuer_profiles ADD COLUMN number_format TEXT NOT NULL DEFAULT '{PREFIX}-{YYYY}-{NNNN}';
ALTER TABLE issuer_profiles ADD COLUMN credit_format TEXT NOT NULL DEFAULT '{PREFIX}-CN-{YYYY}-{NNNN}';

CREATE TABLE invoice_counters_new (
  issuer_profile_id INTEGER NOT NULL REFERENCES issuer_profiles(id) ON DELETE RESTRICT,
  kind              TEXT NOT NULL CHECK (kind IN ('invoice','credit_note')),
  period            TEXT NOT NULL,
  last_number       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (issuer_profile_id, kind, period)
);
INSERT INTO invoice_counters_new (issuer_profile_id, kind, period, last_number)
  SELECT issuer_profile_id, kind, CAST(year AS TEXT), last_number FROM invoice_counters;
DROP TABLE invoice_counters;
ALTER TABLE invoice_counters_new RENAME TO invoice_counters;
