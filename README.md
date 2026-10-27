# 声铸 VoiceForge · 本地语音工坊

基于 MLX 的 Apple Silicon 本地语音控制台：音色设计 / 克隆 / 执导 / 多角色对话配音，
带音色库、文稿模板、加工流水线仪表盘与模型管理中心。

![声铸 VoiceForge 控制台](docs/screenshot.png)

## 结构

```
├── app.py                 # FastAPI 后端（MLX 推理 + 任务队列 + 全部 API）
├── frontend/              # React 前端（Vite 构建）
│   └── src/
│       ├── store.jsx      # 全局状态：任务轮询/队列、模型切换、数据加载
│       ├── App.jsx        # 侧边栏 + 视图路由
│       └── views/         # 工作台/音色库/模板/历史/仪表盘/设置
└── frontend/dist/         # 构建产物（后端直接托管）
```

数据（音色库、模板、设置、模型配置）存放在 `~/models/breeze-out/ui/`，不随仓库管理。

## 使用

```bash
~/breeze-env/bin/python ~/voiceforge/app.py    # 打开 http://127.0.0.1:7860
```

或使用 `启动控制台.command` / `停止控制台.command`。

## 前端开发

```bash
cd frontend
npm install
npm run dev      # http://127.0.0.1:5173（/api 与 /files 已代理到 7860）
npm run build    # 产物输出到 frontend/dist，由后端托管
```

## 主要能力

- 音色设计 / 克隆 / 执导（参考音频 + 文字稿），4bit/bf16 热切换
- 多角色对话配音：每句台词指派音色库角色，逐句生成后拼接
- 任务队列：批量提交、排队取消、一键再生成、分段流水线实时进度
- 音色库 / 文稿模板：保存、试听、一键应用到工作台
- 仪表盘：加工流水线、14 天统计、最近任务
- 设置：模型配置（预置 HuggingFace 一键下载 / 自定义路径）、生成默认值、输出目录
- 后处理：响度归一化（目标可调）、语速 0.5–2×、WAV/MP3 导出
