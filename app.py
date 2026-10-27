#!/usr/bin/env python3
"""Breeze TTS 2 本地控制台（Apple Silicon / MLX）— FastAPI 后端 + 静态前端

用法：
    ~/breeze-env/bin/python ~/breeze-ui/app.py
然后浏览器打开 http://127.0.0.1:7860

特性：音色设计 / 克隆 / 执导、4bit·bf16 热切换、按句自动分段、句间静音可控、
响度归一化（-16 LUFS）、任务队列与分段进度、音色预设库、历史记录管理。
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from mlx_audio.audio_io import write as audio_write
from mlx_audio.tts.utils import load_model

HOME = Path.home()
DATA_DIR = HOME / "models" / "breeze-out" / "ui"  # 固定数据目录：音色库/模板/设置
DATA_DIR.mkdir(parents=True, exist_ok=True)
PRESETS_PATH = DATA_DIR / "presets.json"
VOICES_DIR = DATA_DIR / "voices"
VOICES_DIR.mkdir(exist_ok=True)
VOICES_JSON = VOICES_DIR / "voices.json"
TEMPLATES_JSON = DATA_DIR / "templates.json"
MODELS_JSON = DATA_DIR / "models.json"
SETTINGS_PATH = DATA_DIR / "settings.json"
STATIC_DIR = Path(__file__).parent / "static"

DEFAULT_MODELS = {
    "4bit": {
        "name": "Breeze TTS 2 · 4bit（约3GB，快）",
        "path": str(HOME / "models" / "Breeze-TTS-2" / "mlx-4bit"),
        "repo": "mlx-community/Breeze-TTS-2-4bit",
        "builtin": True,
    },
    "bf16": {
        "name": "Breeze TTS 2 · bf16（约7.6GB，细节好）",
        "path": str(HOME / "models" / "Breeze-TTS-2" / "mlx-bf16"),
        "repo": "mlx-community/Breeze-TTS-2-bf16",
        "builtin": True,
    },
}

DEFAULT_SETTINGS = {
    "output_dir": str(DATA_DIR),
    "default_model": "4bit",
    "default_format": "wav",
    "loudness_target": -16.0,
    "autoplay": True,
}


def _load_json_file(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            pass
    return default


MODELS: dict[str, dict] = dict(DEFAULT_MODELS)
MODELS.update({k: v for k, v in (_load_json_file(MODELS_JSON, {}) or {}).items() if k not in MODELS})
DEFAULT_MODEL = "4bit"

SETTINGS: dict = dict(DEFAULT_SETTINGS)
SETTINGS.update({k: v for k, v in (_load_json_file(SETTINGS_PATH, {}) or {}).items() if k in DEFAULT_SETTINGS})
OUT_DIR = Path(os.path.expanduser(str(SETTINGS["output_dir"])))
OUT_DIR.mkdir(parents=True, exist_ok=True)

# MLX 的 GPU stream 绑定在线程上，所有推理固定在同一个工作线程里按队列执行
_STATE = {"name": None, "model": None}
_LOCK = threading.Lock()
_JOBS: dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()
_QUEUE: queue.Queue[str] = queue.Queue()
_MAX_JOBS_KEPT = 50

TAGS_ZH = ["[笑]", "[叹气]", "[停顿]", "[耳语]", "[清嗓]", "[抽泣]", "[哼歌]"]
TAGS_EN = ["(laughs)", "(sighs)", "(pause)", "(whispers)", "(clears throat)", "(sobs)", "(humming)"]

_SENT_END = re.compile(r"(?<=[。！？!?；;…])")
_PUNCT_ONLY = re.compile(r"^[…。！？!?；;，,、\s]+$")
_SAFE_NAME = re.compile(r"^[\w\-.\u4e00-\u9fff（）()]+\.(wav|mp3)$")


def _load_model(name: str):
    with _LOCK:
        if _STATE["name"] == name and _STATE["model"] is not None:
            return _STATE["model"]
        if _STATE["model"] is not None:
            _STATE["model"] = None
            mx.clear_cache()
        t0 = time.time()
        model = load_model(MODELS[name]["path"])
        _STATE.update(name=name, model=model)
        print(f"[load] {name} in {time.time() - t0:.1f}s", flush=True)
        return model


def _split_segments(text: str) -> list[str]:
    """按句末标点切分，纯标点段并入上一句。"""
    text = text.replace("……", "…").strip()
    parts, out = _SENT_END.split(text), []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if _PUNCT_ONLY.match(p):
            if out:
                out[-1] += p
            continue
        out.append(p)
    return out or [text]


def _gen_one(model, text, instruct, ref_audio, ref_text, cfg_scale, seed):
    kwargs = dict(
        text=text,
        instruct=instruct,
        cfg_scale=float(cfg_scale),
        seed=int(seed),
        split_pattern=None,  # 分段由我们自己控制
    )
    if ref_audio:
        kwargs.update(ref_audio=ref_audio, ref_text=ref_text)

    chunks, sr = [], 24000
    for result in model.generate(**kwargs):
        if result.audio is not None and result.audio.size > 0:
            chunks.append(np.array(result.audio))
            sr = result.sample_rate
    if not chunks:
        raise RuntimeError("模型没有返回音频")
    return (np.concatenate(chunks) if len(chunks) > 1 else chunks[0]), sr


def _ffmpeg_finish(audio: np.ndarray, sr: int, normalize: bool, speed: float, fmt: str, base: Path, target: float = -16.0) -> Path:
    """响度归一化 + 语速调整 + 编码（wav/mp3），写出到 base 对应扩展名的路径并返回该路径。"""
    speed = min(2.0, max(0.5, float(speed or 1.0)))
    ext = "mp3" if fmt == "mp3" else "wav"
    need_proc = normalize or abs(speed - 1.0) > 1e-3 or ext == "mp3"
    out_path = base.with_suffix(f".{ext}")
    if not need_proc or shutil.which("ffmpeg") is None:
        out_path = base.with_suffix(".wav")
        audio_write(str(out_path), np.asarray(audio, dtype=np.float32), sr, format="wav")
        return out_path
    tmp_in = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp_in = f.name
        audio_write(tmp_in, audio, sr, format="wav")
        filters = []
        if normalize:
            filters.append(f"loudnorm=I={target}:TP=-1.5:LRA=11")
        if abs(speed - 1.0) > 1e-3:
            filters.append(f"atempo={speed:.2f}")
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", tmp_in]
        if filters:
            cmd += ["-af", ",".join(filters)]
        if ext == "mp3":
            cmd += ["-codec:a", "libmp3lame", "-q:a", "4"]
        cmd += ["-ar", str(sr), "-ac", "1", str(out_path)]
        subprocess.run(cmd, check=True, capture_output=True)
        return out_path
    except Exception as exc:  # noqa: BLE001
        print(f"[finish] 跳过后处理：{exc}", flush=True)
        fallback = base.with_suffix(".wav")
        audio_write(str(fallback), np.asarray(audio, dtype=np.float32), sr, format="wav")
        return fallback
    finally:
        if tmp_in:
            Path(tmp_in).unlink(missing_ok=True)


PIPELINE_STAGES = ["排队", "加载模型", "文稿分段", "逐句合成", "拼接静音", "响度归一化", "完成"]


def _run_job(job: dict) -> None:
    p = job["params"]
    job["started_at"] = time.time()
    job["status"] = "running"

    if "model_task" in p:  # 纯模型切换任务
        job["pipeline"] = {"current": 1}
        job["phase"] = "切换模型"
        try:
            _load_model(p["model_task"])
            job["result"] = {"loaded": p["model_task"]}
            job["status"] = "done"
            job["phase"] = "完成"
            job["pipeline"] = {"current": 6}
        except Exception as exc:  # noqa: BLE001
            job["status"] = "error"
            job["error"] = str(exc)
            print(f"[job {job['id']}] 切换模型失败：{exc}", flush=True)
        finally:
            job["finished_at"] = time.time()
        return

    if "download_task" in p:  # 模型下载任务
        job["pipeline"] = {"current": 1, "stages": ["排队", "下载模型", "完成"]}
        job["phase"] = "下载模型"
        try:
            entry = MODELS.get(p["download_task"])
            if entry is None or not entry.get("repo"):
                raise RuntimeError("该模型没有配置下载仓库")
            dest = Path(os.path.expanduser(str(entry["path"])))
            dest.mkdir(parents=True, exist_ok=True)
            from huggingface_hub import snapshot_download
            snapshot_download(repo_id=entry["repo"], local_dir=str(dest))
            job["result"] = {"downloaded": p["download_task"]}
            job["status"] = "done"
            job["phase"] = "完成"
            job["pipeline"] = {"current": 2}
        except Exception as exc:  # noqa: BLE001
            job["status"] = "error"
            job["error"] = str(exc)
            print(f"[job {job['id']}] 模型下载失败：{exc}", flush=True)
        finally:
            job["finished_at"] = time.time()
        return

    if "dialogue" in p:  # 多角色对话配音
        _run_dialogue(job)
        return

    ref_tmp = p.get("ref_audio")
    ref_is_library = bool(p.get("ref_is_library"))
    try:
        job["phase"] = "加载模型"
        job["pipeline"] = {"current": 1}
        model = _load_model(p["model"])

        segments = _split_segments(p["text"]) if p["auto_split"] else [p["text"]]
        job["progress"] = {"done": 0, "total": len(segments)}
        job["phase"] = "合成中"
        job["pipeline"] = {
            "current": 3,
            "stages": PIPELINE_STAGES,
            "segments": [{"text": s[:60], "status": "pending"} for s in segments],
        }

        t0 = time.time()
        pieces, sr = [], 24000
        for i, seg in enumerate(segments):
            if job["pipeline"].get("segments"):
                job["pipeline"]["segments"][i]["status"] = "running"
            audio, sr = _gen_one(
                model, seg, p["instruct"], ref_tmp, p["ref_text"], p["cfg"], p["seed"],
            )
            pieces.append(audio)
            job["progress"] = {"done": i + 1, "total": len(segments)}
            if job["pipeline"].get("segments"):
                job["pipeline"]["segments"][i]["status"] = "done"

        if len(pieces) > 1:
            job["pipeline"]["current"] = 4
            job["phase"] = "拼接静音"
            gap_samples = max(0, int(float(p["gap"]) * sr))
            parts = []
            for i, piece in enumerate(pieces):
                parts.append(piece)
                if i != len(pieces) - 1 and gap_samples:
                    parts.append(np.zeros(gap_samples, dtype=piece.dtype))
            audio = np.concatenate(parts)
        else:
            audio = pieces[0]

        if p["normalize"]:
            job["pipeline"]["current"] = 5
            job["phase"] = "响度归一化"

        elapsed = time.time() - t0
        duration = len(audio) / sr
        stamp = time.strftime("%Y%m%d-%H%M%S")
        tag = "clone" if ref_tmp else "design"
        base = OUT_DIR / f"{stamp}_{job['id'][:4]}_{tag}_{p['model']}"
        path = _ffmpeg_finish(audio, sr, p["normalize"], p.get("speed", 1.0), p.get("format", "wav"), base, float(SETTINGS["loudness_target"]))

        job["result"] = {
            "name": path.name,
            "url": f"/files/{path.name}",
            "duration": round(duration, 2),
            "elapsed": round(elapsed, 1),
            "rtf": round(elapsed / duration, 2) if duration else None,
            "segments": len(segments),
            "gap": float(p["gap"]),
            "normalized": bool(p["normalize"]),
            "sample_rate": sr,
            "model": p["model"],
            "speed": float(p.get("speed", 1.0)),
            "format": path.suffix.lstrip("."),
        }
        job["status"] = "done"
        job["phase"] = "完成"
        job["pipeline"]["current"] = 6
    except Exception as exc:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = str(exc)
        print(f"[job {job['id']}] 失败：{exc}", flush=True)
    finally:
        if ref_tmp and not ref_is_library:
            Path(ref_tmp).unlink(missing_ok=True)
        job["finished_at"] = time.time()


def _run_dialogue(job: dict) -> None:
    """多角色对话配音：每行一个音色，逐句生成后拼接。"""
    p = job["params"]
    lines = p["dialogue"]
    try:
        job["pipeline"] = {"current": 1}
        job["phase"] = "加载模型"
        model = _load_model(p["model"])

        job["phase"] = "逐句合成"
        job["pipeline"] = {
            "current": 3,
            "stages": ["排队", "加载模型", "台词解析", "逐句合成", "拼接静音", "响度归一化", "完成"],
            "segments": [{"text": f"{l['speaker']}：{l['text']}"[:60], "status": "pending"} for l in lines],
        }
        job["progress"] = {"done": 0, "total": len(lines)}

        t0 = time.time()
        pieces, sr = [], 24000
        for i, line in enumerate(lines):
            job["pipeline"]["segments"][i]["status"] = "running"
            audio, sr = _gen_one(
                model, line["text"], line.get("instruct"), line.get("ref_path"),
                line.get("ref_text"), p["cfg"], p["seed"],
            )
            pieces.append(audio)
            job["progress"] = {"done": i + 1, "total": len(lines)}
            job["pipeline"]["segments"][i]["status"] = "done"

        if len(pieces) > 1:
            job["pipeline"]["current"] = 4
            job["phase"] = "拼接静音"
            gap_samples = max(0, int(float(p["gap"]) * sr))
            parts = []
            for i, piece in enumerate(pieces):
                parts.append(piece)
                if i != len(pieces) - 1 and gap_samples:
                    parts.append(np.zeros(gap_samples, dtype=piece.dtype))
            audio = np.concatenate(parts)
        else:
            audio = pieces[0]

        if p["normalize"]:
            job["pipeline"]["current"] = 5
            job["phase"] = "响度归一化"

        elapsed = time.time() - t0
        duration = len(audio) / sr
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base = OUT_DIR / f"{stamp}_{job['id'][:4]}_dialogue_{p['model']}"
        path = _ffmpeg_finish(audio, sr, p["normalize"], p.get("speed", 1.0), p.get("format", "wav"), base, float(SETTINGS["loudness_target"]))

        job["result"] = {
            "name": path.name,
            "url": f"/files/{path.name}",
            "duration": round(duration, 2),
            "elapsed": round(elapsed, 1),
            "rtf": round(elapsed / duration, 2) if duration else None,
            "segments": len(lines),
            "gap": float(p["gap"]),
            "normalized": bool(p["normalize"]),
            "sample_rate": sr,
            "model": p["model"],
            "speed": float(p.get("speed", 1.0)),
            "format": path.suffix.lstrip("."),
            "dialogue": True,
        }
        job["status"] = "done"
        job["phase"] = "完成"
        job["pipeline"]["current"] = 6
    except Exception as exc:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = str(exc)
        print(f"[job {job['id']}] 对话配音失败：{exc}", flush=True)
    finally:
        job["finished_at"] = time.time()


def _worker() -> None:
    while True:
        job_id = _QUEUE.get()
        job = _JOBS.get(job_id)
        if job is not None and job.get("status") != "cancelled":
            _run_job(job)
        _QUEUE.task_done()


threading.Thread(target=_worker, daemon=True, name="tts-worker").start()

app = FastAPI(title="声铸 VoiceForge · 本地语音工坊", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _b(value: str) -> bool:
    return str(value).lower() in ("true", "1", "on", "yes")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/status")
async def status():
    try:
        import resource
        rss_gb = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 ** 3), 2)
    except Exception:  # noqa: BLE001
        rss_gb = None
    return {
        "loaded_model": _STATE["name"],
        "queue_size": _QUEUE.qsize(),
        "memory_gb": rss_gb,
        "models": {
            k: {
                "name": v["name"],
                "path": str(v["path"]),
                "repo": v.get("repo") or "",
                "builtin": bool(v.get("builtin")),
                "exists": Path(os.path.expanduser(str(v["path"]))).exists(),
            }
            for k, v in MODELS.items()
        },
        "default_model": SETTINGS["default_model"],
        "tags_zh": TAGS_ZH,
        "tags_en": TAGS_EN,
    }


# ---------------- 设置 ----------------

@app.get("/api/settings")
async def get_settings():
    return {
        **SETTINGS,
        "data_dir": str(DATA_DIR),
        "models": {
            k: {
                "name": v["name"],
                "path": str(v["path"]),
                "repo": v.get("repo") or "",
                "builtin": bool(v.get("builtin")),
                "exists": Path(os.path.expanduser(str(v["path"]))).exists(),
            }
            for k, v in MODELS.items()
        },
        "voices_count": len(_read_json(VOICES_JSON)),
        "templates_count": len(_read_json(TEMPLATES_JSON)),
    }


@app.put("/api/settings")
async def put_settings(payload: dict):
    global OUT_DIR
    changed = {}
    if "output_dir" in payload:
        p = Path(os.path.expanduser(str(payload["output_dir"]))).expanduser()
        if not str(p).strip():
            raise HTTPException(400, "输出目录不能为空")
        p.mkdir(parents=True, exist_ok=True)
        SETTINGS["output_dir"] = str(p)
        OUT_DIR = p
        changed["output_dir"] = str(p)
    if "default_model" in payload:
        if payload["default_model"] not in MODELS:
            raise HTTPException(400, "默认模型不在已配置模型中")
        SETTINGS["default_model"] = payload["default_model"]
        changed["default_model"] = payload["default_model"]
    if "default_format" in payload:
        SETTINGS["default_format"] = "mp3" if payload["default_format"] == "mp3" else "wav"
        changed["default_format"] = SETTINGS["default_format"]
    if "loudness_target" in payload:
        t = float(payload["loudness_target"])
        if not -30.0 <= t <= 0.0:
            raise HTTPException(400, "响度目标需在 -30 到 0 LUFS 之间")
        SETTINGS["loudness_target"] = t
        changed["loudness_target"] = t
    if "autoplay" in payload:
        SETTINGS["autoplay"] = bool(payload["autoplay"])
        changed["autoplay"] = SETTINGS["autoplay"]

    SETTINGS_PATH.write_text(json.dumps(SETTINGS, ensure_ascii=False, indent=2), "utf-8")
    return {"ok": True, "changed": changed}


# ---------------- 模型配置 ----------------

def _save_models() -> None:
    custom = {k: v for k, v in MODELS.items() if not v.get("builtin")}
    MODELS_JSON.write_text(json.dumps(custom, ensure_ascii=False, indent=2), "utf-8")


def _new_model_id() -> str:
    return uuid_hex()[:8]


@app.post("/api/models")
async def upsert_model(payload: dict):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "模型名称不能为空")
    path = (payload.get("path") or "").strip()
    repo = (payload.get("repo") or "").strip()
    if not path and not repo:
        raise HTTPException(400, "请至少填写本地路径或 HuggingFace 仓库 ID")
    mid = payload.get("id") or _new_model_id()
    if mid in DEFAULT_MODELS:
        raise HTTPException(400, "内置模型不可修改，可删除后重新添加")
    MODELS[mid] = {"name": name[:60], "path": path or str(HOME / "models" / repo.split("/")[-1]), "repo": repo, "builtin": False}
    _save_models()
    return {"ok": True, "id": mid, "model": MODELS[mid]}


@app.delete("/api/models/{mid}")
async def delete_model(mid: str):
    entry = MODELS.get(mid)
    if entry is None:
        raise HTTPException(404, "模型不存在")
    if entry.get("builtin"):
        raise HTTPException(400, "内置模型不可删除")
    if _STATE["name"] == mid:
        raise HTTPException(400, "该模型正在加载中，请先释放模型内存")
    MODELS.pop(mid, None)
    _save_models()
    return {"ok": True}


@app.post("/api/models/{mid}/download")
async def download_model(mid: str):
    entry = MODELS.get(mid)
    if entry is None:
        raise HTTPException(404, "模型不存在")
    if not entry.get("repo"):
        raise HTTPException(400, "该模型没有配置下载仓库（本地路径模型无需下载）")
    job_id = uuid_hex()
    job = {
        "id": job_id,
        "status": "queued",
        "phase": "排队中",
        "progress": {"done": 0, "total": 0},
        "pipeline": {"current": 0, "stages": ["排队", "下载模型", "完成"]},
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "result": None,
        "error": None,
        "params": {"download_task": mid},
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = job
    _QUEUE.put(job_id)
    return {"job_id": job_id, "queue_position": _QUEUE.qsize()}


@app.post("/api/synthesize")
async def synthesize(
    text: str = Form(...),
    mode: str = Form("design"),
    instruct: str = Form(""),
    ref_text: str = Form(""),
    model: str = Form(DEFAULT_MODEL),
    cfg: float = Form(4.0),
    seed: int = Form(42),
    normalize: str = Form("true"),
    auto_split: str = Form("true"),
    gap: float = Form(0.35),
    speed: float = Form(1.0),
    format: str = Form("wav"),
    ref_audio: UploadFile | None = File(None),
    ref_voice_id: str = Form(""),
):
    text = (text or "").strip()
    if not text:
        raise HTTPException(400, "文稿不能为空")
    if mode not in ("design", "clone", "direct"):
        raise HTTPException(400, f"未知模式：{mode}")
    if model not in MODELS:
        raise HTTPException(400, f"未知模型：{model}")

    instruct = (instruct or "").strip() or None
    ref_text = (ref_text or "").strip() or None

    ref_tmp = None
    ref_is_library = False
    if ref_audio is not None and ref_audio.filename:
        suffix = Path(ref_audio.filename).suffix or ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(await ref_audio.read())
            ref_tmp = f.name
    elif ref_voice_id:
        vp = VOICES_DIR / f"{ref_voice_id}.wav"
        if vp.exists():
            ref_tmp = str(vp)
            ref_is_library = True

    if mode in ("clone", "direct"):
        if not ref_tmp:
            raise HTTPException(400, "克隆 / 执导模式需要上传参考音频，或从音色库选择")
        if not ref_text:
            if ref_tmp and not ref_is_library:
                Path(ref_tmp).unlink(missing_ok=True)
            raise HTTPException(400, "克隆 / 执导模式必须填写参考音频的准确文字稿")

    job_id = uuid_hex()
    job = {
        "id": job_id,
        "status": "queued",
        "phase": "排队中",
        "progress": {"done": 0, "total": 0},
        "pipeline": {"current": 0, "stages": PIPELINE_STAGES},
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "result": None,
        "error": None,
        "params": {
            "text": text, "mode": mode, "instruct": instruct, "model": model,
            "cfg": float(cfg), "seed": int(seed),
            "normalize": _b(normalize), "auto_split": _b(auto_split),
            "gap": float(gap), "ref_audio": ref_tmp, "ref_text": ref_text,
            "ref_is_library": ref_is_library,
            "speed": min(2.0, max(0.5, float(speed or 1.0))),
            "format": "mp3" if format == "mp3" else "wav",
        },
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = job
        if len(_JOBS) > _MAX_JOBS_KEPT:
            done_ids = [k for k, v in _JOBS.items() if v["status"] in ("done", "error")]
            for k in done_ids[: len(_JOBS) - _MAX_JOBS_KEPT]:
                _JOBS.pop(k, None)
    _QUEUE.put(job_id)
    return {"job_id": job_id, "queue_position": _QUEUE.qsize()}


def uuid_hex() -> str:
    import uuid
    return uuid.uuid4().hex[:12]


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "任务不存在或已被清理")
    running = job["status"] == "running" and job.get("started_at")
    return {
        "id": job["id"],
        "status": job["status"],
        "phase": job["phase"],
        "progress": job["progress"],
        "pipeline": job.get("pipeline"),
        "error": job["error"],
        "result": job["result"],
        "elapsed": round(time.time() - job["started_at"], 1) if running else None,
        "queue_position": _QUEUE.qsize() if job["status"] == "queued" else None,
    }


# ---------------- 多角色对话配音 ----------------

@app.post("/api/dialogue")
async def dialogue(payload: dict):
    raw_lines = payload.get("lines") or []
    model = payload.get("model") or DEFAULT_MODEL
    if model not in MODELS:
        raise HTTPException(400, f"未知模型：{model}")

    voices = {v["id"]: v for v in _read_json(VOICES_JSON)}
    lines = []
    for raw in raw_lines[:80]:
        text = (raw.get("text") or "").strip()
        if not text:
            continue
        vid = raw.get("voice_id") or ""
        speaker = "旁白"
        line = {"text": text, "instruct": None, "ref_path": None, "ref_text": None, "speaker": speaker}
        if vid:
            v = voices.get(vid)
            if v is None:
                raise HTTPException(400, f"音色不存在：{vid}")
            speaker = v["name"]
            line["speaker"] = v["name"]
            line["instruct"] = (v.get("instruct") or "").strip() or None
            line["ref_text"] = (v.get("ref_text") or "").strip() or None
            if v.get("has_ref"):
                rp = VOICES_DIR / f"{vid}.wav"
                if rp.exists():
                    line["ref_path"] = str(rp)
        lines.append(line)
    if not lines:
        raise HTTPException(400, "至少需要一行台词")

    job_id = uuid_hex()
    job = {
        "id": job_id,
        "status": "queued",
        "phase": "排队中",
        "progress": {"done": 0, "total": len(lines)},
        "pipeline": {"current": 0, "stages": ["排队", "加载模型", "台词解析", "逐句合成", "拼接静音", "响度归一化", "完成"]},
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "result": None,
        "error": None,
        "params": {
            "dialogue": lines, "mode": "dialogue", "model": model,
            "cfg": float(payload.get("cfg") or 4.0), "seed": int(payload.get("seed") or 42),
            "normalize": bool(payload.get("normalize", True)),
            "gap": min(2.0, max(0.0, float(payload.get("gap") if payload.get("gap") is not None else 0.25))),
            "speed": min(2.0, max(0.5, float(payload.get("speed") or 1.0))),
            "format": "mp3" if payload.get("format") == "mp3" else "wav",
        },
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = job
    _QUEUE.put(job_id)
    return {"job_id": job_id, "queue_position": _QUEUE.qsize()}


@app.delete("/api/jobs/{job_id}")
async def cancel_job(job_id: str):
    job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "任务不存在或已被清理")
    if job["status"] == "queued":
        job["status"] = "cancelled"
        job["finished_at"] = time.time()
        return {"ok": True}
    raise HTTPException(400, "任务已在运行，无法取消")


@app.post("/api/jobs/{job_id}/rerun")
async def rerun_job(job_id: str):
    old = _JOBS.get(job_id)
    if old is None:
        raise HTTPException(404, "任务不存在或已被清理")
    if "model_task" in old["params"]:
        raise HTTPException(400, "模型切换任务请直接使用模型切换")
    p = json.loads(json.dumps(old["params"]))  # 深拷贝，JSON 安全
    if p.get("ref_audio") and not p.get("ref_is_library") and not Path(p["ref_audio"]).exists():
        raise HTTPException(400, "原任务的参考音频是临时文件，已失效，请重新上传或改用音色库")

    new_id = uuid_hex()
    job = {
        "id": new_id,
        "status": "queued",
        "phase": "排队中",
        "progress": {"done": 0, "total": 0},
        "pipeline": {"current": 0, "stages": PIPELINE_STAGES},
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "result": None,
        "error": None,
        "params": p,
    }
    with _JOBS_LOCK:
        _JOBS[new_id] = job
        if len(_JOBS) > _MAX_JOBS_KEPT:
            done_ids = [k for k, v in _JOBS.items() if v["status"] in ("done", "error", "cancelled")]
            for k in done_ids[: len(_JOBS) - _MAX_JOBS_KEPT]:
                _JOBS.pop(k, None)
    _QUEUE.put(new_id)
    return {"job_id": new_id, "queue_position": _QUEUE.qsize()}


@app.get("/api/history")
async def history():
    files = _all_outputs()
    rows = []
    for f in files[:500]:
        st = f.stat()
        rows.append({
            "name": f.name,
            "size_kb": round(st.st_size / 1024),
            "time": time.strftime("%m-%d %H:%M", time.localtime(st.st_mtime)),
            "url": f"/files/{f.name}",
        })
    return {"count": len(rows), "items": rows, "dir": str(OUT_DIR)}


def _all_outputs() -> list[Path]:
    files = list(OUT_DIR.glob("*.wav")) + list(OUT_DIR.glob("*.mp3"))
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)


def _check_name(name: str) -> Path:
    if not _SAFE_NAME.match(name or ""):
        raise HTTPException(400, "非法文件名")
    p = OUT_DIR / name
    if not p.exists():
        raise HTTPException(404, "文件不存在")
    return p


@app.get("/files/{name}")
async def get_file(name: str, download: int = 0):
    p = _check_name(name)
    media = "audio/mpeg" if name.endswith(".mp3") else "audio/wav"
    if download:
        return FileResponse(p, media_type=media, filename=name,
                            headers={"Content-Disposition": f'attachment; filename="{name}"'})
    return FileResponse(p, media_type=media)


@app.delete("/api/history/{name}")
async def delete_history(name: str):
    _check_name(name).unlink()
    return {"ok": True}


@app.get("/api/presets")
async def get_presets():
    if PRESETS_PATH.exists():
        try:
            return {"items": json.loads(PRESETS_PATH.read_text("utf-8"))}
        except Exception:  # noqa: BLE001
            pass
    return {"items": []}


@app.post("/api/presets")
async def add_preset(payload: dict):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "预设名称不能为空")
    items = []
    if PRESETS_PATH.exists():
        try:
            items = json.loads(PRESETS_PATH.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            items = []
    preset = {
        "id": uuid_hex(),
        "name": name[:40],
        "mode": payload.get("mode") or "design",
        "instruct": (payload.get("instruct") or "").strip(),
        "cfg": float(payload.get("cfg") or 4.0),
        "created": time.strftime("%m-%d %H:%M"),
    }
    items.insert(0, preset)
    PRESETS_PATH.write_text(json.dumps(items[:100], ensure_ascii=False, indent=2), "utf-8")
    return {"ok": True, "preset": preset}


@app.delete("/api/presets/{preset_id}")
async def delete_preset(preset_id: str):
    items = []
    if PRESETS_PATH.exists():
        try:
            items = json.loads(PRESETS_PATH.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            items = []
    items = [p for p in items if p.get("id") != preset_id]
    PRESETS_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), "utf-8")
    return {"ok": True}


# ---------------- 音色库 ----------------

def _read_json(path: Path) -> list:
    if path.exists():
        try:
            data = json.loads(path.read_text("utf-8"))
            if isinstance(data, list):
                return data
        except Exception:  # noqa: BLE001
            pass
    return []


def _write_json(path: Path, items: list) -> None:
    path.write_text(json.dumps(items, ensure_ascii=False, indent=2), "utf-8")


_SAFE_ID = re.compile(r"^[a-f0-9]{12}$")


def _check_voice(vid: str) -> dict:
    if not _SAFE_ID.match(vid or ""):
        raise HTTPException(400, "非法音色 ID")
    item = next((v for v in _read_json(VOICES_JSON) if v.get("id") == vid), None)
    if item is None:
        raise HTTPException(404, "音色不存在")
    return item


@app.get("/api/voices")
async def list_voices():
    return {"items": _read_json(VOICES_JSON)}


@app.post("/api/voices")
async def add_voice(
    name: str = Form(...),
    mode: str = Form("design"),
    instruct: str = Form(""),
    ref_text: str = Form(""),
    ref_audio: UploadFile | None = File(None),
    ref_voice_id: str = Form(""),
):
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "音色名称不能为空")
    if mode not in ("design", "clone", "direct"):
        raise HTTPException(400, f"未知模式：{mode}")

    vid = uuid_hex()
    has_ref = False
    if ref_audio is not None and ref_audio.filename:
        (VOICES_DIR / f"{vid}.wav").write_bytes(await ref_audio.read())
        has_ref = True
    elif ref_voice_id:
        src = VOICES_DIR / f"{ref_voice_id}.wav"
        if src.exists():
            shutil.copyfile(src, VOICES_DIR / f"{vid}.wav")
            has_ref = True

    items = _read_json(VOICES_JSON)
    item = {
        "id": vid,
        "name": name[:40],
        "mode": mode,
        "instruct": (instruct or "").strip(),
        "ref_text": (ref_text or "").strip(),
        "has_ref": has_ref,
        "created": time.strftime("%m-%d %H:%M"),
    }
    items.insert(0, item)
    _write_json(VOICES_JSON, items[:200])
    return {"ok": True, "voice": item}


@app.get("/api/voices/{vid}/ref")
async def voice_ref(vid: str):
    _check_voice(vid)
    p = VOICES_DIR / f"{vid}.wav"
    if not p.exists():
        raise HTTPException(404, "该音色没有参考音频")
    return FileResponse(p, media_type="audio/wav")


@app.delete("/api/voices/{vid}")
async def delete_voice(vid: str):
    _check_voice(vid)
    _write_json(VOICES_JSON, [v for v in _read_json(VOICES_JSON) if v.get("id") != vid])
    (VOICES_DIR / f"{vid}.wav").unlink(missing_ok=True)
    return {"ok": True}


# ---------------- 文稿模板 ----------------

@app.get("/api/templates")
async def list_templates():
    return {"items": _read_json(TEMPLATES_JSON)}


@app.post("/api/templates")
async def add_template(payload: dict):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "模板名称不能为空")
    items = _read_json(TEMPLATES_JSON)
    item = {
        "id": uuid_hex(),
        "name": name[:40],
        "mode": payload.get("mode") or "design",
        "text": (payload.get("text") or "").strip(),
        "instruct": (payload.get("instruct") or "").strip(),
        "created": time.strftime("%m-%d %H:%M"),
    }
    items.insert(0, item)
    _write_json(TEMPLATES_JSON, items[:200])
    return {"ok": True, "template": item}


@app.delete("/api/templates/{tid}")
async def delete_template(tid: str):
    if not _SAFE_ID.match(tid or ""):
        raise HTTPException(400, "非法模板 ID")
    _write_json(TEMPLATES_JSON, [t for t in _read_json(TEMPLATES_JSON) if t.get("id") != tid])
    return {"ok": True}


# ---------------- 统计 / 仪表盘 ----------------

@app.get("/api/stats")
async def stats():
    files = _all_outputs()
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
    for job in sorted(_JOBS.values(), key=lambda j: j["created_at"], reverse=True)[:12]:
        p = job["params"]
        entry = {
            "id": job["id"],
            "kind": "model" if "model_task" in p else "gen",
            "mode": p.get("mode"),
            "text": (p.get("text") or "")[:40],
            "status": job["status"],
            "phase": job["phase"],
            "time": time.strftime("%m-%d %H:%M", time.localtime(job["created_at"])),
            "pipeline": job.get("pipeline"),
            "error": job["error"],
            "duration": (job["result"] or {}).get("duration"),
            "elapsed": (job["result"] or {}).get("elapsed"),
        }
        recent.append(entry)

    return {
        "total": len(files),
        "today": daily.get(time.strftime("%Y%m%d"), 0),
        "size_mb": round(total_kb / 1024, 1),
        "daily": days,
        "recent": recent,
        "voice_count": len(_read_json(VOICES_JSON)),
        "template_count": len(_read_json(TEMPLATES_JSON)),
        "loaded_model": _STATE["name"],
        "queue_size": _QUEUE.qsize(),
    }


@app.post("/api/model/load")
async def load_model_now(payload: dict):
    name = (payload.get("model") or "")
    if name not in MODELS:
        raise HTTPException(400, f"未知模型：{name}")
    job_id = uuid_hex()
    job = {
        "id": job_id,
        "status": "queued",
        "phase": "排队中",
        "progress": {"done": 0, "total": 0},
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "result": None,
        "error": None,
        "params": {"model_task": name},
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = job
    _QUEUE.put(job_id)
    return {"job_id": job_id}


@app.post("/api/model/unload")
async def unload_model():
    with _LOCK:
        _STATE["model"] = None
        _STATE["name"] = None
        mx.clear_cache()
    return {"ok": True}


@app.post("/api/open-folder")
async def open_folder():
    subprocess.Popen(["open", str(OUT_DIR)])
    return {"ok": True}


@app.exception_handler(HTTPException)
async def http_exc_handler(_, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


if __name__ == "__main__":
    print(f"声铸 VoiceForge → http://127.0.0.1:7860 （输出目录 {OUT_DIR}）", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=7860, log_level="warning")
