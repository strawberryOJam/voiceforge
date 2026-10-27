"""任务系统：队列、工作线程、四类任务（合成/对话/模型切换/模型下载）的执行与生命周期。"""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import threading
import time
from pathlib import Path

import numpy as np

from . import config, engine

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
QUEUE: queue.Queue[str] = queue.Queue()


# ---------------- 提交与查询 ----------------

def submit(params: dict, pipeline_stages=None) -> dict:
    """创建任务并入队，返回 {job_id, queue_position}。"""
    job_id = config.uuid_hex()
    job = {
        "id": job_id,
        "status": "queued",
        "phase": "排队中",
        "progress": {"done": 0, "total": 0},
        "pipeline": {"current": 0, "stages": pipeline_stages or config.PIPELINE_STAGES},
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "result": None,
        "error": None,
        "params": params,
    }
    with JOBS_LOCK:
        JOBS[job_id] = job
        if len(JOBS) > config.MAX_JOBS_KEPT:
            done_ids = [k for k, v in JOBS.items() if v["status"] in ("done", "error", "cancelled")]
            for k in done_ids[: len(JOBS) - config.MAX_JOBS_KEPT]:
                JOBS.pop(k, None)
    QUEUE.put(job_id)
    return {"job_id": job_id, "queue_position": QUEUE.qsize()}


def get(job_id: str) -> dict | None:
    return JOBS.get(job_id)


def cancel(job_id: str) -> None:
    from fastapi import HTTPException

    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "任务不存在或已被清理")
    if job["status"] == "queued":
        job["status"] = "cancelled"
        job["finished_at"] = time.time()
        return
    raise HTTPException(400, "任务已在运行，无法取消")


def rerun(job_id: str) -> dict:
    from fastapi import HTTPException

    old = JOBS.get(job_id)
    if old is None:
        raise HTTPException(404, "任务不存在或已被清理")
    if "model_task" in old["params"]:
        raise HTTPException(400, "模型切换任务请直接使用模型切换")
    p = json.loads(json.dumps(old["params"]))  # 深拷贝，JSON 安全
    if p.get("ref_audio") and not p.get("ref_is_library") and not Path(p["ref_audio"]).exists():
        raise HTTPException(400, "原任务的参考音频是临时文件，已失效，请重新上传或改用音色库")
    return submit(p)


# ---------------- 执行 ----------------

def _worker() -> None:
    while True:
        job_id = QUEUE.get()
        job = JOBS.get(job_id)
        if job is not None and job.get("status") != "cancelled":
            _run(job)
        QUEUE.task_done()


threading.Thread(target=_worker, daemon=True, name="tts-worker").start()


def _run(job: dict) -> None:
    p = job["params"]
    job["started_at"] = time.time()
    job["status"] = "running"
    try:
        if "model_task" in p:
            _run_model_task(job)
        elif "download_task" in p:
            _run_download_task(job)
        elif "dialogue" in p:
            _run_dialogue(job)
        else:
            _run_synthesis(job)
    finally:
        job["finished_at"] = time.time()


def _finish(job: dict, result: dict) -> None:
    job["result"] = result
    job["status"] = "done"
    job["phase"] = "完成"
    if job.get("pipeline"):
        job["pipeline"]["current"] = len(job["pipeline"].get("stages", config.PIPELINE_STAGES)) - 1


def _fail(job: dict, exc: Exception, prefix: str) -> None:
    job["status"] = "error"
    job["error"] = str(exc)
    print(f"[job {job['id']}] {prefix}：{exc}", flush=True)


def _run_model_task(job: dict) -> None:
    p = job["params"]
    job["pipeline"] = {"current": 1}
    job["phase"] = "切换模型"
    try:
        engine.load_model_cached(p["model_task"])
        _finish(job, {"loaded": p["model_task"]})
    except Exception as exc:  # noqa: BLE001
        _fail(job, exc, "切换模型失败")


def _run_download_task(job: dict) -> None:
    p = job["params"]
    job["pipeline"] = {"current": 1, "stages": config.DOWNLOAD_STAGES}
    job["phase"] = "下载模型"
    try:
        entry = config.MODELS.get(p["download_task"])
        if entry is None or not entry.get("repo"):
            raise RuntimeError("该模型没有配置下载仓库")
        dest = Path(os.path.expanduser(str(entry["path"])))
        dest.mkdir(parents=True, exist_ok=True)
        from huggingface_hub import snapshot_download

        snapshot_download(repo_id=entry["repo"], local_dir=str(dest))
        _finish(job, {"downloaded": p["download_task"]})
    except Exception as exc:  # noqa: BLE001
        _fail(job, exc, "模型下载失败")


def _run_synthesis(job: dict) -> None:
    p = job["params"]
    ref_tmp = p.get("ref_audio")
    ref_is_library = bool(p.get("ref_is_library"))
    try:
        job["phase"] = "加载模型"
        job["pipeline"] = {"current": 1}
        model = engine.load_model_cached(p["model"])

        segments = engine.split_segments(p["text"]) if p["auto_split"] else [p["text"]]
        job["progress"] = {"done": 0, "total": len(segments)}
        job["phase"] = "合成中"
        job["pipeline"] = {
            "current": 3,
            "stages": config.PIPELINE_STAGES,
            "segments": [{"text": s[:60], "status": "pending"} for s in segments],
        }

        t0 = time.time()
        pieces, sr = [], 24000
        for i, seg in enumerate(segments):
            if job["pipeline"].get("segments"):
                job["pipeline"]["segments"][i]["status"] = "running"
            audio, sr = engine.gen_one(
                model, seg, p["instruct"], ref_tmp, p["ref_text"], p["cfg"], p["seed"],
            )
            pieces.append(audio)
            job["progress"] = {"done": i + 1, "total": len(segments)}
            if job["pipeline"].get("segments"):
                job["pipeline"]["segments"][i]["status"] = "done"

        audio = _concat(pieces, sr, p["gap"], job, single_ok=True)
        if p["normalize"]:
            job["pipeline"]["current"] = 5
            job["phase"] = "响度归一化"

        elapsed = time.time() - t0
        duration = len(audio) / sr
        stamp = time.strftime("%Y%m%d-%H%M%S")
        tag = "clone" if ref_tmp else "design"
        result = engine.write_result(
            audio, sr, p, f"{stamp}_{job['id'][:4]}_{tag}_{p['model']}",
        )
        result.update({
            "elapsed": round(elapsed, 1),
            "rtf": round(elapsed / duration, 2) if duration else None,
            "segments": len(segments),
        })
        _finish(job, result)
    except Exception as exc:  # noqa: BLE001
        _fail(job, exc, "失败")
    finally:
        if ref_tmp and not ref_is_library:
            Path(ref_tmp).unlink(missing_ok=True)


def _run_dialogue(job: dict) -> None:
    p = job["params"]
    lines = p["dialogue"]
    try:
        job["pipeline"] = {"current": 1}
        job["phase"] = "加载模型"
        model = engine.load_model_cached(p["model"])

        job["phase"] = "逐句合成"
        job["pipeline"] = {
            "current": 3,
            "stages": config.DIALOGUE_STAGES,
            "segments": [{"text": f"{l['speaker']}：{l['text']}"[:60], "status": "pending"} for l in lines],
        }
        job["progress"] = {"done": 0, "total": len(lines)}

        t0 = time.time()
        pieces, sr = [], 24000
        for i, line in enumerate(lines):
            job["pipeline"]["segments"][i]["status"] = "running"
            audio, sr = engine.gen_one(
                model, line["text"], line.get("instruct"), line.get("ref_path"),
                line.get("ref_text"), p["cfg"], p["seed"],
            )
            pieces.append(audio)
            job["progress"] = {"done": i + 1, "total": len(lines)}
            job["pipeline"]["segments"][i]["status"] = "done"

        audio = _concat(pieces, sr, p["gap"], job, single_ok=True)
        if p["normalize"]:
            job["pipeline"]["current"] = 5
            job["phase"] = "响度归一化"

        elapsed = time.time() - t0
        duration = len(audio) / sr
        stamp = time.strftime("%Y%m%d-%H%M%S")
        result = engine.write_result(
            audio, sr, p, f"{stamp}_{job['id'][:4]}_dialogue_{p['model']}",
        )
        result.update({
            "elapsed": round(elapsed, 1),
            "rtf": round(elapsed / duration, 2) if duration else None,
            "segments": len(lines),
            "dialogue": True,
        })
        _finish(job, result)
    except Exception as exc:  # noqa: BLE001
        _fail(job, exc, "对话配音失败")


def _concat(pieces: list, sr: int, gap: float, job: dict, single_ok: bool):
    """多段拼接（句间静音）；单段直通。"""
    if len(pieces) == 1:
        return pieces[0]
    job["pipeline"]["current"] = 4
    job["phase"] = "拼接静音"
    gap_samples = max(0, int(float(gap) * sr))
    parts = []
    for i, piece in enumerate(pieces):
        parts.append(piece)
        if i != len(pieces) - 1 and gap_samples:
            parts.append(np.zeros(gap_samples, dtype=piece.dtype))
    return np.concatenate(parts)
