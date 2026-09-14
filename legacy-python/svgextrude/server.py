"""Local web UI.

    python -m svgextrude.server            # http://127.0.0.1:8765

The server is a thin shell around svgextrude.render: it holds the uploaded SVG
bytes in memory, forwards parameters to the renderer and returns PNG bytes.
No rendering logic lives here.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import io
import os
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any, Dict, Optional

from .params import RenderParams, default_params, load_presets
from .render import encode_png, render

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
EXAMPLE_DIR = ROOT / "examples"

_STORE: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()


def _store_svg(name: str, data: bytes) -> Dict[str, Any]:
    key = hashlib.sha1(data).hexdigest()[:16]
    _STORE[key] = {"name": name, "data": data}
    return {"id": key, "name": name}


def _load_examples() -> None:
    if not EXAMPLE_DIR.is_dir():
        return
    for path in sorted(EXAMPLE_DIR.glob("*.svg")):
        _store_svg(path.name, path.read_bytes())


def _params_from_payload(payload: Dict[str, Any]) -> RenderParams:
    base = default_params()
    merged = {**base.to_dict(), **(payload or {})}
    return RenderParams.from_dict(merged)


def build_app():
    try:
        from fastapi import Body, FastAPI, File, HTTPException, UploadFile
        from fastapi.responses import FileResponse, JSONResponse, Response
        from fastapi.staticfiles import StaticFiles
    except ImportError as exc:  # pragma: no cover
        raise SystemExit(
            "FastAPI is required for the UI: pip install fastapi uvicorn python-multipart"
        ) from exc

    _load_examples()
    app = FastAPI(title="iiSU Icon Maker")
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")

    @app.get("/")
    def index():
        return FileResponse(str(WEB_DIR / "index.html"))

    @app.get("/api/state")
    def state():
        return {
            "defaults": default_params().to_dict(),
            "presets": load_presets(),
            "sources": [{"id": k, "name": v["name"]} for k, v in _STORE.items()],
        }

    @app.post("/api/svg")
    async def upload(file: UploadFile = File(...)):
        data = await file.read()
        if not data.strip():
            raise HTTPException(400, "empty file")
        if b"<svg" not in data[:4096].lower():
            raise HTTPException(400, "that does not look like an SVG file")
        return _store_svg(file.filename or "icon.svg", data)

    @app.post("/api/render")
    def do_render(payload: Dict[str, Any] = Body(...)):
        src = _STORE.get(str(payload.get("id", "")))
        if src is None:
            raise HTTPException(404, "unknown source; upload the SVG again")
        params = _params_from_payload(payload.get("params") or {})
        if payload.get("mode") == "preview":
            size = int(payload.get("preview_size") or 640)
            params = dataclasses.replace(params, canvas_size=max(128, min(size, 1600)))
        t0 = time.time()
        with _LOCK:
            try:
                result = render(src["data"], params)
            except Exception as exc:
                raise HTTPException(400, str(exc))
        png = encode_png(result.image)
        headers = {
            "X-Render-Ms": str(int((time.time() - t0) * 1000)),
            "X-Canvas-Size": str(params.canvas_size),
            "X-Warnings": "; ".join(result.warnings),
            "Content-Disposition":
                f'attachment; filename="{Path(src["name"]).stem}_extruded.png"',
        }
        return Response(content=png, media_type="image/png", headers=headers)

    return app


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="svgextrude.server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)

    import uvicorn
    url = f"http://{args.host}:{args.port}/"
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print(f"svgextrude UI on {url}")
    uvicorn.run(build_app(), host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
