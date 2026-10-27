#!/usr/bin/env python3
"""声铸 VoiceForge 本地语音工坊 — 入口

用法：
    ~/breeze-env/bin/python ~/voiceforge/app.py
然后浏览器打开 http://127.0.0.1:7860
"""

import uvicorn

from server import config
from server.app import create_app

app = create_app()

if __name__ == "__main__":
    print(f"声铸 VoiceForge → http://127.0.0.1:7860 （输出目录 {config.OUT_DIR}）", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=7860, log_level="warning")
