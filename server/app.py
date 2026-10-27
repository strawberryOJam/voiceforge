"""应用工厂：组装 FastAPI 应用、注册路由与异常处理、挂载前端构建产物。"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .routers import history, library, synthesis, system


def create_app() -> FastAPI:
    app = FastAPI(title="声铸 VoiceForge · 本地语音工坊", docs_url=None, redoc_url=None)

    for r in (system.router, synthesis.router, library.router, history.router):
        app.include_router(r)

    @app.exception_handler(HTTPException)
    async def http_exc_handler(_, exc: HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    # 前端：托管 React 构建产物 frontend/dist
    dist_dir = Path(__file__).resolve().parent.parent / "frontend" / "dist"
    if dist_dir.exists():
        app.mount("/", StaticFiles(directory=dist_dir, html=True), name="dist")
    else:
        @app.get("/")
        async def index():
            return JSONResponse({"hint": "前端未构建：cd frontend && npm install && npm run build"})

    return app
