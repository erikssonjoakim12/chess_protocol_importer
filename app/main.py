"""Web server: serves the page and a small JSON API."""
import os
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv()

from .readers import ReaderError  # noqa: E402
from .service import process, read_photos  # noqa: E402

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")
MAX_TOTAL_BYTES = 18 * 1024 * 1024  # Gemini accepts ~20 MB of inline data per request

app = FastAPI(title="Protokoll till PGN")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class Ply(BaseModel):
    text: str = ""
    alternatives: List[str] = []
    clock: str = ""
    unclear: bool = False
    confirmed: bool = False
    written_number: Optional[int] = None
    page: Optional[int] = None


class ProcessRequest(BaseModel):
    headers: Dict[str, str] = {}
    plies: List[Ply] = []
    end_marker: Optional[Dict[str, Any]] = None


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.post("/api/read")
async def api_read(files: List[UploadFile] = File(...), careful: bool = Form(False)):
    images, total = [], 0
    for f in files:
        data = await f.read()
        total += len(data)
        images.append((data, f.content_type or "image/jpeg"))
    if not images:
        raise HTTPException(400, "No photos uploaded.")
    if total > MAX_TOTAL_BYTES:
        raise HTTPException(413, "The photos are too large together (%.1f MB)." % (total / 1e6))
    try:
        return read_photos(images, careful=careful)
    except ReaderError as e:
        raise HTTPException(502, str(e))


@app.post("/api/process")
def api_process(req: ProcessRequest):
    plies = [p.model_dump() for p in req.plies]
    return process(req.headers, plies, req.end_marker)
