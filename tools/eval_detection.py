"""
Régua para a deteção de notas.

Afinar limiares a olho é enganoso: baixa-se a fasquia, o número de notas sobe,
e não se sabe se subiu de música ou de lixo. Aqui as notas são conhecidas ao
milissegundo porque a peça é fabricada - sintetizada a partir das mesmas
gravações de piano que a app usa para tocar - e por isso dá para medir as duas
coisas que interessam:

  recall    quantas das notas tocadas é que aparecem na pauta
  precisão  quantas das notas da pauta é que foram mesmo tocadas

Foi esta medição que revelou que o passo de juntar fragmentos estava a comer
metade da pauta (43% de recall contra os 91% que o modelo entregava).

    venv/bin/python tools/eval_detection.py

A peça tem de propósito os casos que mais se perdem: acordes, notas fracas ao
lado de fortes, oitavas simultâneas e teclas repetidas depressa.
"""
from __future__ import annotations

import os
import sys
import tempfile
import warnings

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
warnings.filterwarnings("ignore")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import numpy as np  # noqa: E402
import librosa  # noqa: E402
import soundfile as sf  # noqa: E402

SAMPLE_DIR = os.path.join(ROOT, "static", "audio", "piano")
SR = 22050
SEMI = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# Tolerância no encontro entre nota tocada e nota escrita.
MATCH_SECONDS = 0.12


def sample_pitch(name: str) -> int:
    return 12 * (int(name[-1]) + 1) + SEMI[name[0]] + (1 if len(name) > 2 else 0)


def load_samples() -> list[tuple[int, np.ndarray]]:
    out = []
    for f in sorted(os.listdir(SAMPLE_DIR)):
        if f.endswith(".mp3"):
            y, _ = librosa.load(os.path.join(SAMPLE_DIR, f), sr=SR, mono=True)
            out.append((sample_pitch(f[:-4]), y))
    if not out:
        raise SystemExit(f"sem gravações em {SAMPLE_DIR}")
    return sorted(out)


def render(notes, samples, tail: float = 1.5) -> np.ndarray:
    """notes: [(início, duração, altura, força)] -> sinal mono."""
    total = max(s + d for s, d, _, _ in notes) + tail
    buf = np.zeros(int(total * SR) + SR, dtype=np.float32)
    for start, dur, pitch, vel in notes:
        base, wave = min(samples, key=lambda s: abs(s[0] - pitch))
        ratio = 2 ** ((pitch - base) / 12.0)
        idx = np.arange(int(len(wave) / ratio)) * ratio      # é o que um sampler faz
        i0 = idx.astype(np.int32)
        frac = (idx - i0).astype(np.float32)
        i1 = np.minimum(i0 + 1, len(wave) - 1)
        voice = (wave[i0] * (1 - frac) + wave[i1] * frac)[: int((dur + 0.35) * SR)].copy()
        fade = int(0.3 * SR)                                  # o abafador a cair
        if len(voice) > fade:
            voice[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
        at = int(start * SR)
        end = min(at + len(voice), len(buf))
        buf[at:end] += voice[: end - at] * vel
    peak = float(np.max(np.abs(buf)))
    return buf * (0.7 / peak) if peak else buf


def build_piece() -> list[tuple[float, float, int, float]]:
    notes = []
    beat = 0.5                                                # 120 BPM
    chords = [[48, 55, 64], [45, 52, 60], [43, 50, 59], [48, 55, 64]]
    melody = [72, 74, 76, 77, 79, 79, 77, 76, 74, 72, 72, 74, 76, 74, 72, 71]
    t = 0.0
    for bar in range(4):
        for off in (0.0, 2 * beat):
            for p in chords[bar]:
                notes.append((t + off, beat * 1.8, p, 0.75))
        for i in range(8):
            vel = 0.75 if i % 2 == 0 else 0.42                # fracas ao lado de fortes
            notes.append((t + i * beat / 2, beat * 0.45, melody[(bar * 4 + i) % len(melody)], vel))
        t += 4 * beat
    for i in range(8):                                        # oitavas simultâneas
        s = t + i * beat / 2
        notes.append((s, beat * 0.4, 60, 0.7))
        notes.append((s, beat * 0.4, 72, 0.7))
    t += 4 * beat
    for i in range(16):                                       # a mesma tecla, depressa
        notes.append((t + i * beat / 4, beat * 0.2, 67, 0.6 if i % 2 else 0.8))
    return sorted(notes)


CATEGORIES = {
    "acordes": lambda s, d, p, v: p <= 64 and d > 0.8,
    "melodia forte": lambda s, d, p, v: p >= 71 and v > 0.6 and d < 0.5,
    "melodia fraca": lambda s, d, p, v: p >= 71 and v <= 0.6,
    "oitavas": lambda s, d, p, v: p in (60, 72) and 0.15 < d < 0.25,
    "repetidas": lambda s, d, p, v: p == 67,
}


def matched(truth, predicted, tol: float = MATCH_SECONDS) -> set[int]:
    """Índices das notas tocadas que a pauta acertou (altura certa, a tempo)."""
    used, hits = set(), set()
    for k, (start, _dur, pitch, _vel) in enumerate(truth):
        best, best_d = None, tol
        for i, e in enumerate(predicted):
            if i in used or e["pitch"] != pitch:
                continue
            d = abs(e["start_time"] - start)
            if d < best_d:
                best, best_d = i, d
        if best is not None:
            used.add(best)
            hits.add(k)
    return hits


def main() -> None:
    from transcribe.basic_pitch_module import transcribe_to_midi, TranscribeOptions

    truth = build_piece()
    path = os.path.join(tempfile.gettempdir(), "ast_eval_piece.wav")
    if not os.path.exists(path):
        print("a sintetizar a peça…")
        sf.write(path, render(truth, load_samples()), SR, subtype="PCM_16")
    print(f"peça: {len(truth)} notas -> {path}\n")

    for sens in ("clean", "balanced", "detailed"):
        result = transcribe_to_midi(
            path, TranscribeOptions(sensitivity=sens, instrument="piano"))
        events = result.note_events
        hits = matched(truth, events)
        recall = len(hits) / len(truth)
        precision = len(hits) / len(events) if events else 0.0
        f1 = 2 * recall * precision / (recall + precision) if recall + precision else 0.0
        print(f"{sens:<9} notas={len(events):3d}  recall={recall:5.1%}  "
              f"precisão={precision:5.1%}  F1={f1:5.1%}")
        if sens == "balanced":
            for name, test in CATEGORIES.items():
                idx = [k for k, n in enumerate(truth) if test(*n)]
                got = sum(1 for k in idx if k in hits)
                print(f"    {name:<14} {got:2d}/{len(idx):2d}")


if __name__ == "__main__":
    main()
