"""历史与文件路由：生成记录列表、删除、音频文件服务（WAV/MP3）。"""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import config

router = APIRouter()


@router.get("/api/history")
async def history():
    files = config.all_outputs()
    rows = []
    for f in files[:500]:
        st = f.stat()
        rows.append({
            "name": f.name,
            "size_kb": round(st.st_size / 1024),
            "time": time.strftime("%m-%d %H:%M", time.localtime(st.st_mtime)),
            "url": f"/files/{f.name}",
        })
    return {"count": len(rows), "items": rows, "dir": str(config.OUT_DIR)}


@router.get("/files/{name}")
async def get_file(name: str, download: int = 0):
    p = config.check_output_name(name)
    media = "audio/mpeg" if name.endswith(".mp3") else "audio/wav"
    if download:
        return FileResponse(p, media_type=media, filename=name,
                            headers={"Content-Disposition": f'attachment; filename="{name}"'})
    return FileResponse(p, media_type=media)


@router.delete("/api/history/{name}")
async def delete_history(name: str):
    config.check_output_name(name).unlink()
    return {"ok": True}
