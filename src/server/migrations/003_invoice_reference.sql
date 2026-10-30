-- Reference chosen by hand on a draft (e.g. INV-2026-10-001). It becomes the invoice number
-- when the draft is sent; empty = the next free number from the issuer's format.
-- The due date of a draft can now be set too (outgoing_invoices.due_date, empty = issue date + terms).
ALTER TABLE outgoing_invoices ADD COLUMN requested_number TEXT;
