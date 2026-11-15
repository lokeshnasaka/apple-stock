#!/bin/sh
# Runs the checker until END (HH:MM, default 23:00) while keeping the Mac awake,
# restarting it if it exits early. Started daily by a launchd StartCalendarInterval job.
cd "$(dirname "$0")/.." || exit 1
END="${END:-23:00}"
end=$(date -j -f "%H:%M:%S" "$END:00" +%s)
[ "$(date +%s)" -lt "$end" ] || exit 0

# -i: no idle sleep; -s: no system sleep while on AC power. Neither stops lid-close sleep.
caffeinate -is -w $$ &

while [ "$(date +%s)" -lt "$end" ]; do
  node --env-file-if-exists=.env src/index.js &
  pid=$!
  # Stop it at END; if it dies first, restart after 30s.
  ( sleep $((end - $(date +%s))); kill "$pid" 2>/dev/null ) &
  timer=$!
  wait "$pid"
  kill "$timer" 2>/dev/null
  [ "$(date +%s)" -lt "$end" ] && echo "$(date) checker exited; restarting in 30s" && sleep 30
done
