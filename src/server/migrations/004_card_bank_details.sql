-- Optional bank details on a card (useful for transfers to the account behind it).
-- Still no card number, CVV or PIN: only the last 4 digits exist.
ALTER TABLE cards ADD COLUMN holder_name TEXT;
ALTER TABLE cards ADD COLUMN iban TEXT;
ALTER TABLE cards ADD COLUMN swift TEXT;
ALTER TABLE cards ADD COLUMN account_number TEXT;
ALTER TABLE cards ADD COLUMN bank_country TEXT;
ALTER TABLE cards ADD COLUMN bank_address TEXT;
