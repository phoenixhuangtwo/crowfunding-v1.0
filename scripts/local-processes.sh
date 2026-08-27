#!/usr/bin/env bash

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${LOCAL_RUNTIME_DIR:-$PROJECT_DIR/.runtime}"
API_PORT="${API_PORT:-4100}"
WEB_PORT="${WEB_PORT:-5174}"
API_PID_FILE="$RUNTIME_DIR/api.pid"
WEB_PID_FILE="$RUNTIME_DIR/web.pid"
API_LOG="$RUNTIME_DIR/api.log"
WEB_LOG="$RUNTIME_DIR/web.log"
NODE_BIN="$(command -v node || true)"
SCREEN_BIN="$(command -v screen || true)"
API_SESSION="crowdfunding-api-$API_PORT"
WEB_SESSION="crowdfunding-web-$WEB_PORT"

usage() {
  cat <<EOF
用法：$(basename "$0") <start|restart|stop|status|help>

  start    启动缺失的前端和 API 进程
  restart  重启当前项目的前端和 API 进程
  stop     停止当前项目的前端和 API 进程
  status   查看进程、端口、地址和日志状态
  help     显示帮助
EOF
}

listener_pid() {
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1
}

process_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

process_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

is_project_process() {
  local pid="$1"
  local kind="$2"
  local command
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ "$(process_cwd "$pid")" == "$PROJECT_DIR" ]] || return 1
  command="$(process_command "$pid")"
  if [[ "$kind" == "api" ]]; then
    [[ "$command" == *"server/server.ts"* ]]
  else
    [[ "$command" == *"vite"* ]]
  fi
}

wait_for_url() {
  local url="$1"
  local attempts=60
  while (( attempts > 0 )); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
    attempts=$((attempts - 1))
  done
  return 1
}

ensure_runtime() {
  mkdir -p "$RUNTIME_DIR"
}

launch_detached() {
  local session="$1"
  local log_file="$2"
  shift 2
  if [[ -n "$SCREEN_BIN" ]]; then
    (
      cd "$PROJECT_DIR" || exit 1
      "$SCREEN_BIN" -S "$session" -X quit >/dev/null 2>&1 || true
      "$SCREEN_BIN" -dmS "$session" env LOCAL_PROCESS_LOG="$log_file" \
        bash -c 'exec "$@" >"$LOCAL_PROCESS_LOG" 2>&1' _ "$@"
    )
  else
    (
      cd "$PROJECT_DIR" || exit 1
      nohup "$@" >"$log_file" 2>&1 </dev/null &
    )
  fi
}

start_api() {
  local pid
  pid="$(listener_pid "$API_PORT")"
  if [[ -n "$pid" ]]; then
    if ! is_project_process "$pid" api; then
      echo "错误：端口 $API_PORT 已被其他进程占用，未执行启动。" >&2
      return 1
    fi
    ensure_runtime
    echo "$pid" > "$API_PID_FILE"
    echo "API 已在运行（PID ${pid}，端口 $API_PORT）"
    return 0
  fi

  ensure_runtime
  launch_detached "$API_SESSION" "$API_LOG" env API_PORT="$API_PORT" \
    "$NODE_BIN" --env-file-if-exists=.env.local --import tsx server/server.ts
  if ! wait_for_url "http://127.0.0.1:$API_PORT/api/health"; then
    echo "错误：API 启动失败，日志：$API_LOG" >&2
    tail -n 20 "$API_LOG" >&2 || true
    return 1
  fi
  pid="$(listener_pid "$API_PORT")"
  echo "$pid" > "$API_PID_FILE"
  echo "API 运行中（PID ${pid}，http://127.0.0.1:$API_PORT/api/health）"
}

start_web() {
  local pid
  pid="$(listener_pid "$WEB_PORT")"
  if [[ -n "$pid" ]]; then
    if ! is_project_process "$pid" web; then
      echo "错误：端口 $WEB_PORT 已被其他进程占用，未执行启动。" >&2
      return 1
    fi
    ensure_runtime
    echo "$pid" > "$WEB_PID_FILE"
    echo "前端已在运行（PID ${pid}，端口 $WEB_PORT）"
    return 0
  fi

  ensure_runtime
  launch_detached "$WEB_SESSION" "$WEB_LOG" \
    "$NODE_BIN" "$PROJECT_DIR/node_modules/vite/bin/vite.js" --host 127.0.0.1 --port "$WEB_PORT"
  if ! wait_for_url "http://127.0.0.1:$WEB_PORT/"; then
    echo "错误：前端启动失败，日志：$WEB_LOG" >&2
    tail -n 20 "$WEB_LOG" >&2 || true
    return 1
  fi
  pid="$(listener_pid "$WEB_PORT")"
  echo "$pid" > "$WEB_PID_FILE"
  echo "前端运行中（PID ${pid}，http://127.0.0.1:$WEB_PORT/）"
}

stop_service() {
  local kind="$1"
  local label="$2"
  local port="$3"
  local pid_file="$4"
  local pid=""
  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
  fi
  if ! is_project_process "$pid" "$kind"; then
    pid="$(listener_pid "$port")"
  fi
  if [[ -z "$pid" ]]; then
    rm -f "$pid_file"
    echo "$label 未运行"
    return 0
  fi
  if ! is_project_process "$pid" "$kind"; then
    echo "错误：端口 $port 上的 PID $pid 不属于当前项目，未执行停止。" >&2
    return 1
  fi

  kill -TERM "$pid" 2>/dev/null || true
  local attempts=50
  while kill -0 "$pid" 2>/dev/null && (( attempts > 0 )); do
    sleep 0.1
    attempts=$((attempts - 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
  echo "$label 已停止（PID ${pid}）"
}

start_all() {
  if [[ -z "$NODE_BIN" || ! -d "$PROJECT_DIR/node_modules" ]]; then
    echo "错误：缺少 Node.js 或 node_modules，请先在项目目录执行 npm install。" >&2
    return 1
  fi
  start_api || return 1
  start_web || return 1
  echo "日志目录：$RUNTIME_DIR"
}

stop_all() {
  local result=0
  stop_service web 前端 "$WEB_PORT" "$WEB_PID_FILE" || result=1
  stop_service api API "$API_PORT" "$API_PID_FILE" || result=1
  return "$result"
}

status_all() {
  local api_pid web_pid result=0
  api_pid="$(listener_pid "$API_PORT")"
  web_pid="$(listener_pid "$WEB_PORT")"
  if is_project_process "$web_pid" web; then
    echo "前端 运行中：PID ${web_pid}，http://127.0.0.1:$WEB_PORT/"
  else
    echo "前端 未运行：端口 $WEB_PORT"
    result=1
  fi
  if is_project_process "$api_pid" api; then
    echo "API 运行中：PID ${api_pid}，http://127.0.0.1:$API_PORT/api/health"
  else
    echo "API 未运行：端口 $API_PORT"
    result=1
  fi
  echo "日志目录：$RUNTIME_DIR"
  return "$result"
}

case "${1:-help}" in
  start) start_all ;;
  restart) stop_all && start_all ;;
  stop) stop_all ;;
  status) status_all ;;
  help|-h|--help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
