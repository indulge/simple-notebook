#!/usr/bin/env bash
#
# run.sh — launch and stop the simple-notebook dev server.
#
# Run "./run.sh help" to see all commands.

set -euo pipefail

# Always operate from the project root (the directory this script lives in).
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

PID_FILE="$PROJECT_DIR/.devserver.pid"
LOG_FILE="$PROJECT_DIR/.devserver.log"

# Port the dev server listens on (kept in sync with package.json "start").
PORT=3050
URL="http://localhost:$PORT/simple-notebook/"

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start() {
  if is_running; then
    echo "Already running (pid $(cat "$PID_FILE"))."
    return 0
  fi
  echo "Starting dev server on port $PORT..."
  npm start >"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"

  # Wait for the server to bind the port (or die trying).
  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Failed to start. Recent log:"
      tail -n 15 "$LOG_FILE"
      rm -f "$PID_FILE"
      return 1
    fi
    if curl -s -o /dev/null --max-time 1 "$URL"; then
      echo "Started (pid $pid). Logs: $LOG_FILE"
      echo "Site: $URL"
      return 0
    fi
    sleep 1
  done

  echo "Started (pid $pid) but did not respond yet. Check: $LOG_FILE"
  echo "Site: $URL"
}

stop() {
  if ! is_running; then
    echo "Not running."
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  echo "Stopping dev server (pid $pid)..."
  # Kill the process group so child node processes are stopped too.
  kill "$pid" 2>/dev/null || true
  pkill -P "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "Stopped."
}

status() {
  if is_running; then
    echo "Running (pid $(cat "$PID_FILE"))."
  else
    echo "Not running."
  fi
}

usage() {
  cat <<EOF
Usage: ./run.sh <command>

Commands:
  start     Start the dev server in the background
  stop      Stop the dev server
  restart   Stop then start the dev server
  status    Show whether the dev server is running
  logs      Tail the dev server log
  help      Show this help message

Dev site: $URL
EOF
}

case "${1:-help}" in
  start)        start ;;
  stop)         stop ;;
  restart)      stop; start ;;
  status)       status ;;
  logs)         tail -f "$LOG_FILE" ;;
  help|-h|--help) usage ;;
  *)
    echo "Unknown command: $1"
    echo
    usage
    exit 1
    ;;
esac
