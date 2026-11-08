"""
Fila de transcrições em background.

O cliente faz POST /transcribe, recebe um job_id de imediato e vai buscando o
progresso a /api/jobs/<id>. Nada de pedidos HTTP pendurados durante minutos.

Corre in-process (gunicorn com 1 worker), com um único worker de execução —
o servidor é um telemóvel e o modelo ONNX não gosta de concorrência.
"""
from __future__ import annotations

import json
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from queue import Queue
from typing import Any, Callable, Optional

QUEUED = "queued"
RUNNING = "running"
DONE = "done"
ERROR = "error"
CANCELLED = "cancelled"

# Um job morre 1h depois de terminar (igual à expiração dos ficheiros de resultado).
JOB_TTL_SECONDS = 60 * 60


class JobCancelled(Exception):
    """Levantada dentro do worker quando o cliente desiste do job."""


@dataclass
class Job:
    id: str
    status: str = QUEUED
    progress: float = 0.0          # 0.0 -> 1.0
    stage: str = "Queued"
    result: Optional[dict] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    queue_position: int = 0
    # Não vai para o cliente:
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)
    _fn: Optional[Callable] = field(default=None, repr=False)

    def public(self) -> dict:
        d = {
            "job_id": self.id,
            "status": self.status,
            "progress": round(self.progress, 4),
            "stage": self.stage,
            "queue_position": self.queue_position,
        }
        if self.started_at:
            d["elapsed"] = round((self.finished_at or time.time()) - self.started_at, 1)
        if self.status == DONE and self.result is not None:
            d["result"] = self.result
        if self.status == ERROR:
            d["error"] = self.error or "Transcription failed."
        return d


class JobManager:
    def __init__(self, persist_dir: Path | None = None):
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._queue: Queue[str] = Queue()
        self._persist_dir = persist_dir
        if self._persist_dir:
            self._persist_dir.mkdir(exist_ok=True, parents=True)
        self._worker = threading.Thread(target=self._run_loop, daemon=True, name="transcribe-worker")
        self._worker.start()

    # ---------- API pública ----------

    def submit(self, fn: Callable[["JobHandle"], dict]) -> Job:
        """fn recebe um JobHandle (para reportar progresso) e devolve o payload final."""
        job = Job(id=uuid.uuid4().hex, _fn=fn)
        with self._lock:
            self._jobs[job.id] = job
            self._reindex_queue_positions()
        self._queue.put(job.id)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None and self._persist_dir:
                job = self._load_persisted(job_id)
            return job

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.status in (DONE, ERROR, CANCELLED):
                return False
            job._cancel.set()
            if job.status == QUEUED:
                job.status = CANCELLED
                job.stage = "Cancelled"
                job.finished_at = time.time()
            return True

    def cleanup(self) -> None:
        now = time.time()
        with self._lock:
            stale = [
                jid for jid, j in self._jobs.items()
                if j.finished_at and now - j.finished_at > JOB_TTL_SECONDS
            ]
            for jid in stale:
                self._jobs.pop(jid, None)
            self._reindex_queue_positions()
        if self._persist_dir:
            for f in self._persist_dir.glob("*.json"):
                try:
                    if now - f.stat().st_mtime > JOB_TTL_SECONDS:
                        f.unlink()
                except OSError:
                    pass

    def stats(self) -> dict:
        with self._lock:
            running = sum(1 for j in self._jobs.values() if j.status == RUNNING)
            queued = sum(1 for j in self._jobs.values() if j.status == QUEUED)
        return {"running": running, "queued": queued}

    # ---------- interno ----------

    def _reindex_queue_positions(self) -> None:
        """Chamado com o lock preso."""
        waiting = sorted(
            [j for j in self._jobs.values() if j.status == QUEUED],
            key=lambda j: j.created_at,
        )
        for i, j in enumerate(waiting):
            j.queue_position = i + 1

    def _run_loop(self) -> None:
        while True:
            job_id = self._queue.get()
            with self._lock:
                job = self._jobs.get(job_id)
            if job is None or job._cancel.is_set():
                continue

            job.status = RUNNING
            job.started_at = time.time()
            job.queue_position = 0
            job.stage = "Starting"
            job.progress = 0.02
            with self._lock:
                self._reindex_queue_positions()

            handle = JobHandle(job)
            try:
                result = job._fn(handle)
                if job._cancel.is_set():
                    job.status = CANCELLED
                    job.stage = "Cancelled"
                else:
                    job.result = result
                    job.status = DONE
                    job.stage = "Done"
                    job.progress = 1.0
            except JobCancelled:
                job.status = CANCELLED
                job.stage = "Cancelled"
            except Exception as exc:  # noqa: BLE001 - o worker nunca pode morrer
                job.status = ERROR
                job.stage = "Failed"
                job.error = str(exc)[:300] or "Transcription failed."
                traceback.print_exc()
            finally:
                job.finished_at = time.time()
                job._fn = None
                self._persist(job)

    def _persist(self, job: Job) -> None:
        if not self._persist_dir or job.status != DONE:
            return
        try:
            payload = {k: v for k, v in asdict(job).items() if not k.startswith("_")}
            (self._persist_dir / f"{job.id}.json").write_text(json.dumps(payload))
        except (OSError, TypeError):
            pass

    def _load_persisted(self, job_id: str) -> Optional[Job]:
        if not self._persist_dir:
            return None
        f = self._persist_dir / f"{job_id}.json"
        if not f.is_file():
            return None
        try:
            data = json.loads(f.read_text())
        except (OSError, ValueError):
            return None
        job = Job(id=data.get("id", job_id))
        for key in ("status", "progress", "stage", "result", "error",
                    "created_at", "started_at", "finished_at"):
            if key in data and data[key] is not None:
                setattr(job, key, data[key])
        return job


class JobHandle:
    """O que a função de trabalho usa para reportar progresso e ver cancelamentos."""

    def __init__(self, job: Job):
        self._job = job

    @property
    def id(self) -> str:
        return self._job.id

    def check_cancelled(self) -> None:
        if self._job._cancel.is_set():
            raise JobCancelled()

    def update(self, progress: float | None = None, stage: str | None = None) -> None:
        self.check_cancelled()
        if progress is not None:
            # Nunca deixar a barra andar para trás - é o que mais irrita quem espera.
            self._job.progress = max(self._job.progress, min(0.99, float(progress)))
        if stage is not None:
            self._job.stage = stage

    def span(self, start: float, end: float) -> Callable[[float], None]:
        """Devolve um callback que mapeia 0..1 para o intervalo [start, end] da barra global."""
        def report(frac: float) -> None:
            self.update(progress=start + (end - start) * max(0.0, min(1.0, frac)))
        return report


# Instância única da app.
manager: JobManager | None = None


def get_manager(persist_dir: Path | None = None) -> JobManager:
    global manager
    if manager is None:
        manager = JobManager(persist_dir=persist_dir)
    return manager
