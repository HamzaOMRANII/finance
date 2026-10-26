#!/usr/bin/env bash
# Called every hour by root's crontab (see deploy/crontab). The server clock is Europe/Berlin,
# which shifts with DST, so the business schedule is decided here in Africa/Lagos time:
#   02:00 Lagos  nightly backup
#   08:00 Lagos  invoice generator + payment reminders, and on the last day of the month the
#                bills report
# Usage: cron.sh            (normal hourly tick)
#        cron.sh daily      (run the 08:00 jobs now)       cron.sh backup   (run the backup now)
set -euo pipefail

cd "$(dirname "$0")/.."
export TZ=Africa/Lagos
NODE="${NODE:-$(command -v node)}"
HOUR="$(date +%H)"
MODE="${1:-tick}"

# one run at a time
exec 9>"automation/logs/.cron.lock"
flock -n 9 || { echo "another run is in progress"; exit 0; }

run_daily() {
  "$NODE" automation/invoice-generator.js || true
  "$NODE" automation/payment-reminders.js || true
  # bills report on the last day of the month only
  if [ "$(date -d tomorrow +%d)" = "01" ]; then
    "$NODE" automation/bills-report.js || true
  fi
}

case "$MODE" in
  daily)  run_daily ;;
  backup) "$NODE" automation/backup.js ;;
  tick)
    [ "$HOUR" = "08" ] && run_daily
    [ "$HOUR" = "02" ] && "$NODE" automation/backup.js
    true
    ;;
  *) echo "usage: $0 [tick|daily|backup]"; exit 2 ;;
esac
