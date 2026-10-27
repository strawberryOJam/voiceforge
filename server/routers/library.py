"""素材库路由：音色库（含参考音频存取）与文稿模板。"""

from __future__ import annotations

import shutil
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import config, engine

router = APIRouter()


def _check_voice(vid: str) -> dict:
    if not config._SAFE_ID.match(vid or ""):
        raise HTTPException(400, "非法音色 ID")
    item = next((v for v in config.read_json(config.VOICES_JSON) if v.get("id") == vid), None)
    if item is None:
        raise HTTPException(404, "音色不存在")
    return item


# ---------------- 音色库 ----------------

@router.get("/api/voices")
async def list_voices():
    return {"items": config.read_json(config.VOICES_JSON)}


@router.post("/api/voices")
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

    vid = config.uuid_hex()
    has_ref = False
    if ref_audio is not None and ref_audio.filename:
        suffix = Path(ref_audio.filename).suffix or ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(await ref_audio.read())
            tmp_ref = f.name
        try:
            wav_path = engine.convert_to_wav(tmp_ref)
            shutil.move(wav_path, config.VOICES_DIR / f"{vid}.wav")
            has_ref = True
        except RuntimeError as exc:
            raise HTTPException(400, str(exc))
        finally:
            Path(tmp_ref).unlink(missing_ok=True)
    elif ref_voice_id:
        src = config.VOICES_DIR / f"{ref_voice_id}.wav"
        if src.exists():
            shutil.copyfile(src, config.VOICES_DIR / f"{vid}.wav")
            has_ref = True

    items = config.read_json(config.VOICES_JSON)
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
    config.write_json(config.VOICES_JSON, items[:200])
    return {"ok": True, "voice": item}


@router.get("/api/voices/{vid}/ref")
async def voice_ref(vid: str):
    _check_voice(vid)
    p = config.VOICES_DIR / f"{vid}.wav"
    if not p.exists():
        raise HTTPException(404, "该音色没有参考音频")
    return FileResponse(p, media_type="audio/wav")


@router.delete("/api/voices/{vid}")
async def delete_voice(vid: str):
    _check_voice(vid)
    items = [v for v in config.read_json(config.VOICES_JSON) if v.get("id") != vid]
    config.write_json(config.VOICES_JSON, items)
    (config.VOICES_DIR / f"{vid}.wav").unlink(missing_ok=True)
    return {"ok": True}


# ---------------- 文稿模板 ----------------

@router.get("/api/templates")
async def list_templates():
    return {"items": config.read_json(config.TEMPLATES_JSON)}


@router.post("/api/templates")
async def add_template(payload: dict):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "模板名称不能为空")
    items = config.read_json(config.TEMPLATES_JSON)
    item = {
        "id": config.uuid_hex(),
        "name": name[:40],
        "mode": payload.get("mode") or "design",
        "text": (payload.get("text") or "").strip(),
        "instruct": (payload.get("instruct") or "").strip(),
        "created": time.strftime("%m-%d %H:%M"),
    }
    items.insert(0, item)
    config.write_json(config.TEMPLATES_JSON, items[:200])
    return {"ok": True, "template": item}


@router.delete("/api/templates/{tid}")
async def delete_template(tid: str):
    if not config._SAFE_ID.match(tid or ""):
        raise HTTPException(400, "非法模板 ID")
    items = [t for t in config.read_json(config.TEMPLATES_JSON) if t.get("id") != tid]
    config.write_json(config.TEMPLATES_JSON, items)
    return {"ok": True}
