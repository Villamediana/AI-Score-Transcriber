"""
Persistência das transcrições em SQLite.

Cada transcrição terminada ganha um token curto e passa a viver aqui. O que
justifica uma base de dados em vez de ficheiros soltos:

  * o link tem de continuar a abrir depois de o browser fechar, noutro
    dispositivo e sem sessão;
  * as edições da pauta são guardadas por cima, com um contador de versão que
    evita que dois separadores abertos se pisem;
  * o MIDI original (poucos KB) fica cá dentro, por isso um link nunca fica
    "meio partido" - o áudio de origem é que expira, porque é o que pesa.

Uma ligação nova por operação: o gunicorn corre com várias threads e o worker
das transcrições é outra ainda; partilhar uma ligação entre elas é a receita
para "SQLite objects created in a thread...".
"""
from __future__ import annotations

import json
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

TOKEN_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
TOKEN_LENGTH = 10

# Quanto tempo o áudio de origem sobrevive. A pauta e o MIDI não expiram.
AUDIO_TTL_SECONDS = 14 * 24 * 3600
# Ao fim disto sem ninguém abrir, o projeto é apagado de vez.
PROJECT_TTL_SECONDS = 180 * 24 * 3600

_DB_PATH: Optional[Path] = None


def init(db_path: Path) -> None:
    global _DB_PATH
    _DB_PATH = Path(db_path)
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as con:
        con.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS projects (
                token       TEXT PRIMARY KEY,
                result_id   TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL,
                opened_at   INTEGER NOT NULL,
                version     INTEGER NOT NULL DEFAULT 0,
                source_name TEXT,
                payload     TEXT NOT NULL,
                notes       TEXT,
                midi        BLOB
            );
            CREATE INDEX IF NOT EXISTS idx_projects_result ON projects(result_id);
            CREATE INDEX IF NOT EXISTS idx_projects_opened ON projects(opened_at);
            """
        )


def _connect() -> sqlite3.Connection:
    if _DB_PATH is None:
        raise RuntimeError("store.init() não foi chamado")
    con = sqlite3.connect(str(_DB_PATH), timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=15000")
    return con


def _new_token() -> str:
    return "".join(secrets.choice(TOKEN_ALPHABET) for _ in range(TOKEN_LENGTH))


# ── Escrita ────────────────────────────────────────────────────────────────

def create_project(result_id: str, payload: dict[str, Any], midi_bytes: bytes | None) -> str:
    """Guarda uma transcrição acabada de sair e devolve o token do link."""
    now = int(time.time())
    blob = json.dumps(payload, separators=(",", ":"))
    with _connect() as con:
        for _ in range(5):
            token = _new_token()
            try:
                con.execute(
                    "INSERT INTO projects (token, result_id, created_at, updated_at, opened_at,"
                    " version, source_name, payload, notes, midi)"
                    " VALUES (?,?,?,?,?,0,?,?,NULL,?)",
                    (token, result_id, now, now, now,
                     payload.get("source_name"), blob, midi_bytes),
                )
                return token
            except sqlite3.IntegrityError:
                continue  # colisão de token: praticamente impossível, mas barato de tratar
    raise RuntimeError("Não foi possível gerar um token único")


def save_notes(token: str, notes: list[dict], meta: dict[str, Any] | None = None) -> Optional[dict]:
    """
    Grava a versão editada da pauta. Devolve o novo estado, ou None se o token
    não existir.
    """
    now = int(time.time())
    body = json.dumps({"notes": notes, "meta": meta or {}}, separators=(",", ":"))
    with _connect() as con:
        cur = con.execute(
            "UPDATE projects SET notes=?, updated_at=?, opened_at=?, version=version+1"
            " WHERE token=?",
            (body, now, now, token),
        )
        if cur.rowcount == 0:
            return None
        row = con.execute("SELECT version, updated_at FROM projects WHERE token=?", (token,)).fetchone()
    return {"version": row["version"], "updated_at": row["updated_at"]}


def clear_notes(token: str) -> bool:
    """Volta à transcrição original, deitando fora as edições."""
    now = int(time.time())
    with _connect() as con:
        cur = con.execute(
            "UPDATE projects SET notes=NULL, updated_at=?, version=version+1 WHERE token=?",
            (now, token),
        )
        return cur.rowcount > 0


def touch(token: str) -> None:
    with _connect() as con:
        con.execute("UPDATE projects SET opened_at=? WHERE token=?", (int(time.time()), token))


# ── Leitura ────────────────────────────────────────────────────────────────

def get_project(token: str) -> Optional[dict]:
    with _connect() as con:
        row = con.execute(
            "SELECT token, result_id, created_at, updated_at, version, source_name, payload, notes"
            " FROM projects WHERE token=?",
            (token,),
        ).fetchone()
    if row is None:
        return None
    try:
        payload = json.loads(row["payload"])
    except (TypeError, ValueError):
        return None
    edits = None
    if row["notes"]:
        try:
            edits = json.loads(row["notes"])
        except (TypeError, ValueError):
            edits = None
    return {
        "token": row["token"],
        "result_id": row["result_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "version": row["version"],
        "source_name": row["source_name"],
        "payload": payload,
        "edits": edits,
    }


def get_midi(token: str) -> Optional[bytes]:
    with _connect() as con:
        row = con.execute("SELECT midi FROM projects WHERE token=?", (token,)).fetchone()
    return bytes(row["midi"]) if row and row["midi"] is not None else None


def project_for_result(result_id: str) -> Optional[str]:
    """Token do projeto dono deste result_id, se existir."""
    with _connect() as con:
        row = con.execute(
            "SELECT token FROM projects WHERE result_id=? ORDER BY created_at DESC LIMIT 1",
            (result_id,),
        ).fetchone()
    return row["token"] if row else None


def live_result_ids() -> set[str]:
    """
    result_ids cujo áudio de origem ainda deve ser mantido em disco. É isto que
    impede a limpeza horária de comer os ficheiros de links partilhados.
    """
    cutoff = int(time.time()) - AUDIO_TTL_SECONDS
    with _connect() as con:
        rows = con.execute(
            "SELECT result_id FROM projects WHERE created_at >= ?", (cutoff,)
        ).fetchall()
    return {r["result_id"] for r in rows}


def stats() -> dict:
    with _connect() as con:
        row = con.execute("SELECT COUNT(*) AS n, SUM(notes IS NOT NULL) AS edited FROM projects").fetchone()
    return {"projects": row["n"] or 0, "projects_edited": row["edited"] or 0}


# ── Manutenção ─────────────────────────────────────────────────────────────

def prune() -> int:
    """Apaga projetos que ninguém abre há muito tempo. Devolve quantos saíram."""
    cutoff = int(time.time()) - PROJECT_TTL_SECONDS
    with _connect() as con:
        cur = con.execute("DELETE FROM projects WHERE opened_at < ?", (cutoff,))
        return cur.rowcount
