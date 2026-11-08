"""
Transcrição áudio -> MIDI usando Basic Pitch (ONNX), com:

  * modelo carregado uma só vez e reutilizado entre pedidos;
  * previsão por blocos com progresso real (ficheiros longos num telemóvel);
  * andamento e grelha de tempos vindos do librosa, não de uma mediana de onsets;
  * limpeza dos artefactos típicos do Basic Pitch (fragmentação e oitavas-fantasma);
  * quantização opcional à grelha, que é o que torna a pauta legível.
"""
from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from typing import Callable, Optional

# ── Presets ────────────────────────────────────────────────────────────────

# Medidos com uma peça de piano de notas conhecidas (ver o comentário em
# _merge_fragmented): recall / precisão de cada nível são, por esta ordem,
# 72/93, 89/82 e 99/59 por cento. O "balanced" inclina-se para o recall de
# propósito - quem quer a pauta limpa tem o "clean" logo ao lado.
SENSITIVITY_PRESETS = {
    # menos notas, mas quase só as reais
    "clean":    {"onset_threshold": 0.62, "frame_threshold": 0.42, "minimum_note_length": 170.0},
    "balanced": {"onset_threshold": 0.44, "frame_threshold": 0.27, "minimum_note_length": 120.0},
    # apanha ornamentos e notas fracas, ao custo de algum lixo
    "detailed": {"onset_threshold": 0.30, "frame_threshold": 0.19, "minimum_note_length": 85.0},
}

# (min_hz, max_hz) - restringir a gama corta muitíssimo falso positivo
INSTRUMENT_RANGES = {
    "auto":   (None, None),
    "piano":  (27.5, 4186.0),
    "voice":  (75.0, 1200.0),
    "guitar": (73.0, 1400.0),
    "bass":   (30.0, 400.0),
}

CHUNK_SECONDS = 30.0
CHUNK_OVERLAP = 3.0

# Frames por segundo à saída do modelo (22050 / 256), para converter o
# comprimento mínimo de nota de milissegundos para frames.
MODEL_FPS = 22050 / 256


@dataclass
class TranscribeOptions:
    sensitivity: str = "balanced"
    instrument: str = "auto"
    quantize: str = "auto"        # "off" | "auto" | "strict"
    min_note_ms: Optional[float] = None
    remove_octave_ghosts: bool = True

    def preset(self) -> dict:
        preset = dict(SENSITIVITY_PRESETS.get(self.sensitivity, SENSITIVITY_PRESETS["balanced"]))
        if self.min_note_ms is not None:
            preset["minimum_note_length"] = float(self.min_note_ms)
        lo, hi = INSTRUMENT_RANGES.get(self.instrument, (None, None))
        preset["minimum_frequency"] = lo
        preset["maximum_frequency"] = hi
        return preset


# ── Modelo em cache ────────────────────────────────────────────────────────

_MODEL = None


def get_model():
    """Carrega o ONNX uma única vez. O primeiro pedido paga ~2-4 s, os seguintes zero."""
    global _MODEL
    if _MODEL is None:
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import Model
        _MODEL = Model(ICASSP_2022_MODEL_PATH)
    return _MODEL


def warm_up() -> bool:
    """
    Pré-carrega o modelo e paga já a compilação JIT do numba que o beat tracking
    do librosa dispara na primeira chamada (~9 s que ninguém quer esperar a meio
    da sua transcrição).
    """
    ok = True
    try:
        get_model()
    except Exception:
        ok = False
    try:
        import librosa
        import numpy as np
        silence = np.zeros(22050 * 3, dtype=np.float32)
        silence[::2205] = 0.5           # cliques regulares, dão-lhe um pulso a seguir
        librosa.beat.beat_track(y=silence, sr=22050, units="time")
    except Exception:
        pass
    return ok


# ── Normalização dos eventos ───────────────────────────────────────────────

def _normalize_note_events(note_events) -> list[dict]:
    normalized: list[dict] = []
    if not note_events:
        return normalized

    for evt in note_events:
        start_time = end_time = pitch = confidence = None

        if isinstance(evt, dict):
            start_time = evt.get("start_time", evt.get("start"))
            end_time = evt.get("end_time", evt.get("end"))
            pitch = evt.get("pitch", evt.get("midi"))
            confidence = evt.get("confidence", evt.get("amplitude", evt.get("velocity")))
        elif isinstance(evt, (list, tuple)):
            if len(evt) > 0: start_time = evt[0]
            if len(evt) > 1: end_time = evt[1]
            if len(evt) > 2: pitch = evt[2]
            if len(evt) > 3: confidence = evt[3]
        else:
            start_time = getattr(evt, "start_time", getattr(evt, "start", None))
            end_time = getattr(evt, "end_time", getattr(evt, "end", None))
            pitch = getattr(evt, "pitch", getattr(evt, "midi", None))
            confidence = getattr(evt, "confidence", getattr(evt, "amplitude", getattr(evt, "velocity", None)))

        if start_time is None or end_time is None or pitch is None:
            continue

        normalized.append({
            "start_time": float(start_time),
            "end_time": float(end_time),
            "pitch": int(pitch),
            "confidence": float(confidence) if confidence is not None else None,
        })

    normalized.sort(key=lambda e: (e["start_time"], e["pitch"]))
    return normalized


# ── Limpeza ────────────────────────────────────────────────────────────────

# Um buraco tem de ter pelo menos meia frame do modelo (~11,6 ms) para contar
# como fragmentação. Zero exato não é buraco nenhum: é a nota a acabar onde a
# seguinte começa, que é como se ouve uma tecla repetida.
MERGE_MIN_GAP = 0.006
# E uma nota "reconstruída" que passe disto já não é uma nota, é um engano.
MERGE_MAX_RESULT = 8.0


def _merge_fragmented(events: list[dict], max_gap: float = 0.045) -> list[dict]:
    """
    O Basic Pitch parte notas sustentadas em pedaços. Junta pedaços da mesma
    altura separados por um buraco curto - e só esses.

    Duas armadilhas, ambas medidas com uma peça de notas conhecidas:

    1. A condição tem de ser uma *faixa*, não "menor que". Escrita como estava
       (nxt.start - current.end <= max_gap), qualquer par sobreposto dava um
       número negativo, passava sempre, e o fim esticava-se por cima do
       seguinte.
    2. O intervalo tem de ser estritamente positivo. O modelo dá as notas
       repetidas coladas, com gap exatamente 0.000; a fragmentação a sério
       deixa pelo menos uma frame de buraco. Sem esta distinção, dezasseis
       semicolcheias na mesma tecla colapsavam numa nota só.

    As duas juntas valiam metade das notas da pauta: no ensaio, 43% de recall
    contra os 91% que o modelo tinha mesmo encontrado.
    """
    if not events:
        return events
    by_pitch: dict[int, list[dict]] = {}
    for e in events:
        by_pitch.setdefault(e["pitch"], []).append(e)

    merged: list[dict] = []
    for pitch, group in by_pitch.items():
        group.sort(key=lambda e: e["start_time"])
        current = dict(group[0])
        for nxt in group[1:]:
            gap = nxt["start_time"] - current["end_time"]
            joined = max(current["end_time"], nxt["end_time"]) - current["start_time"]
            if MERGE_MIN_GAP <= gap <= max_gap and joined <= MERGE_MAX_RESULT:
                current["end_time"] = max(current["end_time"], nxt["end_time"])
                confs = [c for c in (current.get("confidence"), nxt.get("confidence")) if c is not None]
                if confs:
                    current["confidence"] = max(confs)
            else:
                merged.append(current)
                current = dict(nxt)
        merged.append(current)

    merged.sort(key=lambda e: (e["start_time"], e["pitch"]))
    return merged


def _remove_octave_ghosts(events: list[dict]) -> list[dict]:
    """
    Artefacto clássico: uma oitava acima (ou abaixo) da nota real, sobreposta no
    tempo e com confiança muito menor. Só remove quando é claramente fantasma,
    para não comer oitavas verdadeiras.
    """
    if len(events) < 2:
        return events

    drop: set[int] = set()
    for i, a in enumerate(events):
        ca = a.get("confidence")
        if ca is None:
            continue
        for j in range(i + 1, len(events)):
            b = events[j]
            if b["start_time"] > a["end_time"]:
                break
            if abs(b["pitch"] - a["pitch"]) != 12:
                continue
            cb = b.get("confidence")
            if cb is None:
                continue
            overlap = min(a["end_time"], b["end_time"]) - max(a["start_time"], b["start_time"])
            shortest = min(a["end_time"] - a["start_time"], b["end_time"] - b["start_time"])
            if shortest <= 0 or overlap / shortest < 0.8:
                continue
            # Fasquia apertada: ao piano as oitavas verdadeiras são a regra, e
            # eram elas que desapareciam quando isto era generoso demais.
            if cb < ca * 0.25:
                drop.add(j)
            elif ca < cb * 0.25:
                drop.add(i)

    return [e for k, e in enumerate(events) if k not in drop]


def _drop_short(events: list[dict], min_seconds: float) -> list[dict]:
    return [e for e in events if (e["end_time"] - e["start_time"]) >= min_seconds]


# ── Andamento e grelha ─────────────────────────────────────────────────────

def _detect_tempo_grid(y, sr: int) -> dict:
    """
    Andamento e tempos via librosa. Muito mais fiável do que a mediana dos
    intervalos entre onsets, sobretudo com acordes.
    """
    result = {"bpm": None, "beat_times": [], "beat_offset": 0.0}
    try:
        import librosa
        import numpy as np

        if y is None or y.size < sr // 2:
            return result

        tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
        bpm = float(np.atleast_1d(tempo)[0])

        # O beat tracker gosta de duplicar/metade o andamento; puxar para 60-160.
        while bpm > 0 and bpm < 60:
            bpm *= 2
        while bpm > 180:
            bpm /= 2

        if 30 <= bpm <= 300:
            result["bpm"] = round(bpm, 2)
        beat_times = [float(b) for b in np.atleast_1d(beats)]
        result["beat_times"] = beat_times
        if beat_times:
            result["beat_offset"] = beat_times[0]
    except Exception:
        pass
    return result


def _estimate_bpm(note_events: list[dict]) -> float:
    """Alternativa quando o librosa não consegue (áudio muito curto ou sem pulso)."""
    if not note_events:
        return 120.0
    onsets = sorted(float(e["start_time"]) for e in note_events)
    diffs = [d for i in range(1, min(len(onsets), 200))
             if 0.05 < (d := onsets[i] - onsets[i - 1]) < 2.0]
    if not diffs:
        return 120.0
    diffs.sort()
    med = diffs[len(diffs) // 2]
    bpm = 60.0 / med
    while bpm < 60:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    return max(40.0, min(240.0, round(bpm, 2)))


def _quantize(events: list[dict], bpm: float, offset: float, mode: str) -> list[dict]:
    """
    Encaixa inícios e fins na grelha de semicolcheias. É isto que transforma
    uma pauta ilegível numa pauta que se lê.
    """
    if mode == "off" or not events or not bpm or bpm <= 0:
        return events

    beat = 60.0 / bpm
    step = beat / 4.0                     # semicolcheia
    tolerance = step * (0.5 if mode == "strict" else 0.38)
    min_len = step * 0.5

    out: list[dict] = []
    for e in events:
        start, end = e["start_time"], e["end_time"]

        def snap(t: float) -> float:
            grid = offset + round((t - offset) / step) * step
            if mode == "strict" or abs(grid - t) <= tolerance:
                return max(0.0, grid)
            return t

        new_start = snap(start)
        new_end = snap(end)
        if new_end - new_start < min_len:
            new_end = new_start + max(min_len, end - start)

        q = dict(e)
        q["start_time"] = new_start
        q["end_time"] = new_end
        out.append(q)

    out.sort(key=lambda e: (e["start_time"], e["pitch"]))
    return out


def _infer_time_signature(note_events: list[dict], bpm: float) -> tuple[int, int]:
    """Escolhe o compasso que melhor alinha os onsets com os tempos fortes."""
    if not note_events or not bpm:
        return (4, 4)
    beat_sec = 60.0 / bpm
    onsets = sorted(float(e["start_time"]) for e in note_events)
    if len(onsets) < 4 or (max(onsets) - min(onsets)) < 0.5:
        return (4, 4)

    candidates = [(4, 4, 4), (3, 4, 3), (2, 4, 2), (6, 8, 3)]
    best_score, best = -1.0, (4, 4)
    tolerance = 0.12
    for num, denom, beats_per_measure in candidates:
        measure_sec = beat_sec * beats_per_measure
        if measure_sec < 0.1:
            continue
        # Peso maior no tempo 1: é isso que distingue 3/4 de 4/4.
        score = 0.0
        for t in onsets:
            pos = (t % measure_sec) / measure_sec
            for b in range(beats_per_measure):
                if abs(pos - b / beats_per_measure) < tolerance:
                    score += 2.0 if b == 0 else 1.0
                    break
        score /= len(onsets)
        if score > best_score:
            best_score, best = score, (num, denom)
    return best


# ── Previsão por blocos ────────────────────────────────────────────────────

def _predict_one(audio_path: str, preset: dict) -> list[dict]:
    """
    Corre o modelo e transforma a saída em notas.

    Em vez do predict() de conveniência do Basic Pitch: assim pede-se o
    include_pitch_bends=False (os bends são a parte lenta da criação de notas e
    nós reconstruímos o MIDI a partir dos eventos, sem eles) e o comprimento
    mínimo é dado já em frames, sem passar pela conversão dele.
    """
    from basic_pitch.inference import run_inference
    from basic_pitch.note_creation import model_output_to_notes

    output = run_inference(audio_path, get_model())
    _, note_events = model_output_to_notes(
        output,
        onset_thresh=float(preset["onset_threshold"]),
        frame_thresh=float(preset["frame_threshold"]),
        min_note_len=max(1, int(round(preset["minimum_note_length"] / 1000.0 * MODEL_FPS))),
        min_freq=preset.get("minimum_frequency"),
        max_freq=preset.get("maximum_frequency"),
        include_pitch_bends=False,
        melodia_trick=True,
    )
    return _normalize_note_events(note_events)


def _predict_chunked(
    y,
    sr: int,
    preset: dict,
    duration: float,
    progress: Optional[Callable[[float], None]] = None,
    cancel_check: Optional[Callable[[], None]] = None,
) -> list[dict]:
    """
    Corre o modelo em blocos de CHUNK_SECONDS com CHUNK_OVERLAP de margem.
    Cada bloco só contribui com as notas que *começam* na sua zona própria, e a
    margem serve para o modelo ter contexto - assim não há notas cortadas na
    fronteira nem duplicados.
    """
    import numpy as np
    import soundfile as sf

    all_events: list[dict] = []
    n_chunks = max(1, int(np.ceil(duration / CHUNK_SECONDS)))

    tmp_dir = tempfile.mkdtemp(prefix="bp_chunks_")
    try:
        for idx in range(n_chunks):
            if cancel_check:
                cancel_check()

            own_start = idx * CHUNK_SECONDS
            own_end = min(duration, own_start + CHUNK_SECONDS)
            read_start = max(0.0, own_start - CHUNK_OVERLAP)
            read_end = min(duration, own_end + CHUNK_OVERLAP)

            seg = y[int(read_start * sr):int(read_end * sr)]
            if seg.size < sr // 10:
                continue

            chunk_path = os.path.join(tmp_dir, f"chunk_{idx}.wav")
            sf.write(chunk_path, seg, sr, subtype="PCM_16")

            try:
                chunk_events = _predict_one(chunk_path, preset)
            finally:
                try:
                    os.unlink(chunk_path)
                except OSError:
                    pass

            for e in chunk_events:
                abs_start = e["start_time"] + read_start
                abs_end = e["end_time"] + read_start
                # Só fica com o que arranca na zona própria deste bloco.
                if own_start - 1e-6 <= abs_start < own_end - 1e-6 or (idx == n_chunks - 1 and abs_start >= own_start):
                    e["start_time"] = abs_start
                    e["end_time"] = min(abs_end, duration + 0.5)
                    all_events.append(e)

            if progress:
                progress((idx + 1) / n_chunks)
    finally:
        try:
            os.rmdir(tmp_dir)
        except OSError:
            pass

    all_events.sort(key=lambda e: (e["start_time"], e["pitch"]))
    return all_events


def _events_to_midi(events: list[dict], bpm: float, time_sig: tuple[int, int]) -> bytes:
    """Reconstrói o MIDI a partir dos eventos já limpos e quantizados."""
    import pretty_midi

    midi = pretty_midi.PrettyMIDI(initial_tempo=float(bpm) if bpm else 120.0)
    try:
        midi.time_signature_changes.append(
            pretty_midi.TimeSignature(int(time_sig[0]), int(time_sig[1]), 0.0)
        )
    except Exception:
        pass

    inst = pretty_midi.Instrument(program=0, name="Transcription")
    for e in events:
        conf = e.get("confidence")
        velocity = int(max(35, min(127, round((conf if conf is not None else 0.7) * 127))))
        try:
            inst.notes.append(pretty_midi.Note(
                velocity=velocity,
                pitch=int(e["pitch"]),
                start=float(e["start_time"]),
                end=float(max(e["end_time"], e["start_time"] + 0.03)),
            ))
        except Exception:
            continue
    midi.instruments.append(inst)

    fd, temp_path = tempfile.mkstemp(suffix=".mid")
    os.close(fd)
    try:
        midi.write(temp_path)
        with open(temp_path, "rb") as f:
            return f.read()
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


# ── Ponto de entrada ───────────────────────────────────────────────────────

@dataclass
class TranscriptionResult:
    midi_bytes: bytes
    note_events: list[dict]
    time_signature: tuple[int, int]
    bpm: float
    beat_offset: float = 0.0
    beat_times: list[float] = field(default_factory=list)


def transcribe_to_midi(
    audio_path: str,
    options: TranscribeOptions | None = None,
    progress: Optional[Callable[[float], None]] = None,
    stage: Optional[Callable[[str], None]] = None,
    cancel_check: Optional[Callable[[], None]] = None,
    duration: Optional[float] = None,
) -> TranscriptionResult:
    options = options or TranscribeOptions()
    preset = options.preset()

    def say(msg: str) -> None:
        if stage:
            stage(msg)

    say("Loading the model")
    get_model()
    if cancel_check:
        cancel_check()

    # Um único descodificar do áudio, partilhado pelos blocos e pelo beat tracking.
    # (Descodificar um mp3 duas vezes custava mais do que a própria transcrição.)
    import librosa
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    if duration is None:
        duration = float(y.size) / sr if sr else 0.0

    say("Listening for notes")
    # Um só caminho, mesmo para ficheiros curtos. (Normalizar o volume antes da
    # análise foi tentado e medido: não muda nada - o modelo já é indiferente ao
    # nível - e só arriscava distorcer o sinal.)
    events = _predict_chunked(y, sr, preset, duration, progress, cancel_check)

    if cancel_check:
        cancel_check()

    say("Finding the pulse")
    grid = _detect_tempo_grid(y, sr)
    bpm = grid["bpm"] or _estimate_bpm(events)
    beat_offset = grid["beat_offset"]

    say("Cleaning up")
    events = _merge_fragmented(events)
    if options.remove_octave_ghosts:
        events = _remove_octave_ghosts(events)
    min_len = float(preset["minimum_note_length"]) / 1000.0
    events = _drop_short(events, min_len * 0.6)

    time_sig = _infer_time_signature(events, bpm)
    events = _quantize(events, bpm, beat_offset, options.quantize)

    say("Writing the MIDI")
    midi_bytes = _events_to_midi(events, bpm, time_sig)

    return TranscriptionResult(
        midi_bytes=midi_bytes,
        note_events=events,
        time_signature=time_sig,
        bpm=round(float(bpm)),
        beat_offset=beat_offset,
        beat_times=grid["beat_times"][:2000],
    )
