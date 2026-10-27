"""配置层：路径、设置、模型清单、通用常量与工具函数。

所有模块通过 ``config.OUT_DIR`` / ``config.SETTINGS`` 运行时访问，
避免 from-import 绑定旧值（输出目录可被设置接口热更新）。
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path

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

# ---------------- 模型配置 ----------------

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

MODELS: dict[str, dict] = dict(DEFAULT_MODELS)
SETTINGS: dict = dict(DEFAULT_SETTINGS)
DEFAULT_MODEL = "4bit"


def _load_json_file(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            pass
    return default


MODELS.update({k: v for k, v in (_load_json_file(MODELS_JSON, {}) or {}).items() if k not in MODELS})
SETTINGS.update({k: v for k, v in (_load_json_file(SETTINGS_PATH, {}) or {}).items() if k in DEFAULT_SETTINGS})

OUT_DIR = Path(os.path.expanduser(str(SETTINGS["output_dir"])))
OUT_DIR.mkdir(parents=True, exist_ok=True)


def set_output_dir(path: Path) -> None:
    global OUT_DIR
    OUT_DIR = path


def save_settings() -> None:
    SETTINGS_PATH.write_text(json.dumps(SETTINGS, ensure_ascii=False, indent=2), "utf-8")


def save_models() -> None:
    custom = {k: v for k, v in MODELS.items() if not v.get("builtin")}
    MODELS_JSON.write_text(json.dumps(custom, ensure_ascii=False, indent=2), "utf-8")


# ---------------- 生成标签与分段 ----------------

TAGS_ZH = ["[笑]", "[叹气]", "[停顿]", "[耳语]", "[清嗓]", "[抽泣]", "[哼歌]"]
TAGS_EN = ["(laughs)", "(sighs)", "(pause)", "(whispers)", "(clears throat)", "(sobs)", "(humming)"]

_SENT_END = re.compile(r"(?<=[。！？!?；;…])")
_PUNCT_ONLY = re.compile(r"^[…。！？!?；;，,、\s]+$")

_SAFE_NAME = re.compile(r"^[\w\-.\u4e00-\u9fff（）()]+\.(wav|mp3)$")
_SAFE_ID = re.compile(r"^[a-f0-9]{12}$")

PIPELINE_STAGES = ["排队", "加载模型", "文稿分段", "逐句合成", "拼接静音", "响度归一化", "完成"]
DIALOGUE_STAGES = ["排队", "加载模型", "台词解析", "逐句合成", "拼接静音", "响度归一化", "完成"]
DOWNLOAD_STAGES = ["排队", "下载模型", "完成"]

MAX_JOBS_KEPT = 50


# ---------------- 工具函数 ----------------

def b(value) -> bool:
    return str(value).lower() in ("true", "1", "on", "yes")


def uuid_hex(n: int = 12) -> str:
    return uuid.uuid4().hex[:n]


def read_json(path: Path) -> list:
    if path.exists():
        try:
            data = json.loads(path.read_text("utf-8"))
            if isinstance(data, list):
                return data
        except Exception:  # noqa: BLE001
            pass
    return []


def write_json(path: Path, items: list) -> None:
    path.write_text(json.dumps(items, ensure_ascii=False, indent=2), "utf-8")


def all_outputs() -> list[Path]:
    files = list(OUT_DIR.glob("*.wav")) + list(OUT_DIR.glob("*.mp3"))
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)


def check_output_name(name: str) -> Path:
    from fastapi import HTTPException

    if not _SAFE_NAME.match(name or ""):
        raise HTTPException(400, "非法文件名")
    p = OUT_DIR / name
    if not p.exists():
        raise HTTPException(404, "文件不存在")
    return p


def model_view(entry: dict) -> dict:
    """模型配置的对外视图（含路径存在性）。"""
    return {
        "name": entry["name"],
        "path": str(entry["path"]),
        "repo": entry.get("repo") or "",
        "builtin": bool(entry.get("builtin")),
        "exists": Path(os.path.expanduser(str(entry["path"]))).exists(),
    }


def memory_gb():
    try:
        import resource

        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 ** 3), 2)
    except Exception:  # noqa: BLE001
        return None


def fmt_day(ts: float) -> str:
    return time.strftime("%m-%d %H:%M", time.localtime(ts))
