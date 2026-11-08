# AI Score Transcriber

Web app that turns **audio into MIDI and sheet music** using the open source library [Basic Pitch](https://github.com/spotify/basic-pitch). Upload an audio file → **piano roll**, **sheet music** (PDF downloadable), **playback**, and **MIDI** download.

**Live demo:** [https://aiscoretranscriber.com/](https://aiscoretranscriber.com/)

---

## About

It's often hard to find piano scores for specific pieces. **AI Score Transcriber** generates both a MIDI file and a readable piano score (partitura) from any audio so you can practice with a visual score without needing the official sheet music. Works with any instrument (polyphonic). Runs on ONNX — no TensorFlow needed.

---

## Features

| Area | Description |
|------|-------------|
| **Input** | Local file (WAV, MP3, FLAC, OGG, M4A, WEBM, up to 50 MB), YouTube link, or a bundled sample. |
| **Transcription** | Runs **in the background**: the request returns a `job_id` immediately and the page polls for real progress. Long files are processed in overlapping chunks, so the progress bar reflects actual work and memory stays flat. |
| **Recognition** | Tunable detail (clean / balanced / detailed) and instrument range, which cuts out most false notes. Tempo and beat grid come from `librosa` beat tracking; fragmented notes are merged and octave artefacts removed. |
| **Views** | **Piano roll** (waterfall + playable keyboard), **Sheet** (VexFlow, with detected key signature), and **Note data**. |
| **Sheet editing** | Drag a note to change its pitch, set its length, add notes by clicking, delete, and undo/redo. Edits flow into the exported MIDI and PDF. |
| **Playback** | The transcription is played by a **synthesised piano in the browser**, scheduled on the Web Audio clock, so you hear the notes themselves — in time. The original recording plays alongside it and can be muted independently. |
| **Practice** | Playback speed is separate from the notated tempo: slow a passage down without re-barring the score. |
| **Export** | **MIDI** (including your edits), **score as PDF**, or the original audio. Results expire after 1 hour. |

---

## Mobile and tablet

- **File size:** Uploads are limited to **50 MB**. Larger files will show “File too large”.
- **Choosing a file:** On phones/tablets, tap **Upload File** and pick the audio from your device (e.g. **Files** or **Downloads**). The app accepts common audio types (including MP3). If the picker does not show your file, try opening it from the **Files** (or equivalent) app and use “Share” / “Open with” if your browser supports it.
- **“Network error” or “Connection error”:** This often means:
  - The file is large or the connection is slow, and the request **timed out** (try a shorter track or Wi‑Fi).
  - The file is **over 50 MB** (try a shorter or lower-quality file).
  - The connection dropped (try again on a stable network).

---

## Quick start

**1. Clone the repo**

```bash
git clone https://github.com/Villamediana/AIScoreTranscriber
cd AIScoreTranscriber
```

**2. Install**

Requires **Python 3.10 or newer** (tested on 3.13).

- **Windows:** `py -3 -m venv venv`
- **Linux/macOS:** `python3 -m venv venv`

```bash
python -m venv venv
venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

*(On Linux/macOS use `source venv/bin/activate` instead of `venv\Scripts\activate`.)*

**3. Run**

```bash
python app.py
```

Open **http://127.0.0.1:5000**

**4. Use**

1. Upload an audio file.
2. Click **Transcribe**.
3. Switch between **Piano** and **Sheet** views; use **Note data** for details; adjust volume/BPM; download **MIDI** or **PDF** (Sheet view).

---

## Project structure

```
AIScoreTranscriber/
├── app.py                     # Flask app: routes, job endpoints, audio conversion
├── jobs.py                    # Background transcription queue (progress, cancel, TTL)
├── requirements.txt
├── README.md
├── transcribe/
│   ├── __init__.py
│   └── basic_pitch_module.py  # Basic Pitch (cached ONNX), chunking, tempo grid, cleanup
├── static/
│   ├── css/app.css            # Dark studio design system
│   └── js/
│       ├── synth.js           # Piano voice + look-ahead scheduler on the audio clock
│       ├── sheet.js           # Score model, rhythm grid, key detection, VexFlow renderer
│       └── app.js             # Shell, job polling, piano roll, editor, transport, export
└── templates/
    └── index.html
```

---

## Screenshots

Screenshots of the app are in the [`screenshots/`](https://github.com/Villamediana/AIScoreTranscriber/tree/main/screenshots) folder. Add your captures there and reference them in the README or in issues/PRs as needed.

---

## YouTube (cookies + optional EJS)

The **YouTube** tab (and on mobile the **YouTube** button + modal) only appears when the app is configured with a **cookies file**. Without it, YouTube often blocks downloads (“Sign in to confirm you're not a bot”). Follow the steps below to enable it.

### 1. Create the cookies file

Export your YouTube session cookies from a browser in **Netscape format**:

- **Chrome (recommended):** Install the extension [Get cookies.txt LOCALLY](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc). Open [youtube.com](https://www.youtube.com), log in (prefer a secondary account), then use the extension to export cookies for the current site. Save as `cookies.txt`.
- **Command line (yt-dlp):** With Chrome closed or another profile, run:  
  `yt-dlp --cookies-from-browser chrome --cookies cookies.txt "https://www.youtube.com"`  
  This creates/overwrites `cookies.txt` in the current folder.

The first line of the file must be `# Netscape HTTP Cookie File`. **Do not commit this file or share it** (it contains session data).

### 2. Where to put the file

Place `cookies.txt` in a fixed path, for example:

- **Windows:** `C:\Users\<you>\.config\NoteAIs\cookies.txt` or inside the project folder.
- **Linux / server:** `~/AIScoreTranscriber/cookies.txt` or `~/.config/AIScoreTranscriber/cookies.txt`.

The project’s `.gitignore` already ignores `*.txt` (except `requirements.txt`), so `cookies.txt` will not be committed.

### 3. Set the environment variable

The app reads the path from **`YOUTUBE_COOKIES_FILE`**. Set it **before** starting the app.

**Windows (PowerShell)** — current session only:

```powershell
$env:YOUTUBE_COOKIES_FILE = "C:\Users\<you>\...\cookies.txt"
```

**Windows (permanent, current user):**

```powershell
[System.Environment]::SetEnvironmentVariable("YOUTUBE_COOKIES_FILE", "C:\Users\<you>\...\cookies.txt", "User")
```

Then restart the terminal/IDE and run the app.

**Linux / macOS** — current session:

```bash
export YOUTUBE_COOKIES_FILE="$HOME/AIScoreTranscriber/cookies.txt"
```

**Linux / macOS (permanent):** add to `~/.bashrc` (or equivalent):

```bash
echo 'export YOUTUBE_COOKIES_FILE="$HOME/AIScoreTranscriber/cookies.txt"' >> ~/.bashrc
source ~/.bashrc
```

### 4. Server (VPS / production)

On the server:

1. Create the file, e.g. `touch ~/AIScoreTranscriber/cookies.txt`, then edit it and paste the Netscape-format cookies (exported on your PC and copied over, or via SCP).
2. Set the variable in the **same environment** that starts the app:
   - **Option A:** In the same shell: `export YOUTUBE_COOKIES_FILE="$HOME/AIScoreTranscriber/cookies.txt"`, then start the app (e.g. `nohup venv/bin/python app.py ...`). If you use a new shell later, run `source ~/.bashrc` first if you added the export there.
   - **Option B:** Add the export to `~/.bashrc` as above, open a **new** SSH session, then start the app so it inherits the variable.
3. Restart the app after changing the variable so the process sees it.

Cookies expire; if YouTube starts blocking again, export a fresh `cookies.txt` and replace the file (and restart the app if needed).

### 5. Optional: full format support (yt-dlp 2025.11+)

From yt-dlp **2025.11** onward, YouTube may return “Requested format is not available” unless a JavaScript runtime and the EJS component are available. The app already enables `remote_components: ["ejs:github"]` and `requirements.txt` includes `yt-dlp-ejs`. On the **server**, install:

- **Deno:** `curl -fsSL https://deno.land/install.sh | sh` and add `~/.deno/bin` to `PATH` (e.g. in `~/.bashrc`).
- **yt-dlp-ejs in the venv:** `venv/bin/pip install yt-dlp-ejs`.

Start the app in a shell where `deno` is on `PATH` so yt-dlp can resolve formats correctly.

---

## Dependencies

| Purpose | Dependency |
|--------|------------|
| Transcription | `basic-pitch` (ONNX) |
| Audio conversion | `imageio-ffmpeg` (FFmpeg) |
| MIDI writing | `pretty_midi` |
| Tempo & beat tracking | `librosa` |
| Sheet music (browser) | VexFlow, Tone.js MIDI, jsPDF (CDN) |
| Piano sound | Web Audio, synthesised in the browser (no samples to download) |
