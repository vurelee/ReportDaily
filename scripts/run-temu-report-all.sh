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

if [[ -z "${TEMU_PRODUCT_SOURCE:-}" ]]; then
  export TEMU_PRODUCT_SOURCE="api"
fi

case "$TEMU_PRODUCT_SOURCE" in
  api) ;;
  *)
    echo "TEMU_PRODUCT_SOURCE must be api; got: $TEMU_PRODUCT_SOURCE" >&2
    exit 2
    ;;
esac

audit_log="/Users/vure/ReportDalily/temu-reports/launchd.audit.log"
lock_dir="/tmp/com.vure.temu-report.lock"

mkdir -p /Users/vure/ReportDalily/temu-reports

log_audit() {
  /bin/date "+%Y-%m-%d %H:%M:%S %Z %z | $*" >> "$audit_log"
}

reset_cdp_chrome_ports() {
  for port in 9222 9223; do
    local pids
    pids="$(/usr/sbin/lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -z "$pids" ]]; then
      continue
    fi

    local pid_list
    pid_list="$(printf "%s" "$pids" | tr '\n' ',')"
    log_audit "preflight: reset_cdp port=$port pids=$pid_list"
    while IFS= read -r pid; do
      if [[ -n "$pid" ]]; then
        /bin/kill "$pid" 2>/dev/null || true
      fi
    done <<< "$pids"
  done

  /bin/sleep 2
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

log_audit "start: pid=$$ ppid=$PPID report_date=$TEMU_REPORT_DATE product_source=$TEMU_PRODUCT_SOURCE pwd=$PWD path=$PATH"

wake_delay="${TEMU_LAUNCHD_WAKE_DELAY_SECONDS:-25}"
if ! [[ "$wake_delay" =~ '^[0-9]+$' ]]; then
  wake_delay=25
fi

if [[ "${TEMU_LAUNCHD_WAKE_DISPLAY:-1}" != "0" ]]; then
  log_audit "preflight: wake_display delay=${wake_delay}s"
  /usr/bin/caffeinate -u -t "$wake_delay" >/dev/null 2>&1 || true
fi

reset_cdp_chrome_ports

log_audit "run: caffeinate npm temu:report:all:image product_source=$TEMU_PRODUCT_SOURCE"
/usr/bin/caffeinate -d -i -m /Users/vure/.nvm/versions/node/v22.22.3/bin/npm run temu:report:all:image
