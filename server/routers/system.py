"""系统路由：状态、设置、模型配置/切换/下载、统计、系统操作（遗留 presets 兼容）。"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException

from .. import config, engine, jobs

router = APIRouter()

SAVE = "utf-8"


@router.get("/api/status")
async def status():
    return {
        "loaded_model": engine.STATE["name"],
        "queue_size": jobs.QUEUE.qsize(),
        "memory_gb": config.memory_gb(),
        "models": {k: config.model_view(v) for k, v in config.MODELS.items()},
        "default_model": config.SETTINGS["default_model"],
        "tags_zh": config.TAGS_ZH,
        "tags_en": config.TAGS_EN,
    }


# ---------------- 设置 ----------------

@router.get("/api/settings")
async def get_settings():
    return {
        **config.SETTINGS,
        "data_dir": str(config.DATA_DIR),
        "models": {k: config.model_view(v) for k, v in config.MODELS.items()},
        "voices_count": len(config.read_json(config.VOICES_JSON)),
        "templates_count": len(config.read_json(config.TEMPLATES_JSON)),
    }


@router.put("/api/settings")
async def put_settings(payload: dict):
    changed = {}
    if "output_dir" in payload:
        p = Path(os.path.expanduser(str(payload["output_dir"]))).expanduser()
        if not str(p).strip():
            raise HTTPException(400, "输出目录不能为空")
        p.mkdir(parents=True, exist_ok=True)
        config.SETTINGS["output_dir"] = str(p)
        config.set_output_dir(p)
        changed["output_dir"] = str(p)
    if "default_model" in payload:
        if payload["default_model"] not in config.MODELS:
            raise HTTPException(400, "默认模型不在已配置模型中")
        config.SETTINGS["default_model"] = payload["default_model"]
        changed["default_model"] = payload["default_model"]
    if "default_format" in payload:
        config.SETTINGS["default_format"] = "mp3" if payload["default_format"] == "mp3" else "wav"
        changed["default_format"] = config.SETTINGS["default_format"]
    if "loudness_target" in payload:
        t = float(payload["loudness_target"])
        if not -30.0 <= t <= 0.0:
            raise HTTPException(400, "响度目标需在 -30 到 0 LUFS 之间")
        config.SETTINGS["loudness_target"] = t
        changed["loudness_target"] = t
    if "autoplay" in payload:
        config.SETTINGS["autoplay"] = bool(payload["autoplay"])
        changed["autoplay"] = config.SETTINGS["autoplay"]

    config.save_settings()
    return {"ok": True, "changed": changed}


# ---------------- 模型配置 ----------------

@router.post("/api/models")
async def upsert_model(payload: dict):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "模型名称不能为空")
    path = (payload.get("path") or "").strip()
    repo = (payload.get("repo") or "").strip()
    if not path and not repo:
        raise HTTPException(400, "请至少填写本地路径或 HuggingFace 仓库 ID")
    mid = payload.get("id") or config.uuid_hex(8)
    if mid in config.DEFAULT_MODELS:
        raise HTTPException(400, "内置模型不可修改，可删除后重新添加")
    config.MODELS[mid] = {
        "name": name[:60],
        "path": path or str(config.HOME / "models" / repo.split("/")[-1]),
        "repo": repo, "builtin": False,
    }
    config.save_models()
    return {"ok": True, "id": mid, "model": config.MODELS[mid]}


@router.delete("/api/models/{mid}")
async def delete_model(mid: str):
    entry = config.MODELS.get(mid)
    if entry is None:
        raise HTTPException(404, "模型不存在")
    if entry.get("builtin"):
        raise HTTPException(400, "内置模型不可删除")
    if engine.STATE["name"] == mid:
        raise HTTPException(400, "该模型正在加载中，请先释放模型内存")
    config.MODELS.pop(mid, None)
    config.save_models()
    return {"ok": True}


@router.post("/api/models/{mid}/download")
async def download_model(mid: str):
    entry = config.MODELS.get(mid)
    if entry is None:
        raise HTTPException(404, "模型不存在")
    if not entry.get("repo"):
        raise HTTPException(400, "该模型没有配置下载仓库（本地路径模型无需下载）")
    return jobs.submit({"download_task": mid}, pipeline_stages=config.DOWNLOAD_STAGES)


@router.post("/api/model/load")
async def load_model_now(payload: dict):
    name = (payload.get("model") or "")
    if name not in config.MODELS:
        raise HTTPException(400, f"未知模型：{name}")
    r = jobs.submit({"model_task": name})
    return {"job_id": r["job_id"]}


@router.post("/api/model/unload")
async def unload_model():
    engine.unload_model()
    return {"ok": True}


# ---------------- 统计 ----------------

@router.get("/api/stats")
async def stats():
    import time

    files = config.all_outputs()
    daily: dict[str, int] = {}
    total_kb = 0
    for f in files:
        total_kb += f.stat().st_size / 1024
        key = f.name[:8]  # YYYYMMDD
        if key.isdigit():
            daily[key] = daily.get(key, 0) + 1

    days = []
    for i in range(13, -1, -1):
        d = time.strftime("%Y%m%d", time.localtime(time.time() - i * 86400))
        days.append({"date": d[4:6] + "-" + d[6:8], "count": daily.get(d, 0)})

    recent = []
    for job in sorted(jobs.JOBS.values(), key=lambda j: j["created_at"], reverse=True)[:12]:
        p = job["params"]
        recent.append({
            "id": job["id"],
            "kind": "model" if "model_task" in p else "gen",
            "mode": p.get("mode"),
            "text": (p.get("text") or "")[:40],
            "status": job["status"],
            "phase": job["phase"],
            "time": config.fmt_day(job["created_at"]),
            "pipeline": job.get("pipeline"),
            "error": job["error"],
            "duration": (job["result"] or {}).get("duration"),
            "elapsed": (job["result"] or {}).get("elapsed"),
        })

    return {
        "total": len(files),
        "today": daily.get(time.strftime("%Y%m%d"), 0),
        "size_mb": round(total_kb / 1024, 1),
        "daily": days,
        "recent": recent,
        "voice_count": len(config.read_json(config.VOICES_JSON)),
        "template_count": len(config.read_json(config.TEMPLATES_JSON)),
        "loaded_model": engine.STATE["name"],
        "queue_size": jobs.QUEUE.qsize(),
    }


# ---------------- 系统操作 ----------------

@router.post("/api/open-folder")
async def open_folder():
    subprocess.Popen(["open", str(config.OUT_DIR)])
    return {"ok": True}


@router.post("/api/open-path")
async def open_path(payload: dict):
    p = Path(os.path.expanduser(str(payload.get("path") or "")))
    if not p.exists():
        raise HTTPException(404, "路径不存在")
    subprocess.Popen(["open", str(p)])
    return {"ok": True}


# ---------------- 遗留 presets（早期版本数据，新前端已不再使用） ----------------

@router.get("/api/presets")
async def get_presets():
    return {"items": config.read_json(config.PRESETS_PATH)}


@router.post("/api/presets")
async def add_preset(payload: dict):
    import time

    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "预设名称不能为空")
    items = config.read_json(config.PRESETS_PATH)
    preset = {
        "id": config.uuid_hex(),
        "name": name[:40],
        "mode": payload.get("mode") or "design",
        "instruct": (payload.get("instruct") or "").strip(),
        "cfg": float(payload.get("cfg") or 4.0),
        "created": time.strftime("%m-%d %H:%M"),
    }
    items.insert(0, preset)
    config.write_json(config.PRESETS_PATH, items[:100])
    return {"ok": True, "preset": preset}


@router.delete("/api/presets/{preset_id}")
async def delete_preset(preset_id: str):
    items = [p for p in config.read_json(config.PRESETS_PATH) if p.get("id") != preset_id]
    config.write_json(config.PRESETS_PATH, items)
    return {"ok": True}
