"""Local HTTP bridge: the browser extension hands a page off to this app.

The extension fetches the PDF with the user's own Chrome session and POSTs the
bytes here; we only do the bookkeeping (naming, SI discovery, report).

Binding is loopback-only and web origins are refused, so a random page cannot
use this as a download proxy.
"""

from __future__ import annotations

import json
import queue
import threading
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from . import __version__
from .fetch import fetch as run_fetch

DEFAULT_PORT = 8765
MAX_UPLOAD = 200 * 1024 * 1024


class _QuietServer(ThreadingHTTPServer):
    """Clients that hang up mid-request are normal; do not spam the console."""

    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):  # noqa: D102
        import sys

        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


@dataclass
class Job:
    id: str
    doi: str
    status: str = "queued"  # queued | running | done | error
    pdf_path: str = ""
    workdir: str = ""
    si_count: int = 0
    error: str = ""
    source: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "doi": self.doi,
            "status": self.status,
            "pdf_path": self.pdf_path,
            "workdir": self.workdir,
            "si_count": self.si_count,
            "error": self.error,
            "source": self.source,
        }


class Bridge:
    """Queue + tiny HTTP API in front of the fetch pipeline."""

    def __init__(
        self,
        *,
        port: int = DEFAULT_PORT,
        out_dir: Callable[[], Path] | None = None,
        on_log: Callable[[str], None] | None = None,
        on_done: Callable[[Job], None] | None = None,
    ) -> None:
        self.port = port
        self._out_dir = out_dir
        self.on_log = on_log or (lambda _m: None)
        self.on_done = on_done or (lambda _job: None)

        self.jobs: dict[str, Job] = {}
        self._queue: queue.Queue[tuple[Job, bytes | None, str | None]] = queue.Queue()
        self._server: ThreadingHTTPServer | None = None
        self._worker: threading.Thread | None = None
        self._running = False

    # -- lifecycle ---------------------------------------------------------
    @property
    def running(self) -> bool:
        return self._server is not None

    def start(self) -> bool:
        if self._server is not None:
            return True

        try:
            server = _QuietServer(("127.0.0.1", self.port), _build_handler(self))
        except OSError:
            return False  # port already taken (another instance?)

        self._server = server
        self._running = True

        self._worker = threading.Thread(target=self._work_loop, daemon=True)
        self._worker.start()

        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.on_log(f"浏览器接口就绪：http://127.0.0.1:{self.port}")
        return True

    def stop(self) -> None:
        self._running = False
        if self._server is not None:
            try:
                self._server.shutdown()
            except Exception:
                pass
            self._server = None
        self._queue.put((None, None, None))  # type: ignore[arg-type]

    # -- work --------------------------------------------------------------
    def submit(self, doi: str, pdf: bytes | None = None, landing: str | None = None) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], doi=doi, source="extension" if pdf else "api")
        self.jobs[job.id] = job  # dict insertion is atomic under the GIL
        self._queue.put((job, pdf, landing))
        self.on_log(f"浏览器送来任务：{doi}")
        return job

    def _work_loop(self) -> None:
        while self._running:
            item = self._queue.get()
            if item is None or item[0] is None:
                break
            job, pdf, landing = item
            job.status = "running"
            out = self._out_dir() if self._out_dir else None
            try:
                report = run_fetch(
                    job.doi,
                    out=out,
                    log=self.on_log,
                    provided_pdf=pdf,
                    landing_hint=landing,
                )
                job.workdir = report.workdir
                job.pdf_path = report.pdf_path
                job.si_count = len(report.si_assets)
                if report.ok:
                    job.status = "done"
                else:
                    job.status = "error"
                    job.error = report.pdf_error
            except Exception as exc:
                job.status = "error"
                job.error = f"{type(exc).__name__}: {exc}"
            finally:
                try:
                    self.on_done(job)
                except Exception:
                    pass
                self._queue.task_done()


def _build_handler(bridge: Bridge):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = f"doi-fetch/{__version__}"

        def log_message(self, *_args) -> None:  # keep the console clean
            return

        # -- helpers
        def _origin_allowed(self) -> bool:
            origin = self.headers.get("Origin") or ""
            if not origin:
                return True  # curl / local tools
            return origin.startswith("chrome-extension://") or origin.startswith("moz-extension://")

        def _send(self, code: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()

        # -- routes
        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path

            if path == "/ping":
                self._send(200, {"ok": True, "app": "doi-fetch", "version": __version__})
                return
            if path == "/jobs":
                recent = sorted(bridge.jobs.values(), key=lambda j: j.id)[-20:]
                self._send(200, {"jobs": [j.to_dict() for j in recent]})
                return
            if path.startswith("/job/"):
                job = bridge.jobs.get(path.split("/", 2)[2])
                self._send(200, job.to_dict()) if job else self._send(404, {"error": "unknown job"})
                return
            self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if not self._origin_allowed():
                self._send(403, {"error": "only browser extensions may call this endpoint"})
                return

            path = urlparse(self.path).path
            if path != "/ingest":
                self._send(404, {"error": "not found"})
                return

            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_UPLOAD:
                self._send(413, {"error": "payload too large"})
                return
            body = self.rfile.read(length) if length else b""

            doi = (self.headers.get("X-Doi") or "").strip()
            landing = (self.headers.get("X-Landing") or "").strip() or None
            content_type = (self.headers.get("Content-Type") or "").lower()

            pdf: bytes | None = None
            if content_type.startswith("application/octet-stream"):
                pdf = body or None
            else:
                try:
                    payload = json.loads(body.decode("utf-8")) if body else {}
                except ValueError:
                    self._send(400, {"error": "invalid JSON"})
                    return
                doi = doi or str(payload.get("doi") or "").strip()
                landing = landing or (str(payload.get("url") or "").strip() or None)

            if not doi:
                self._send(400, {"error": "missing doi"})
                return

            try:
                job = bridge.submit(doi, pdf=pdf, landing=landing)
            except Exception as exc:
                self._send(500, {"error": f"{type(exc).__name__}: {exc}"})
                return
            self._send(202, {"job": job.id, "doi": job.doi})

    return Handler


def serve_forever(port: int = DEFAULT_PORT) -> None:
    """Blocking entry point for `doi-fetch serve`."""
    bridge = Bridge(
        port=port, on_log=lambda message: print(f"  {message}", flush=True)
    )
    if not bridge.start():
        raise SystemExit(f"port {port} is already in use")
    print(f"listening on http://127.0.0.1:{port}  (Ctrl+C to stop)", flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        bridge.stop()
