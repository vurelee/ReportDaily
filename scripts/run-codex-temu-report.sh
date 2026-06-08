#!/bin/zsh
set -euo pipefail

export PATH="/Users/vure/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd /Users/vure/ReportDalily

report_dir="/Users/vure/ReportDalily/temu-reports"
audit_log="$report_dir/codex.audit.log"
out_log="$report_dir/codex.out.log"
err_log="$report_dir/codex.err.log"

mkdir -p "$report_dir"

exec > >(/usr/bin/tee -a "$out_log") 2> >(/usr/bin/tee -a "$err_log" >&2)

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

case "$TEMU_REPORT_DATE" in
  today|yesterday) ;;
  *)
    echo "TEMU_REPORT_DATE must be today or yesterday; got: $TEMU_REPORT_DATE" >&2
    exit 2
    ;;
esac

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

max_attempts="${TEMU_CODEX_MAX_ATTEMPTS:-2}"
retry_delay="${TEMU_CODEX_RETRY_DELAY_SECONDS:-15}"
wake_delay="${TEMU_CODEX_WAKE_DELAY_SECONDS:-25}"
lock_dir="/tmp/com.vure.temu-report-codex.lock"

if ! [[ "$max_attempts" =~ '^[1-9][0-9]*$' ]]; then
  max_attempts=2
fi

if ! [[ "$retry_delay" =~ '^[0-9]+$' ]]; then
  retry_delay=15
fi

if ! [[ "$wake_delay" =~ '^[0-9]+$' ]]; then
  wake_delay=25
fi

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
  log_audit "skip: another codex temu report run is active pid=$$ ppid=$PPID report_date=$TEMU_REPORT_DATE"
  echo "Another Codex Temu report run is active." >&2
  exit 75
fi

cleanup() {
  local exit_code=$?
  /bin/rmdir "$lock_dir" 2>/dev/null || true
  log_audit "finish: status=$exit_code pid=$$ report_date=$TEMU_REPORT_DATE"
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

log_audit "start: pid=$$ ppid=$PPID report_date=$TEMU_REPORT_DATE product_source=$TEMU_PRODUCT_SOURCE pwd=$PWD path=$PATH max_attempts=$max_attempts"

if [[ "${TEMU_CODEX_WAKE_DISPLAY:-1}" != "0" ]]; then
  log_audit "preflight: wake_display delay=${wake_delay}s"
  /usr/bin/caffeinate -u -t "$wake_delay" >/dev/null 2>&1 || true
fi

last_status=0
attempt=1
while (( attempt <= max_attempts )); do
  reset_cdp_chrome_ports
  log_audit "run: attempt=$attempt/$max_attempts npm temu:report:all:image product_source=$TEMU_PRODUCT_SOURCE"

  if /usr/bin/caffeinate -d -i -m /Users/vure/.nvm/versions/node/v22.22.3/bin/npm run temu:report:all:image; then
    log_audit "success: attempt=$attempt/$max_attempts"
    exit 0
  else
    last_status=$?
  fi

  log_audit "retryable_failure: attempt=$attempt/$max_attempts status=$last_status"

  if (( attempt < max_attempts )); then
    /bin/sleep "$retry_delay"
  fi

  attempt=$(( attempt + 1 ))
done

exit "$last_status"
