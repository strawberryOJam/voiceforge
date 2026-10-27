"""引擎层：MLX 模型加载、分段、逐句合成、音频后处理。

只依赖 config，不感知 HTTP 与任务系统；任务系统通过 jobs.py 调用本模块。
MLX 的 GPU stream 绑定线程，所有推理必须由 jobs 的工作线程串行调用。
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
import soundfile as sf
from mlx_audio.audio_io import write as audio_write
from mlx_audio.tts.utils import load_model

from . import config

# 已加载模型状态（含锁；跨线程访问必须持锁）
STATE = {"name": None, "model": None}
LOCK = threading.Lock()


def load_model_cached(name: str):
    """按名加载并缓存模型；切换时释放旧模型显存。"""
    with LOCK:
        if STATE["name"] == name and STATE["model"] is not None:
            return STATE["model"]
        if STATE["model"] is not None:
            STATE["model"] = None
            mx.clear_cache()
        t0 = time.time()
        model = load_model(config.MODELS[name]["path"])
        STATE.update(name=name, model=model)
        print(f"[load] {name} in {time.time() - t0:.1f}s", flush=True)
        return model


def unload_model() -> None:
    with LOCK:
        STATE["model"] = None
        STATE["name"] = None
        mx.clear_cache()


def split_segments(text: str) -> list[str]:
    """按句末标点切分，纯标点段并入上一句。"""
    text = text.replace("……", "…").strip()
    parts, out = config._SENT_END.split(text), []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if config._PUNCT_ONLY.match(p):
            if out:
                out[-1] += p
            continue
        out.append(p)
    return out or [text]


def gen_one(model, text, instruct, ref_audio, ref_text, cfg_scale, seed):
    """单段合成，返回 (audio, sample_rate)。"""
    kwargs = dict(
        text=text,
        instruct=instruct,
        cfg_scale=float(cfg_scale),
        seed=int(seed),
        split_pattern=None,  # 分段由调用方控制
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


def convert_to_wav(src: str) -> str:
    """把 m4a/aac/mp3 等转成单声道 24kHz WAV；已是 wav 则原样返回。"""
    p = Path(src)
    if p.suffix.lower() == ".wav":
        return src
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("参考音频为 " + (p.suffix or "未知") + " 格式，需要 ffmpeg 转换为 WAV，请先安装 ffmpeg")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        dst = f.name
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(p),
             "-ar", "24000", "-ac", "1", dst],
            check=True, capture_output=True,
        )
        return dst
    except Exception:
        Path(dst).unlink(missing_ok=True)
        raise RuntimeError("参考音频转 WAV 失败（ffmpeg 无法解码 " + (p.suffix or "该格式") + "）")


def ffmpeg_finish(audio: np.ndarray, sr: int, normalize: bool, speed: float,
                  fmt: str, base: Path, target: float = -16.0) -> Path:
    """响度归一化 + 语速调整 + 编码（wav/mp3），写出到 base 对应扩展名并返回最终路径。"""
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


def write_result(audio: np.ndarray, sr: int, params: dict, base_name: str) -> dict:
    """统一后处理 + 落盘，返回 result 字典（普通合成与对话配音共用）。"""
    path = ffmpeg_finish(
        audio, sr, params["normalize"], params.get("speed", 1.0),
        params.get("format", "wav"),
        config.OUT_DIR / base_name,
        float(config.SETTINGS["loudness_target"]),
    )
    duration = len(audio) / sr
    result = {
        "name": path.name,
        "url": f"/files/{path.name}",
        "duration": round(duration, 2),
        "sample_rate": sr,
        "gap": float(params["gap"]),
        "normalized": bool(params["normalize"]),
        "model": params["model"],
        "speed": float(params.get("speed", 1.0)),
        "format": path.suffix.lstrip("."),
    }
    return result
