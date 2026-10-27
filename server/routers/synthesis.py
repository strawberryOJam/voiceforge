"""合成路由：单音色合成、多角色对话配音、任务查询/取消/再生成。"""

from __future__ import annotations

import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from .. import config, engine, jobs

router = APIRouter()


@router.post("/api/synthesize")
async def synthesize(
    text: str = Form(...),
    mode: str = Form("design"),
    instruct: str = Form(""),
    ref_text: str = Form(""),
    model: str = Form(config.DEFAULT_MODEL),
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
    if model not in config.MODELS:
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
        try:
            converted = engine.convert_to_wav(ref_tmp)
            if converted != ref_tmp:
                Path(ref_tmp).unlink(missing_ok=True)
                ref_tmp = converted
        except RuntimeError as exc:
            Path(ref_tmp).unlink(missing_ok=True)
            raise HTTPException(400, str(exc))
    elif ref_voice_id:
        vp = config.VOICES_DIR / f"{ref_voice_id}.wav"
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

    return jobs.submit({
        "text": text, "mode": mode, "instruct": instruct, "model": model,
        "cfg": float(cfg), "seed": int(seed),
        "normalize": config.b(normalize), "auto_split": config.b(auto_split),
        "gap": float(gap), "ref_audio": ref_tmp, "ref_text": ref_text,
        "ref_is_library": ref_is_library,
        "speed": min(2.0, max(0.5, float(speed or 1.0))),
        "format": "mp3" if format == "mp3" else "wav",
    })


@router.post("/api/dialogue")
async def dialogue(payload: dict):
    raw_lines = payload.get("lines") or []
    model = payload.get("model") or config.DEFAULT_MODEL
    if model not in config.MODELS:
        raise HTTPException(400, f"未知模型：{model}")

    voices = {v["id"]: v for v in config.read_json(config.VOICES_JSON)}
    lines = []
    for raw in raw_lines[:80]:
        text = (raw.get("text") or "").strip()
        if not text:
            continue
        vid = raw.get("voice_id") or ""
        line = {"text": text, "instruct": None, "ref_path": None, "ref_text": None, "speaker": "旁白"}
        if vid:
            v = voices.get(vid)
            if v is None:
                raise HTTPException(400, f"音色不存在：{vid}")
            line["speaker"] = v["name"]
            line["instruct"] = (v.get("instruct") or "").strip() or None
            line["ref_text"] = (v.get("ref_text") or "").strip() or None
            if v.get("has_ref"):
                rp = config.VOICES_DIR / f"{vid}.wav"
                if rp.exists():
                    line["ref_path"] = str(rp)
        lines.append(line)
    if not lines:
        raise HTTPException(400, "至少需要一行台词")

    return jobs.submit({
        "dialogue": lines, "mode": "dialogue", "model": model,
        "cfg": float(payload.get("cfg") or 4.0), "seed": int(payload.get("seed") or 42),
        "normalize": bool(payload.get("normalize", True)),
        "gap": min(2.0, max(0.0, float(payload.get("gap") if payload.get("gap") is not None else 0.25))),
        "speed": min(2.0, max(0.5, float(payload.get("speed") or 1.0))),
        "format": "mp3" if payload.get("format") == "mp3" else "wav",
    }, pipeline_stages=config.DIALOGUE_STAGES)


# ---------------- 任务查询 / 取消 / 再生成 ----------------

@router.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    job = jobs.get(job_id)
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
        "queue_position": jobs.QUEUE.qsize() if job["status"] == "queued" else None,
    }


@router.delete("/api/jobs/{job_id}")
async def cancel_job(job_id: str):
    jobs.cancel(job_id)
    return {"ok": True}


@router.post("/api/jobs/{job_id}/rerun")
async def rerun_job(job_id: str):
    return jobs.rerun(job_id)
