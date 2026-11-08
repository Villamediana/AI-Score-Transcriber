"""
App Flask: transcrição de áudio para MIDI com Basic Pitch.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import logging
import threading
import warnings
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_file, render_template, flash, redirect, url_for, session
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

# Adiciona ao PATH os sítios onde o Deno costuma ficar. O yt-dlp-ejs precisa
# dele para resolver o desafio JS do YouTube, e o PATH do daemon PM2 não vê
# instalações feitas depois do arranque do daemon. Fazê-lo aqui garante que
# funciona independentemente de como o gunicorn foi lançado.
for _p in ("/root/.deno/bin", "/root/.local/bin"):
    if _p not in os.environ.get("PATH", "").split(os.pathsep) and os.path.isdir(_p):
        os.environ["PATH"] = _p + os.pathsep + os.environ.get("PATH", "")

# O PM2 corre em Node.js e exporta NODE_CHANNEL_FD para comunicar com os
# filhos por pipe IPC. Quando o yt-dlp-ejs lança o Deno, o Deno vê essa
# variável, pensa que é filho dum pai Node.js e tenta abrir o fd 3 como pipe -
# mas no gunicorn o fd 3 é outra coisa. Resultado: "Failed to open IPC channel
# from NODE_CHANNEL_FD (3)", e o YouTube devolve zero formatos. Descartar
# estas variáveis torna o Deno num processo normal.
for _v in ("NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"):
    os.environ.pop(_v, None)

load_dotenv()

from transcribe.basic_pitch_module import (
    transcribe_to_midi as basic_pitch_transcribe,
    TranscribeOptions,
    SENSITIVITY_PRESETS,
    INSTRUMENT_RANGES,
    warm_up as warm_up_model,
)
from jobs import get_manager, DONE as JOB_DONE, ERROR as JOB_ERROR
import store

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-change-in-production")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB
UPLOAD_FOLDER = Path(app.root_path) / "uploads"
UPLOAD_FOLDER.mkdir(exist_ok=True)
RESULTS_FOLDER = Path(app.root_path) / "results"
RESULTS_FOLDER.mkdir(exist_ok=True)
EXAMPLE_FOLDER = Path(app.root_path) / "example"
DATA_FOLDER = Path(app.root_path) / "data"
store.init(DATA_FOLDER / "app.db")
ALLOWED_EXTENSIONS = {"wav", "mp3", "flac", "ogg", "m4a", "webm"}
YOUTUBE_DOMAINS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"}

logger = logging.getLogger("noteai")
if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter("[AI Score Transcriber] %(levelname)s | %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
logger.setLevel(logging.INFO)
logger.propagate = False

# Silencia logs muito verbosos de bibliotecas externas.
logging.getLogger().setLevel(logging.ERROR)
logging.getLogger("tensorflow").setLevel(logging.ERROR)
logging.getLogger("absl").setLevel(logging.ERROR)
logging.getLogger("werkzeug").setLevel(logging.WARNING)
warnings.filterwarnings("ignore", category=FutureWarning, module=r".*librosa.*")
warnings.filterwarnings("ignore", message=r".*urllib3.*doesn't match.*")
try:
    from requests.exceptions import RequestsDependencyWarning
    warnings.filterwarnings("ignore", category=RequestsDependencyWarning)
except ImportError:
    pass


# ── Fila de transcrições e pré-aquecimento ────────────────────────────────
JOBS_FOLDER = Path(app.root_path) / "results" / ".jobs"
job_manager = get_manager(persist_dir=JOBS_FOLDER)

_model_ready = threading.Event()


def _warm_up_in_background() -> None:
    """
    Carregar o ONNX e compilar o JIT do numba custa ~15 s. Fazer isso durante o
    arranque, e não à frente do primeiro utilizador que aparecer.
    """
    def run():
        started = time.time()
        try:
            warm_up_model()
            logger.info("Modelo pronto em %.1f s", time.time() - started)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Falhou o pré-aquecimento: %s", exc)
        finally:
            _model_ready.set()

    threading.Thread(target=run, daemon=True, name="model-warmup").start()


_warm_up_in_background()


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[-1].lower() in ALLOWED_EXTENSIONS


def is_ajax_request() -> bool:
    return request.headers.get("X-Requested-With") == "XMLHttpRequest"


def _safe_user_message(msg: str, generic: str = "An error occurred. Please try again.") -> str:
    """Retorna mensagem segura para a UI, sem tracebacks ou detalhes técnicos."""
    if not msg:
        return generic
    bad = ("Traceback", "File ", "runpy", "  File ", "  at ", ".py:", "Error:", "Exception:")
    if any(b in msg for b in bad) or len(msg) > 150:
        return generic
    return msg


def error_response(message: str, status_code: int = 400):
    safe_msg = _safe_user_message(message)
    if is_ajax_request():
        return jsonify({"error": safe_msg}), status_code
    flash(safe_msg, "error")
    return redirect(url_for("index"))


def is_youtube_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False
    host = parsed.netloc.lower()
    return host in YOUTUBE_DOMAINS or host.endswith(".youtube.com") or host.endswith(".youtu.be")


def cleanup_old_result_files(max_age_seconds: int = 60 * 60) -> None:
    """
    Varre os resultados órfãos. Os que pertencem a um link guardado ficam - é o
    que faz um link partilhado continuar a tocar o áudio original durante os
    dias seguintes, em vez de morrer ao fim de uma hora.
    """
    now = time.time()
    try:
        protected = store.live_result_ids()
    except Exception:  # noqa: BLE001 - a limpeza nunca pode derrubar um pedido
        protected = set()
    for file_path in RESULTS_FOLDER.glob("*"):
        try:
            if not file_path.is_file():
                continue
            if file_path.name.split("_", 1)[0] in protected:
                continue
            if now - file_path.stat().st_mtime > max_age_seconds:
                file_path.unlink()
        except OSError:
            pass


def delete_result_assets(result_id: str | None) -> None:
    if not result_id:
        return
    # Nunca apagar por baixo de um link que alguém possa ter guardado.
    try:
        if store.project_for_result(result_id):
            return
    except Exception:  # noqa: BLE001
        pass
    patterns = (
        f"{result_id}_original.*",
        f"{result_id}_preview.wav",
        f"{result_id}_transcribed.mid",
        f"{result_id}_midi_preview.wav",
    )
    for pattern in patterns:
        for file_path in RESULTS_FOLDER.glob(pattern):
            try:
                file_path.unlink()
            except OSError:
                pass


# Formatos que qualquer browser toca sem ajuda: para estes não guardamos o WAV
# de 22 kHz (um tema de 4 min ocupa ~10 MB no disco do telemóvel e é servido
# inteiro por cima do túnel). Só os formatos duvidosos ficam com fallback.
BROWSER_PLAYABLE = {".mp3", ".m4a", ".wav", ".ogg", ".webm", ".mp4", ".aac"}


def save_result_assets(
    audio_path: Path,
    preview_audio_path: Path,
    midi_bytes: bytes,
) -> tuple[str, bool]:
    """Guarda o áudio de origem e o MIDI. Devolve (result_id, tem_fallback_wav)."""
    result_id = uuid.uuid4().hex
    source_suffix = audio_path.suffix.lower() or ".audio"

    def copy_fresh(src: Path, dst: Path) -> None:
        # shutil.copy (sem o 2) não herda a data de modificação da origem.
        # Com copy2, um sample antigo do repositório dava origem a um resultado
        # que já nascia "velho" e a limpeza por idade apagava-o de imediato.
        shutil.copy(src, dst)
        os.utime(dst, None)

    copy_fresh(audio_path, RESULTS_FOLDER / f"{result_id}_original{source_suffix}")
    (RESULTS_FOLDER / f"{result_id}_transcribed.mid").write_bytes(midi_bytes)

    needs_fallback = source_suffix not in BROWSER_PLAYABLE
    if needs_fallback and preview_audio_path and preview_audio_path.exists():
        copy_fresh(preview_audio_path, RESULTS_FOLDER / f"{result_id}_preview.wav")
    return result_id, needs_fallback


def get_audio_duration_seconds(audio_path: Path) -> float:
    """Retorna a duração em segundos do ficheiro de áudio."""
    try:
        import soundfile as sf
        info = sf.info(str(audio_path))
        return float(info.duration)
    except Exception:
        return 0.0


def convert_audio_to_wav(input_audio_path: Path) -> Path:
    """Converte qualquer input de áudio para WAV PCM, aumentando compatibilidade."""
    print(f"[WAV 1] A converter: {input_audio_path}")
    try:
        import imageio_ffmpeg
    except ImportError as exc:
        raise RuntimeError(
            "Missing dependency to convert audio. Run: pip install imageio-ffmpeg"
        ) from exc

    fd, output_wav = tempfile.mkstemp(suffix=".wav", dir=str(UPLOAD_FOLDER))
    os.close(fd)
    output_wav_path = Path(output_wav)

    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        ffmpeg_exe,
        "-y",
        "-i",
        str(input_audio_path),
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "22050",
        "-ac",
        "1",
        str(output_wav_path),
    ]
    result = subprocess.run(command, capture_output=True)
    if result.returncode != 0 or not output_wav_path.exists():
        if output_wav_path.exists():
            output_wav_path.unlink(missing_ok=True)
        print(f"[WAV 1] ERRO: ffmpeg returncode={result.returncode}")
        raise RuntimeError(
            "Could not process the audio from this file/link. Try another video or format."
        )
    print(f"[WAV 1] OK: {output_wav_path}")
    return output_wav_path


def download_youtube_audio(youtube_url: str) -> tuple[Path, str]:
    logger.info("A descarregar áudio do YouTube...")
    try:
        import yt_dlp
    except ImportError as exc:
        raise RuntimeError(
            "Missing dependency: install 'yt-dlp' to use YouTube URLs."
        ) from exc

    out_id = uuid.uuid4().hex
    output_template = str(UPLOAD_FOLDER / f"{out_id}.%(ext)s")
    ydl_opts = {
        # Preferimos o melhor só-áudio; se não existir cai para o formato 18 (mp4
        # combinado, AAC ~96 kbps) que aparece sempre e chega para o Basic Pitch.
        "format": "bestaudio/best[format_id=18]/best",
        "outtmpl": output_template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "m4a", "preferredquality": "0"},
        ],
        # Resolve o desafio JS do YouTube com o Deno (~40 MB em /root/.deno).
        # Sem isto ficamos limitados ao formato 18.
        "remote_components": ["ejs:github"],
        # web_embedded é dos poucos clientes que devolve formatos só-áudio SEM PO
        # Token; se falhar cai para tv_simply e para o web (fmt 18). É o que
        # torna isto capaz de correr sem cookies.
        "extractor_args": {"youtube": {"player_client": ["web_embedded", "tv_simply", "web"]}},
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        },
    }

    # Cookies: em produção, o YouTube muitas vezes bloqueia sem sessão.
    # Definir YOUTUBE_COOKIES_FILE para o caminho de um ficheiro cookies.txt (Netscape).
    cookies_path = os.environ.get("YOUTUBE_COOKIES_FILE", "").strip()
    if cookies_path:
        cookie_file = Path(cookies_path)
        if cookie_file.is_file():
            ydl_opts["cookiefile"] = str(cookie_file)
            logger.info("A usar ficheiro de cookies para o YouTube.")
        else:
            logger.warning("YOUTUBE_COOKIES_FILE definido mas ficheiro não existe: %s", cookies_path)

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(youtube_url, download=True)
        downloaded_path = ydl.prepare_filename(info)

    audio_path = Path(downloaded_path)
    # FFmpegExtractAudio converte para .m4a; o ficheiro final pode ter extensão diferente
    if not audio_path.exists():
        audio_path = audio_path.with_suffix(".m4a")
    if not audio_path.exists():
        raise RuntimeError("Failed to download audio from YouTube.")

    source_title = secure_filename(info.get("title", "")).strip("_-") or "youtube_audio"
    return audio_path, source_title


@app.after_request
def add_cors_headers(response):
    """Allow cross-origin requests so mobile/tablet work when URL differs (e.g. IP vs hostname)."""
    origin = request.environ.get("HTTP_ORIGIN")
    if origin:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
    else:
        response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Accept, X-Requested-With"
    return response



@app.route("/transcribe", methods=["OPTIONS"])
def transcribe_options():
    """CORS preflight for POST /transcribe (needed by some browsers on mobile/tablet)."""
    return "", 204


def _youtube_cookies_available() -> bool:
    """Cookies são reforço opcional; já não são requisito."""
    path = os.environ.get("YOUTUBE_COOKIES_FILE", "").strip()
    return bool(path and Path(path).is_file())


def _youtube_enabled() -> bool:
    """O separador Link aparece quando o Deno está no PATH (destranca formatos
    só-áudio via web_embedded) OU quando há cookies. Pode ser desligado com
    YOUTUBE_ENABLED=0."""
    if os.environ.get("YOUTUBE_ENABLED", "").strip() == "0":
        return False
    if _youtube_cookies_available():
        return True
    return shutil.which("deno") is not None


# Versão dos estáticos: muda a cada arranque, para o browser não servir CSS/JS
# velhos depois de um deploy.
ASSET_VERSION = str(int(time.time()))


@app.route("/")
def index():
    return render_template(
        "index.html",
        youtube_enabled=_youtube_enabled(),
        max_upload_mb=app.config["MAX_CONTENT_LENGTH"] // (1024 * 1024),
        asset_version=ASSET_VERSION,
        bootstrap_token=None,
    )


# ── Projetos guardados (links partilháveis) ───────────────────────────────

TOKEN_CHARS = set(store.TOKEN_ALPHABET)


def _valid_token(token: str) -> bool:
    return bool(token) and len(token) <= 24 and set(token) <= TOKEN_CHARS


def _project_media_urls(token: str) -> dict:
    """URLs públicas de um projeto. À mão porque o url_for, fora do contexto de
    pedido (o worker), exigiria SERVER_NAME - e estas rotas são triviais."""
    base = f"/p/{token}"
    return {
        "share_path": base,
        "original_audio_url": f"{base}/audio",
        "midi_preview_url": f"{base}/midi",
        "midi_download_url": f"{base}/midi?download=1",
        "original_download_url": f"{base}/audio?download=1",
    }


@app.route("/p/<token>")
def project_page(token: str):
    """A mesma aplicação, mas a arrancar já com um trabalho guardado."""
    if not _valid_token(token) or store.get_project(token) is None:
        flash("That link has expired or does not exist.", "error")
        return redirect(url_for("index"))
    return render_template(
        "index.html",
        youtube_enabled=_youtube_enabled(),
        max_upload_mb=app.config["MAX_CONTENT_LENGTH"] // (1024 * 1024),
        asset_version=ASSET_VERSION,
        bootstrap_token=token,
    )


@app.route("/api/p/<token>", methods=["GET"])
def project_data(token: str):
    if not _valid_token(token):
        return jsonify({"error": "Invalid link."}), 404
    project = store.get_project(token)
    if project is None:
        return jsonify({"error": "That link has expired or does not exist."}), 404
    store.touch(token)

    payload = dict(project["payload"])
    payload["token"] = token
    payload.update(_project_media_urls(token))
    payload["version"] = project["version"]
    payload["created_at"] = project["created_at"]
    payload["updated_at"] = project["updated_at"]

    edits = project["edits"] or {}
    edited_notes = edits.get("notes")
    if edited_notes:
        # As edições substituem as notas originais; o original fica disponível
        # para quem quiser voltar atrás.
        payload["original_note_events"] = payload.get("note_events")
        payload["note_events"] = edited_notes
        payload["has_edits"] = True
        meta = edits.get("meta") or {}
        if meta.get("bpm"):
            payload["bpm"] = meta["bpm"]
        if meta.get("time_signature"):
            payload["time_signature"] = meta["time_signature"]
    else:
        payload["has_edits"] = False

    # O áudio de origem tem prazo; a pauta não.
    audio_alive = bool(list(RESULTS_FOLDER.glob(f"{project['result_id']}_original.*")))
    payload["audio_available"] = audio_alive
    return jsonify(payload)


@app.route("/api/p/<token>/notes", methods=["POST", "PUT"])
def project_save_notes(token: str):
    """Gravação automática da pauta editada. Quem tem o link pode gravar."""
    if not _valid_token(token):
        return jsonify({"error": "Invalid link."}), 404
    body = request.get_json(silent=True) or {}
    notes = body.get("notes")
    if not isinstance(notes, list):
        return jsonify({"error": "Missing notes."}), 400
    if len(notes) > 20000:
        return jsonify({"error": "That score is too large to save."}), 413

    clean: list[dict] = []
    for n in notes:
        if not isinstance(n, dict):
            continue
        try:
            start = float(n.get("start_time", n.get("start")))
            end = float(n.get("end_time", n.get("end")))
            pitch = int(n.get("pitch"))
        except (TypeError, ValueError):
            continue
        if not (0 <= pitch <= 127) or end <= start:
            continue
        conf = n.get("confidence", n.get("velocity"))
        try:
            conf = float(conf)
        except (TypeError, ValueError):
            conf = 0.8
        clean.append({
            "start_time": round(start, 4),
            "end_time": round(end, 4),
            "pitch": pitch,
            "confidence": round(max(0.0, min(1.0, conf)), 4),
        })

    meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
    saved = store.save_notes(token, clean, meta)
    if saved is None:
        return jsonify({"error": "That link has expired or does not exist."}), 404
    return jsonify({"ok": True, "version": saved["version"], "saved_notes": len(clean)})


@app.route("/api/p/<token>/notes", methods=["DELETE"])
def project_reset_notes(token: str):
    """Deita fora as edições e volta à transcrição original."""
    if not _valid_token(token) or not store.clear_notes(token):
        return jsonify({"error": "That link has expired or does not exist."}), 404
    return jsonify({"ok": True})


@app.route("/p/<token>/midi")
def project_midi(token: str):
    if not _valid_token(token):
        return jsonify({"error": "Invalid link."}), 404
    data = store.get_midi(token)
    if data is None:
        return jsonify({"error": "That link has expired or does not exist."}), 404
    project = store.get_project(token) or {}
    name = (project.get("payload") or {}).get("midi_filename") or "transcription.mid"
    return send_file(
        BytesIO(data),
        mimetype="audio/midi",
        as_attachment=request.args.get("download") == "1",
        download_name=name,
    )


@app.route("/p/<token>/audio")
def project_audio(token: str):
    """Áudio de origem de um projeto. Expira; a pauta continua sem ele."""
    if not _valid_token(token):
        return jsonify({"error": "Invalid link."}), 404
    project = store.get_project(token)
    if project is None:
        return jsonify({"error": "That link has expired or does not exist."}), 404

    result_id = project["result_id"]
    download = request.args.get("download") == "1"
    if (project["payload"] or {}).get("playback_kind") == "preview-audio":
        preview = RESULTS_FOLDER / f"{result_id}_preview.wav"
        if preview.exists():
            return send_file(str(preview), mimetype="audio/wav",
                             as_attachment=download, download_name=preview.name)
    matches = list(RESULTS_FOLDER.glob(f"{result_id}_original.*"))
    if not matches:
        return jsonify({"error": "The original audio for this link has expired."}), 410
    return send_file(str(matches[0]), as_attachment=download, download_name=matches[0].name)


@app.route("/results/<result_id>/<kind>")
def result_media(result_id: str, kind: str):
    cleanup_old_result_files()
    if session.get("active_result_id") != result_id:
        return jsonify({"error": "Result not found for this session."}), 404
    download = request.args.get("download") == "1"

    if kind == "midi":
        target = RESULTS_FOLDER / f"{result_id}_transcribed.mid"
        if not target.exists():
            return jsonify({"error": "Result not found or expired."}), 404
        return send_file(
            str(target),
            mimetype="audio/midi",
            as_attachment=download,
            download_name=f"{result_id}_transcribed.mid",
        )

    if kind == "original":
        matches = list(RESULTS_FOLDER.glob(f"{result_id}_original.*"))
        if not matches:
            return jsonify({"error": "Result not found or expired."}), 404
        original_path = matches[0]
        return send_file(
            str(original_path),
            as_attachment=download,
            download_name=original_path.name,
        )

    if kind == "preview-audio":
        target = RESULTS_FOLDER / f"{result_id}_preview.wav"
        if target.exists():
            return send_file(
                str(target),
                mimetype="audio/wav",
                as_attachment=download,
                download_name=f"{result_id}_preview.wav",
            )
        # Formatos que o browser toca sozinho não geram WAV de fallback.
        matches = list(RESULTS_FOLDER.glob(f"{result_id}_original.*"))
        if matches:
            return send_file(str(matches[0]), as_attachment=download, download_name=matches[0].name)
        return jsonify({"error": "Result not found or expired."}), 404

    return jsonify({"error": "Invalid media type."}), 400


@app.route("/results/reset", methods=["POST"])
def reset_result():
    cleanup_old_result_files()
    payload = request.get_json(silent=True) or {}
    requested_result_id = payload.get("result_id")
    active_result_id = session.get("active_result_id")
    target_result_id = active_result_id or requested_result_id

    if active_result_id and requested_result_id and requested_result_id != active_result_id:
        return jsonify({"error": "Invalid result for this session."}), 400

    delete_result_assets(target_result_id)
    session.pop("active_result_id", None)
    return jsonify({"ok": True})


def _load_example_metadata() -> dict:
    """Carrega example/metadata.json: lista de { "song": "nome.mp3", "category": "...", "difficulty": 1-5 }."""
    meta_path = EXAMPLE_FOLDER / "metadata.json"
    if not meta_path.is_file():
        return {}
    try:
        import json
        with open(meta_path, encoding="utf-8") as f:
            data = json.load(f)
        out = {}
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and item.get("song"):
                    name = item["song"].strip()
                    if name:
                        out[name] = {
                            "category": (item.get("category") or "").strip() or None,
                            "difficulty": item.get("difficulty"),
                        }
        elif isinstance(data, dict):
            for k, v in data.items():
                if isinstance(v, dict) and k:
                    out[k] = {"category": v.get("category"), "difficulty": v.get("difficulty")}
        return out
    except (json.JSONDecodeError, OSError):
        return {}


@app.route("/api/examples", methods=["GET"])
def list_examples():
    """Lista ficheiros de áudio na pasta example (nome, filename, ext, category, difficulty)."""
    if not EXAMPLE_FOLDER.is_dir():
        return jsonify({"examples": []})
    meta = _load_example_metadata()
    examples = []
    for p in sorted(EXAMPLE_FOLDER.iterdir()):
        if p.is_file() and allowed_file(p.name):
            name = p.stem.replace("_", " ").strip()
            ext = p.suffix.lower()
            info = meta.get(p.name) or {}
            category = (info.get("category") or "").strip() or None
            difficulty = info.get("difficulty")
            if difficulty is not None:
                try:
                    d = int(difficulty)
                    difficulty = max(1, min(5, d))
                except (TypeError, ValueError):
                    difficulty = None
            examples.append({
                "name": name,
                "filename": p.name,
                "ext": ext,
                "category": category,
                "difficulty": difficulty,
            })
    return jsonify({"examples": examples})


def _audio_mimetype(filename: str) -> str:
    ext = (Path(filename).suffix or "").lower()
    mime = {"mp3": "audio/mpeg", "wav": "audio/wav", "flac": "audio/flac", "ogg": "audio/ogg", "m4a": "audio/mp4", "webm": "audio/webm"}
    return mime.get(ext.lstrip("."), "application/octet-stream")


@app.route("/api/examples/audio/<path:filename>", methods=["GET"])
def serve_example_audio(filename: str):
    """Serve um ficheiro de áudio da pasta example para preview (reprodução)."""
    safe = Path(filename).name
    if not safe or safe != filename:
        return jsonify({"error": "Invalid filename"}), 400
    file_path = EXAMPLE_FOLDER / safe
    if not file_path.is_file() or not allowed_file(safe):
        return jsonify({"error": "Not found"}), 404
    return send_file(str(file_path), mimetype=_audio_mimetype(safe), as_attachment=False)


def _parse_options(form) -> TranscribeOptions:
    """Lê as definições de transcrição do formulário, com defaults seguros."""
    sensitivity = (form.get("sensitivity") or "balanced").strip().lower()
    if sensitivity not in SENSITIVITY_PRESETS:
        sensitivity = "balanced"
    instrument = (form.get("instrument") or "auto").strip().lower()
    if instrument not in INSTRUMENT_RANGES:
        instrument = "auto"
    quantize = (form.get("quantize") or "auto").strip().lower()
    if quantize not in ("off", "auto", "strict"):
        quantize = "auto"
    return TranscribeOptions(sensitivity=sensitivity, instrument=instrument, quantize=quantize)


def _session_job_ids() -> list[str]:
    ids = session.get("job_ids")
    return list(ids) if isinstance(ids, list) else []


def _remember_job(job_id: str) -> None:
    ids = _session_job_ids()
    if job_id not in ids:
        ids.append(job_id)
    session["job_ids"] = ids[-10:]


def _run_transcription(
    handle,
    *,
    source_kind: str,
    source_value: str,
    upload_path: Path | None,
    base: str,
    options: TranscribeOptions,
) -> dict:
    """
    Corre no worker de background. Nada aqui pode tocar em `request` ou `session`.
    Devolve o payload que o cliente vai receber quando o job ficar pronto.
    """
    audio_path: Path | None = upload_path
    wav_path: Path | None = None

    try:
        if source_kind == "youtube":
            handle.update(0.05, "Fetching the audio")
            audio_path, base = download_youtube_audio(source_value)
            handle.update(0.18, "Audio downloaded")
        elif source_kind == "example":
            handle.update(0.08, "Loading the sample")

        if audio_path is None or not audio_path.exists():
            raise RuntimeError("The audio could not be read.")

        handle.update(0.22, "Preparing the audio")
        wav_path = convert_audio_to_wav(audio_path)
        duration = get_audio_duration_seconds(wav_path)
        handle.update(0.28, "Audio ready")

        result = basic_pitch_transcribe(
            str(wav_path),
            options=options,
            progress=handle.span(0.30, 0.88),
            stage=lambda msg: handle.update(stage=msg),
            cancel_check=handle.check_cancelled,
            duration=duration,
        )

        handle.update(0.92, "Saving the result")
        result_id, has_wav_fallback = save_result_assets(audio_path, wav_path, result.midi_bytes)

        original_suffix = (audio_path.suffix or "").lower()
        playback_kind = "preview-audio" if has_wav_fallback else "original"

        payload = {
            "result_id": result_id,
            "playback_kind": playback_kind,
            "midi_filename": f"{base}_transcribed.mid",
            "source_name": base,
            "note_events": result.note_events,
            "note_events_total": len(result.note_events),
            "note_events_truncated": False,
            "time_signature": {"numerator": result.time_signature[0], "denominator": result.time_signature[1]},
            "bpm": result.bpm,
            "beat_offset": result.beat_offset,
            "beat_times": result.beat_times,
            "audio_duration": duration,
            "audio_format": original_suffix.lstrip("."),
            "options": {
                "sensitivity": options.sensitivity,
                "instrument": options.instrument,
                "quantize": options.quantize,
            },
            "audio_expires_in_days": store.AUDIO_TTL_SECONDS // 86400,
        }

        # O trabalho passa a ter morada própria: a partir daqui existe um link
        # que abre isto tal e qual, em qualquer dispositivo, sem sessão. Se a
        # base de dados falhar, a transcrição não se perde por causa disso -
        # fica só sem link, servida pela sessão como antes.
        payload = dict(payload)
        try:
            token = store.create_project(result_id, payload, result.midi_bytes)
            payload["token"] = token
            payload.update(_project_media_urls(token))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Não foi possível guardar o projeto: %s", exc)
            media = f"/results/{result_id}"
            payload.update({
                "original_audio_url": f"{media}/{playback_kind}",
                "midi_preview_url": f"{media}/midi",
                "midi_download_url": f"{media}/midi?download=1",
                "original_download_url": f"{media}/original?download=1",
            })

        handle.update(0.99, "Done")
        return payload

    finally:
        for tmp in (audio_path, wav_path):
            if tmp and tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass


@app.route("/transcribe", methods=["POST"])
def transcribe():
    """
    Aceita o pedido, guarda o ficheiro e devolve um job_id de imediato.
    O trabalho pesado corre no worker; o cliente segue em /api/jobs/<id>.
    """
    cleanup_old_result_files()
    job_manager.cleanup()
    try:
        store.prune()
    except Exception:  # noqa: BLE001
        pass

    file = request.files.get("audio")
    media_url = (request.form.get("youtube_url") or request.form.get("media_url") or "").strip()
    example_filename = (request.form.get("example") or "").strip()
    has_file = bool(file and file.filename)
    has_media_url = bool(media_url)
    has_example = bool(example_filename)

    if sum([has_file, has_media_url, has_example]) > 1:
        return error_response("Choose only one: upload a file, paste a URL, or pick an example.")
    if not (has_file or has_media_url or has_example):
        return error_response("Upload an audio file, enter a YouTube URL, or choose an example.")

    options = _parse_options(request.form)
    upload_path: Path | None = None
    base = "audio"
    source_kind = "upload"
    source_value = ""

    # O ficheiro tem de sair do request agora - o worker já não tem contexto HTTP.
    if has_example:
        safe_example = Path(example_filename).name
        example_path = EXAMPLE_FOLDER / safe_example
        if not example_path.is_file() or not allowed_file(safe_example):
            return error_response("Invalid example.")
        upload_path = UPLOAD_FOLDER / f"{uuid.uuid4().hex}_{safe_example}"
        shutil.copy(str(example_path), str(upload_path))
        base = secure_filename(Path(safe_example).stem) or "audio"
        source_kind = "example"
        source_value = safe_example
    elif has_media_url:
        if not is_youtube_url(media_url):
            return error_response("Invalid URL. Use a YouTube link.")
        source_kind = "youtube"
        source_value = media_url
        base = "youtube_audio"
    else:
        if not allowed_file(file.filename):
            return error_response(
                f"Format not allowed. Use: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
            )
        ext = file.filename.rsplit(".", 1)[-1].lower()
        upload_path = UPLOAD_FOLDER / f"{uuid.uuid4().hex}.{ext}"
        file.save(str(upload_path))
        base = secure_filename(Path(file.filename).stem) or "audio"

    logger.info("Job submetido: kind=%s base=%s opts=%s", source_kind, base, options.sensitivity)

    def work(handle):
        # O worker corre fora do ciclo do pedido; o url_for precisa de contexto de app.
        with app.app_context():
            return _run_transcription(
                handle,
                source_kind=source_kind,
                source_value=source_value,
                upload_path=upload_path,
                base=base,
                options=options,
            )

    job = job_manager.submit(work)
    _remember_job(job.id)

    payload = job.public()
    payload["poll_url"] = url_for("job_status", job_id=job.id)
    return jsonify(payload), 202


@app.route("/api/jobs/<job_id>", methods=["GET"])
def job_status(job_id: str):
    if job_id not in _session_job_ids():
        return jsonify({"error": "Job not found."}), 404
    job = job_manager.get(job_id)
    if job is None:
        return jsonify({"error": "Job not found or expired."}), 404

    payload = job.public()
    # O worker não tem sessão: é aqui, no pedido do dono, que o resultado passa
    # a estar autorizado para download.
    if job.status == JOB_DONE and job.result:
        result_id = job.result.get("result_id")
        if result_id:
            previous = session.get("active_result_id")
            if previous and previous != result_id:
                delete_result_assets(previous)
            session["active_result_id"] = result_id
    if job.status == JOB_ERROR:
        payload["error"] = _safe_user_message(job.error or "", "Transcription failed. Try another file.")
    return jsonify(payload)


@app.route("/api/jobs/<job_id>/cancel", methods=["POST"])
def job_cancel(job_id: str):
    if job_id not in _session_job_ids():
        return jsonify({"error": "Job not found."}), 404
    ok = job_manager.cancel(job_id)
    return jsonify({"ok": ok})


@app.route("/api/health", methods=["GET"])
def health():
    stats = job_manager.stats()
    stats["model_ready"] = _model_ready.is_set()
    try:
        stats.update(store.stats())
    except Exception:  # noqa: BLE001
        pass
    return jsonify(stats)


@app.errorhandler(RequestEntityTooLarge)
def handle_file_too_large(e):
    del e
    max_mb = app.config["MAX_CONTENT_LENGTH"] // (1024 * 1024)
    return error_response(f"File too large. Limit: {max_mb} MB.", status_code=413)


if __name__ == "__main__":
    app.run(debug=False, host="127.0.0.1", port=5000)
