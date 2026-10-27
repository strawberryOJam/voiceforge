#!/bin/bash
# 启动 Breeze TTS 2 网页控制台（~/voiceforge/app.py），并在浏览器打开。
set -u
URL="http://127.0.0.1:7860"
APP="$HOME/voiceforge/app.py"
PY="$HOME/breeze-env/bin/python"
LOG="/tmp/voiceforge.log"

if ! curl -sf -m 1 "$URL" >/dev/null 2>&1; then
  echo "启动控制台…"
  nohup "$PY" "$APP" > "$LOG" 2>&1 &
  disown
  for _ in $(seq 1 40); do
    curl -sf -m 1 "$URL" >/dev/null 2>&1 && break
    sleep 1
  done
fi

if curl -sf -m 2 "$URL" >/dev/null 2>&1; then
  echo "已就绪：$URL"
  open "$URL"
else
  echo "启动失败，见 $LOG"
  exit 1
fi
