#!/bin/zsh
set -euo pipefail

export PATH="/Users/vure/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd /Users/vure/ReportDalily

if [[ -f .env.local ]]; then
  set -a
  source .env.local
  set +a
fi

if [[ -z "${TEMU_REPORT_DATE:-}" ]]; then
  current_hour="$(/bin/date '+%H')"
  if [[ "$current_hour" == "00" ]]; then
    export TEMU_REPORT_DATE="yesterday"
  else
    export TEMU_REPORT_DATE="today"
  fi
fi

audit_log="/Users/vure/ReportDalily/temu-reports/launchd.audit.log"
lock_dir="/tmp/com.vure.temu-report.lock"

mkdir -p /Users/vure/ReportDalily/temu-reports

log_audit() {
  /bin/date "+%Y-%m-%d %H:%M:%S %Z %z | $*" >> "$audit_log"
}

if ! /bin/mkdir "$lock_dir" 2>/dev/null; then
  log_audit "skip: another temu report run is active pid=$$ ppid=$PPID"
  exit 0
fi

cleanup() {
  local exit_code=$?
  /bin/rmdir "$lock_dir" 2>/dev/null || true
  log_audit "finish: status=$exit_code pid=$$"
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

log_audit "start: pid=$$ ppid=$PPID report_date=$TEMU_REPORT_DATE pwd=$PWD path=$PATH"
/Users/vure/.nvm/versions/node/v22.22.3/bin/npm run temu:report:all:image
