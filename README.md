# FinTrack · finance.omranisystems.com

Personal finance and invoicing for Hamza Omrani: bills and cards I pay, invoices I send to
clients, and month-end automations. Same stack and design family as `it.omranisystems.com` and
the portfolio (React 19 + Vite 8, a zero-dependency Node `http` server, navy/petrol/gold tokens,
Sora / Inter / JetBrains Mono).

- **Live:** https://finance.omranisystems.com (access-code gate `finance`, then the app login)
- **On the box:** `/projects/finance`, pm2 app `finance` on `127.0.0.1:17000`, nginx `/etc/nginx/conf.d/finance.conf`
- **Data (never in git):** `data/fintrack.db`, `data/receipts/`, `data/issued-invoices/`, `data/seed.local.json`

## Layout

```
src/server.js              HTTP server: static dist/ + JSON API, security headers
src/server/                config, db (node:sqlite + migrations), auth, api routes
src/server/lib/            bills, invoices (numbering, lifecycle), pdf, mailer, receipts, dashboard
src/server/migrations/     numbered SQL migrations, applied on start
src/shared/                money + date helpers used by server and client
src/client/                React app; theme.css = shared Omrani Systems tokens
automation/                bills-report, invoice-generator, payment-reminders, backup, cron.sh
assets/fonts/              Sora, Inter, JetBrains Mono (OFL) embedded in the PDFs
deploy/                    nginx server block, crontab line
test/                      npm test
```

## Setup

```bash
cd /projects/finance
cp .env.example .env && chmod 600 .env    # fill in (see below)
npm ci
npm run build
npm run seed                              # first run only; reads data/seed.local.json if present
npm run set-password -- admin             # prints a random password once
# pm2: the "finance" entry lives in /projects/ecosystem.config.js
pm2 start /projects/ecosystem.config.js --only finance && pm2 save
cp deploy/nginx.conf /etc/nginx/conf.d/finance.conf && nginx -t && systemctl reload nginx
crontab -e                                # add the line from deploy/crontab
```

Deploy updates the usual way: `/projects/deploy.sh finance finance` (git reset to origin/main,
`npm ci`, build, pm2 reload). Migrations run when the server starts. `data/` is untracked, so
deploys never touch it.

### Environment (.env)

| Variable | Meaning |
|---|---|
| `HOST`, `PORT` | bind address, default `127.0.0.1:17000` |
| `PUBLIC_URL` | used in email links |
| `TZ` | `Africa/Lagos`, the business timezone |
| `SESSION_SECRET` | long random string; session ids are stored as HMACs of the cookie token |
| `SESSION_DAYS` | login lifetime (default 7) |
| `OWNER_EMAIL` | where notifications go; BCC on every client email |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | outgoing mail |
| `RECEIPTS_AI`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | optional Claude extraction for scanned receipts |
| `BACKUP_DIR` | nightly archives (default `/root/backups/finance`) |
| `DB_FILE`, `RECEIPTS_DIR`, `ISSUED_DIR`, `LOGS_DIR` | optional path overrides |
| `INVOICE_TEMPLATE_FR`, `SOFFICE_BIN` | French .docx template and LibreOffice binary (defaults: the template folder, `soffice`) |

`NODE_ENV=production` is set by pm2 (it turns on `Secure` / `__Host-` cookies); do not put it in `.env`.

## How invoicing works

- **Issuer profiles** each own a gapless yearly sequence: `HO-2026-0003`, `HOLLC-2026-0001`, credit
  notes `HO-CN-2026-0001`. The `HO` 2026 counter starts at 2 because `INV-2026-08-001` and
  `INV-2026-09-001` were issued before FinTrack (imported as legacy invoices with their PDFs).
- **Numbers are given at send time** (email, or "Mark as sent" for invoices delivered by hand),
  inside one transaction with the counter. Drafts have no number, so deleting a draft never
  leaves a gap, and numbers follow issue dates.
- **Sent invoices are immutable**: SQLite triggers reject any change to their content and any
  delete. Corrections are credit notes (own numbers, own PDFs), linked to the original.
- **French invoices use your Word template** `data/issued-invoices/template/Modele_Facture_FR.docx`
  as-is (the file is only read, never modified): `src/server/lib/docx.js` fills a copy, value by
  value after each label (“Numéro de facture :”, “Raison sociale :”…), clones the line-item row per
  line, and fills or removes the “TVA :” row. The PDF is that .docx converted by headless
  LibreOffice (`apt install libreoffice-writer-nogui fonts-crosextra-carlito`; Carlito matches
  Calibri). Each sent French invoice is stored as both `HO-2026-0003.pdf` and `.docx`, and both
  can be downloaded. To change the look, edit the .docx in Word and keep the labels. English
  invoices and credit notes use the built-in branded layout. Drafts carry no watermark: they show
  the next free number, which is only reserved when the invoice is sent.
- **Recurring schedules**: `last_business_day` skips Saturday and Sunday. `approve_first` creates
  the draft 3 days before the send date and emails me the draft PDF; if it is not approved by the
  send date it is *not* sent and I get a reminder every morning. `auto_send` emails the client on
  the send date. A line marked "variable quantity" always forces approval.
- **Email safety**: every recipient must be `OWNER_EMAIL` or an address stored on a client;
  anything else is refused in code. Each email has a dedupe key in `email_log`, so a job that runs
  twice never sends twice.

## Automations

`automation/cron.sh` runs every hour from root's crontab and decides in Africa/Lagos time (the
server clock is Europe/Berlin and shifts with DST):

| When (Lagos) | Job | What it does |
|---|---|---|
| 08:00 daily | `invoice-generator.js` | drafts / creates invoices due from schedules, sends approved ones, reminds me of unapproved ones |
| 08:00 daily | `payment-reminders.js` | marks overdue; notifies me at due + 3 days; optional client reminder at + 7 days (per client, off by default) |
| 08:00, last day of month | `bills-report.js` | recomputes next due dates, flags overdue bills, emails next month's bills with totals and card warnings |
| 02:00 daily | `backup.js` | SQLite snapshot + receipts + issued invoices → `BACKUP_DIR`, keeps 14 |

Every script accepts `--dry-run` (prints what it would do: no email, no number, no data change),
`--date YYYY-MM-DD` (pretend today) and `--force` (skip the month-end guard). Runs are appended to
`automation/logs/<job>-YYYY-MM.log` and listed on the Settings page.

```bash
node automation/invoice-generator.js --dry-run --date 2026-10-27
node automation/bills-report.js --dry-run --force
automation/cron.sh daily      # run the 08:00 jobs now (for real)
```

## Email: SMTP and DNS

FinTrack currently sends through Gmail (`smtp.gmail.com:465`) as `homrani555@gmail.com` with a
Google **App Password** (the normal account password does not work). Gmail signs these messages
with its own SPF/DKIM, so no DNS change is needed while the sender is a `@gmail.com` address.

To send from your own domain later (e.g. `billing@omranisystems.com`), use a provider that signs
for the domain (Google Workspace, Zoho, Brevo, Postmark…) and add in Cloudflare DNS (DNS-only):

| Type | Name | Value |
|---|---|---|
| TXT | `omranisystems.com` | `v=spf1 include:<provider spf host> ~all` (e.g. `include:_spf.google.com`) |
| TXT | `<selector>._domainkey` | the DKIM public key the provider gives you |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:homrani555@gmail.com` |

Then change `SMTP_*` in `.env` and `pm2 restart finance`.

## Backup and restore

Archives: `/root/backups/finance/fintrack-YYYYMMDD-HHMMSS.tar.gz` (chmod 600), the newest 14 are
kept. Only these archives are ever deleted; issued invoices are never removed by any routine.
Copy them off the server from time to time (they hold all financial data).

Restore:

```bash
pm2 stop finance
cd /root && mkdir restore && tar xzf /root/backups/finance/fintrack-<stamp>.tar.gz -C restore
cp /projects/finance/data/fintrack.db /projects/finance/data/fintrack.db.before-restore
cp restore/fintrack.db /projects/finance/data/fintrack.db && rm -f /projects/finance/data/fintrack.db-wal /projects/finance/data/fintrack.db-shm
rsync -a restore/receipts/ /projects/finance/data/receipts/
rsync -a --ignore-existing restore/issued-invoices/ /projects/finance/data/issued-invoices/
pm2 start finance
```

## Security notes

- App binds to `127.0.0.1`; nginx terminates TLS with the Cloudflare origin certificate, puts the
  omranisystems access gate in front, and rate-limits `POST /api/login` (5/min per IP, plus an
  in-app lockout after 5 failures).
- Single user, scrypt password hashes, `HttpOnly` + `Secure` + `SameSite=Strict` session cookie,
  CSRF token header on every write, strict CSP.
- Receipts and issued PDFs are only served through authenticated API routes, with path
  resolution that refuses anything outside their folder (symlinks included).
- Cards: only the last 4 digits exist in the schema; the API and a CHECK constraint refuse more.
- Secrets live in `.env` (gitignored, chmod 600).
