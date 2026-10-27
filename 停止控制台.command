#!/bin/bash
# 停止网页控制台，释放模型占用的内存。
pkill -f "voiceforge/app.py" && echo "控制台已停止" || echo "控制台未在运行"
