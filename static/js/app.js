/*
 * AI Score Transcriber - frontend.
 *
 * Notas de arquitetura:
 *
 *   Relógio. Quem manda no tempo é o PianoEngine, que conta pelo relógio do
 *   AudioContext. O <audio> do original é escravo e vai sendo corrigido quando
 *   deriva. Ao contrário, ficava tudo à mercê do requestAnimationFrame e as
 *   notas saíam trocadas.
 *
 *   Transcrição. O POST devolve um job_id e vai-se lá buscar o progresso. O
 *   pedido nunca fica pendurado, e fechar o separador não perde o trabalho.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var CFG = window.APP_CONFIG || {};
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /* ── Estado ─────────────────────────────────────────────────────────── */
  var state = {
    // 'url' se o YouTube estiver disponível (a UI já reflecte isso); o JS
    // adivinha pela seg-btn.active, para não divergir do template.
    source: (document.querySelector('.seg-btn.active') || {dataset:{source:'file'}}).dataset.source,
    file: null,
    example: null,
    result: null,
    score: null,
    renderer: null,
    view: 'roll',
    editing: false,
    adding: false,
    selection: [],
    jobId: null,
    polling: null,
    playing: false,
    loop: false,
    mixAudio: true,
    mixPiano: true,
    rate: 1,
    baseBpm: 120,
    dirty: false,      // há edições por cima da transcrição original
    saved: true,       // ...e já estão gravadas no servidor
    token: null        // morada deste trabalho, se já tiver sido guardado
  };

  var piano = window.piano;

  /* ── Utilidades ─────────────────────────────────────────────────────── */

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function pitchName(p) {
    return NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
  }

  function toast(msg, kind) {
    var host = $('toastHost');
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(function () { el.remove(); }, 260);
    }, kind === 'err' ? 4200 : 2600);
  }

  function showError(msg) {
    $('errorText').textContent = msg;
    $('errorBox').hidden = false;
    // Em ecrã pequeno a barra lateral está fechada e a caixa de erro fica
    // invisível; o toast garante que a mensagem chega.
    if (window.innerWidth <= 860) toast(msg, 'err');
  }
  function clearError() { $('errorBox').hidden = true; }

  /* ── Barra lateral e modais ─────────────────────────────────────────── */

  var shell = $('shell');
  $('collapseBtn').addEventListener('click', function () {
    if (window.innerWidth <= 860) shell.classList.remove('sidebar-open');
    else shell.classList.add('sidebar-collapsed');
  });
  $('expandBtn').addEventListener('click', function () { shell.classList.remove('sidebar-collapsed'); });
  $('menuBtn').addEventListener('click', function () { shell.classList.add('sidebar-open'); });
  $('scrim').addEventListener('click', function () { shell.classList.remove('sidebar-open'); });

  function openModal(id) { $(id).classList.add('open'); }
  function closeModal(el) { el.classList.remove('open'); }
  $('aboutBtn').addEventListener('click', function () { openModal('aboutModal'); });
  document.querySelectorAll('.modal').forEach(function (m) {
    m.addEventListener('click', function (e) {
      if (e.target === m || (e.target.closest && e.target.closest('[data-close]'))) closeModal(m);
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') document.querySelectorAll('.modal.open').forEach(closeModal);
  });

  /* ── Escolha da origem ──────────────────────────────────────────────── */

  $('sourceSeg').addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-btn');
    if (!btn) return;
    state.source = btn.dataset.source;
    document.querySelectorAll('.seg-btn').forEach(function (b) {
      b.classList.toggle('active', b === btn);
    });
    document.querySelectorAll('.source-panel').forEach(function (p) {
      p.hidden = p.dataset.panel !== state.source;
    });
    clearError();
    if (state.source === 'example') loadExamples();
  });

  /* Ficheiro */
  var drop = $('drop');
  var audioInput = $('audioInput');

  drop.addEventListener('click', function (e) {
    if (e.target.closest('#dropFileClear')) return;
    audioInput.click();
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('dragover'); });
  });
  drop.addEventListener('drop', function (e) {
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setFile(f);
  });
  audioInput.addEventListener('change', function () {
    if (audioInput.files && audioInput.files[0]) setFile(audioInput.files[0]);
  });
  $('dropFileClear').addEventListener('click', function (e) {
    e.stopPropagation();
    state.file = null;
    audioInput.value = '';
    $('dropEmpty').hidden = false;
    $('dropFile').hidden = true;
  });

  function setFile(f) {
    var maxMb = CFG.maxUploadMb || 50;
    if (f.size > maxMb * 1024 * 1024) {
      showError('That file is ' + fmtSize(f.size) + '. The limit is ' + maxMb + ' MB — try a shorter clip.');
      return;
    }
    clearError();
    state.file = f;
    state.example = null;
    $('dropFileName').textContent = f.name;
    $('dropFileMeta').textContent = fmtSize(f.size);
    $('dropEmpty').hidden = true;
    $('dropFile').hidden = false;
  }

  /* Exemplos */
  var examplesLoaded = false;
  var examplesData = [];

  function loadExamples() {
    if (examplesLoaded) return;
    examplesLoaded = true;
    fetch('/api/examples')
      .then(function (r) { return r.json(); })
      .then(function (d) { examplesData = d.examples || []; renderExamples(); })
      .catch(function () { examplesLoaded = false; });
  }

  function renderExamples() {
    var q = ($('exampleSearch').value || '').toLowerCase().trim();
    var list = $('exampleList');
    list.innerHTML = '';
    var shown = examplesData.filter(function (ex) {
      return !q || ex.name.toLowerCase().indexOf(q) >= 0 ||
             (ex.category || '').toLowerCase().indexOf(q) >= 0;
    });
    if (!shown.length) {
      list.innerHTML = '<div class="setting-hint">No samples match.</div>';
      return;
    }
    shown.forEach(function (ex) {
      var item = document.createElement('div');
      item.className = 'example-item' + (state.example === ex.filename ? ' selected' : '');
      item.dataset.file = ex.filename;
      item.innerHTML =
        '<button type="button" class="example-play" aria-label="Preview">' +
          '<svg class="ico-play" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>' +
          '<svg class="ico-stop" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>' +
        '</button>' +
        '<div class="example-body">' +
          '<div class="example-name"></div>' +
          '<div class="example-meta"></div>' +
        '</div>';
      item.querySelector('.example-name').textContent = ex.name;
      item.querySelector('.example-meta').textContent =
        [ex.category, ex.difficulty ? '★'.repeat(ex.difficulty) : null].filter(Boolean).join(' · ') || ex.ext.replace('.', '').toUpperCase();

      item.addEventListener('click', function (e) {
        if (e.target.closest('.example-play')) { previewExample(ex); return; }
        state.example = ex.filename;
        state.file = null;
        clearError();
        renderExamples();
      });
      list.appendChild(item);
    });
    markPreviewButtons();
  }

  var previewAudio = null;
  var previewName = null;

  function markPreviewButtons() {
    document.querySelectorAll('.example-item').forEach(function (item) {
      var btn = item.querySelector('.example-play');
      if (btn) btn.classList.toggle('playing', item.dataset.file === previewName);
    });
  }

  function stopPreview() {
    if (previewAudio) { previewAudio.pause(); previewAudio = null; }
    previewName = null;
    markPreviewButtons();
  }

  function previewExample(ex) {
    var wasThisOne = previewName === ex.filename;
    stopPreview();
    if (wasThisOne) return;          // segundo clique no mesmo: pára e fica assim

    previewName = ex.filename;
    previewAudio = new Audio('/api/examples/audio/' + encodeURIComponent(ex.filename));
    previewAudio.volume = 0.75;
    previewAudio.addEventListener('ended', stopPreview);
    previewAudio.addEventListener('error', stopPreview);
    previewAudio.play().catch(stopPreview);
    markPreviewButtons();
  }
  $('exampleSearch').addEventListener('input', renderExamples);

  /* ── Submeter e acompanhar o job ────────────────────────────────────── */

  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    start();
  });

  function start() {
    clearError();
    if (state.polling) { clearTimeout(state.polling); state.polling = null; }
    var fd = new FormData();
    if (state.source === 'file') {
      if (!state.file) { showError('Pick an audio file first.'); return; }
      fd.append('audio', state.file);
    } else if (state.source === 'url') {
      var url = ($('urlInput').value || '').trim();
      if (!url) { showError('Paste a YouTube link first.'); return; }
      fd.append('youtube_url', url);
    } else {
      if (!state.example) { showError('Choose a sample first.'); return; }
      fd.append('example', state.example);
    }
    fd.append('instrument', $('instrument').value);
    fd.append('sensitivity', $('sensitivity').value);
    fd.append('quantize', $('quantize').value);

    setStage('loading');
    setProgress(0, 'Uploading');
    shell.classList.remove('sidebar-open');

    fetch('/transcribe', {
      method: 'POST',
      body: fd,
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.error || 'Could not start the transcription.');
        state.jobId = res.data.job_id;
        try { localStorage.setItem('ast_job', state.jobId); } catch (e) {}
        pollJob();
      })
      .catch(function (err) {
        setStage('empty');
        showError(err.message || 'Network error. Check the connection and try again.');
      });
  }

  function pollJob() {
    if (state.polling) clearTimeout(state.polling);
    if (!state.jobId) return;

    fetch('/api/jobs/' + state.jobId)
      .then(function (r) {
        if (r.status === 404) throw new Error('That job has expired.');
        return r.json();
      })
      .then(function (job) {
        if (job.status === 'queued') {
          setProgress(0.02, 'Waiting in line');
          $('loadingQueue').hidden = false;
          $('loadingQueue').textContent = job.queue_position > 1
            ? '#' + job.queue_position + ' in the queue'
            : 'Next up';
        } else {
          $('loadingQueue').hidden = true;
        }

        if (job.status === 'running') setProgress(job.progress, job.stage);

        if (job.status === 'done') {
          setProgress(1, 'Done');
          try { localStorage.removeItem('ast_job'); } catch (e) {}
          state.jobId = null;
          showResult(job.result);
          return;
        }
        if (job.status === 'error' || job.status === 'cancelled') {
          try { localStorage.removeItem('ast_job'); } catch (e) {}
          state.jobId = null;
          setStage('empty');
          if (job.status === 'error') showError(job.error || 'The transcription failed.');
          return;
        }
        // Sondagem folgada: o progresso vem do servidor, não vale martelar.
        state.polling = setTimeout(pollJob, 900);
      })
      .catch(function (err) {
        state.jobId = null;
        try { localStorage.removeItem('ast_job'); } catch (e) {}
        setStage('empty');
        showError(err.message || 'Lost contact with the server.');
      });
  }

  $('cancelBtn').addEventListener('click', function () {
    if (!state.jobId) { setStage('empty'); return; }
    fetch('/api/jobs/' + state.jobId + '/cancel', { method: 'POST' }).catch(function () {});
    if (state.polling) clearTimeout(state.polling);
    state.jobId = null;
    try { localStorage.removeItem('ast_job'); } catch (e) {}
    setStage('empty');
  });

  var RING = 2 * Math.PI * 52;
  function setProgress(frac, stage) {
    frac = Math.max(0, Math.min(1, frac || 0));
    $('ringFill').style.strokeDashoffset = String(RING * (1 - frac));
    $('progressPct').textContent = Math.round(frac * 100) + '%';
    if (stage) $('loadingStage').textContent = stage;
  }

  function setStage(which) {
    $('stageEmpty').hidden = which !== 'empty';
    $('stageLoading').hidden = which !== 'loading';
    $('stageResult').hidden = which !== 'result';
    $('playbackBlock').hidden = which !== 'result';
    $('submitBtn').disabled = which === 'loading';
  }

  /* ── Mostrar o resultado ────────────────────────────────────────────── */

  var player = $('player');

  function showResult(data) {
    state.result = data;
    state.dirty = !!data.has_edits;
    state.saved = true;
    state.token = data.token || null;
    applyShareLink(data);

    var score = new window.ScoreLib.Score();
    score.loadEvents(data.note_events, {
      bpm: data.bpm || 120,
      timeSig: {
        numerator: data.time_signature.numerator,
        denominator: data.time_signature.denominator
      },
      beatOffset: data.beat_offset || 0,
      duration: data.audio_duration || 0
    });
    score.onChange = onScoreChanged;
    state.score = score;
    state.baseBpm = data.bpm || 120;
    state.rate = 1;
    state.selection = [];
    $('speed').value = '100';
    $('speedVal').textContent = '1×';

    piano.init();
    piano.useSamples(CFG.pianoSamples || '/static/audio/piano/');
    piano.load(score.playbackEvents(), score.totalDuration());

    rollMaxDur = 1;
    score.notes.forEach(function (n) { rollMaxDur = Math.max(rollMaxDur, n.end - n.start); });

    // Num link antigo o áudio de origem já pode ter expirado; a pauta não.
    if (data.audio_available === false) {
      player.removeAttribute('src');
      player.load();
      state.mixAudio = false;
      $('mixAudio').classList.remove('on');
    } else {
      player.src = data.original_audio_url;
      player.load();
    }

    $('bpmInput').value = Math.round(data.bpm || 120);
    $('bpmHint').textContent = 'Detected: ' + Math.round(data.bpm || 120) + ' BPM';
    $('tsNum').value = String(data.time_signature.numerator);
    $('tsDen').value = String(data.time_signature.denominator);
    $('keyLabel').textContent = 'Key ' + score.key.name + (score.key.isMinor ? ' min' : ' maj');
    $('sourceChip').textContent = data.source_name ? data.source_name.replace(/_/g, ' ') : '';
    $('downloadMidi').href = data.midi_download_url;
    $('downloadMidi').setAttribute('download', data.midi_filename || 'transcription.mid');

    setStage('result');
    setView(state.view === 'notes' ? 'notes' : state.view);
    sizeRoll();
    renderNotesTable();
    updateTransport();
    toast(score.notes.length + ' notes' + (data.has_edits ? ' (your saved edits)' : ' found'), 'ok');
  }

  function onScoreChanged() {
    state.dirty = true;
    state.saved = false;
    piano.load(state.score.playbackEvents(), state.score.totalDuration());
    $('undoBtn').disabled = !state.score.canUndo();
    $('redoBtn').disabled = !state.score.canRedo();
    if (state.view === 'sheet') renderSheet();
    if (state.view === 'notes') renderNotesTable();
    scheduleSave();
  }

  /* ── Link partilhável e gravação automática ─────────────────────────── */

  function shareLink() {
    return state.token ? location.origin + '/p/' + state.token : '';
  }

  function applyShareLink(data) {
    var has = !!(data && data.token);
    $('shareBlock').hidden = !has;
    $('shareBtnTop').hidden = !has;
    if (!has) return;

    $('shareUrl').value = shareLink();
    // A partir daqui, o endereço na barra é o do trabalho. Recarregar,
    // partilhar ou pôr nos favoritos passa a devolver isto tal e qual.
    var path = data.share_path || ('/p/' + data.token);
    if (location.pathname !== path) {
      try { history.replaceState({ token: data.token }, '', path); } catch (e) {}
    }
    setSaveStatus('saved');
  }

  function setSaveStatus(kind) {
    var hint = $('shareHint');
    var text = {
      saved: 'Saved. Anyone with this link opens your score, with your edits.',
      saving: 'Saving your edits…',
      failed: 'Could not save your last edit — it stays on this device only.'
    }[kind] || '';
    hint.innerHTML = '<span class="save-dot ' + kind + '"></span>';
    hint.appendChild(document.createTextNode(text));
  }

  function copyShareLink() {
    var url = shareLink();
    if (!url) return;
    var done = function () {
      $('shareCopy').classList.add('done');
      setTimeout(function () { $('shareCopy').classList.remove('done'); }, 1600);
      toast('Link copied', 'ok');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      // Sem clipboard API (http em rede local, browsers antigos): selecionar
      // o campo é o que resta, e pelo menos deixa copiar à mão.
      var input = $('shareUrl');
      input.focus();
      input.setSelectionRange(0, input.value.length);
      try {
        if (document.execCommand('copy')) { done(); return; }
      } catch (e) {}
      toast('Copy the link from the box', 'err');
    }
  }

  $('shareCopy').addEventListener('click', copyShareLink);
  $('shareUrl').addEventListener('click', function () { this.setSelectionRange(0, this.value.length); });
  $('shareBtnTop').addEventListener('click', function () {
    // No telemóvel a folha nativa de partilha é mais útil do que a área de
    // transferência; se não existir, cai no copiar de sempre.
    var url = shareLink();
    if (!url) return;
    if (navigator.share) {
      navigator.share({ title: 'AI Score Transcriber', url: url }).catch(function () {});
    } else {
      copyShareLink();
    }
  });

  var saveTimer = null;

  function notesForSave() {
    return state.score.notes.map(function (n) {
      return {
        start_time: n.start,
        end_time: n.end,
        pitch: n.pitch,
        confidence: n.velocity
      };
    });
  }

  function scheduleSave() {
    if (!state.token || !state.score) return;
    setSaveStatus('saving');
    clearTimeout(saveTimer);
    // Arrastar uma nota dispara dezenas de alterações; só a última interessa.
    saveTimer = setTimeout(saveNotes, 1100);
  }

  function saveNotes() {
    if (!state.token || !state.score) return;
    var body = JSON.stringify({
      notes: notesForSave(),
      meta: {
        bpm: state.score.bpm,
        time_signature: {
          numerator: state.score.timeSig.numerator,
          denominator: state.score.timeSig.denominator
        }
      }
    });
    fetch('/api/p/' + state.token + '/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    })
      .then(function (r) { if (!r.ok) throw new Error('save failed'); return r.json(); })
      .then(function () { state.saved = true; setSaveStatus('saved'); })
      .catch(function () { state.saved = false; setSaveStatus('failed'); });
  }

  /* ── Separadores ────────────────────────────────────────────────────── */

  $('tabs').addEventListener('click', function (e) {
    var btn = e.target.closest('.tab');
    if (btn) setView(btn.dataset.view);
  });

  function setView(view) {
    state.view = view;
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.view === view);
    });
    $('viewRoll').hidden = view !== 'roll';
    $('viewSheet').hidden = view !== 'sheet';
    $('viewNotes').hidden = view !== 'notes';
    if (view === 'roll') sizeRoll();
    if (view === 'sheet') renderSheet();
    if (view === 'notes') renderNotesTable();
  }

  /* ── Piano roll ─────────────────────────────────────────────────────── */

  var canvas = $('roll');
  var ctx = canvas.getContext('2d');
  var MIN_PITCH = 21, MAX_PITCH = 108;
  var BLACK = { 1: 1, 3: 1, 6: 1, 8: 1, 10: 1 };
  var LOOKAHEAD_SEC = 3.2;
  var keyMap = null, keyMapWidth = 0;
  var heldKeys = {};
  // A nota mais longa da peça: define quanto para trás vale a pena procurar.
  var rollMaxDur = 4;

  function pianoHeight() { return window.innerWidth <= 680 ? 54 : 84; }
  function isBlack(p) { return BLACK[((p % 12) + 12) % 12] === 1; }

  function buildKeyMap(w) {
    var whites = [];
    for (var p = MIN_PITCH; p <= MAX_PITCH; p++) if (!isBlack(p)) whites.push(p);
    var ww = w / whites.length;
    var map = {};
    for (var i = 0; i < whites.length; i++) map[whites[i]] = { x: i * ww, w: ww, black: false };
    for (var q = MIN_PITCH; q <= MAX_PITCH; q++) {
      if (!isBlack(q)) continue;
      var prev = q - 1; while (prev >= MIN_PITCH && !map[prev]) prev--;
      var next = q + 1; while (next <= MAX_PITCH && !map[next]) next++;
      var bw = ww * 0.6;
      var bx = map[prev] && map[next]
        ? (map[prev].x + map[prev].w + map[next].x) / 2 - bw / 2
        : (map[prev] ? map[prev].x + map[prev].w - bw / 2 : map[next].x - bw / 2);
      map[q] = { x: bx, w: bw, black: true };
    }
    return map;
  }

  function sizeRoll() {
    var wrap = $('viewRoll');
    if (!wrap || wrap.hidden) return;
    var rect = wrap.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    keyMap = buildKeyMap(rect.width);
    keyMapWidth = rect.width;
  }

  function roundRect(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawRoll() {
    if ($('viewRoll').hidden || !state.score) return;
    var rect = canvas.getBoundingClientRect();
    var w = rect.width, h = rect.height;
    if (!keyMap || keyMapWidth !== w) { keyMap = buildKeyMap(w); keyMapWidth = w; }
    var ph = pianoHeight();
    var fallH = h - ph;
    var now = transportPosition();

    ctx.clearRect(0, 0, w, h);

    // fundo com um leve gradiente para dar profundidade à queda
    var bg = ctx.createLinearGradient(0, 0, 0, fallH);
    bg.addColorStop(0, '#08080d');
    bg.addColorStop(1, '#101019');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, fallH);

    var score = state.score;

    // Sem colunas de teclas pretas nem linhas de compasso: riscavam o ecrã de
    // alto a baixo e competiam com as notas. O teclado em baixo já diz onde
    // estão as pretas, e a queda já dá o ritmo.

    // notas a cair
    var notes = score.notes;
    var active = {};
    var tEnd = now + LOOKAHEAD_SEC;
    // Começar na primeira nota que ainda pode estar no ecrã, em vez de varrer
    // desde o início da peça a cada frame.
    var i0 = window.ScoreLib.firstVisible(notes, now, rollMaxDur);
    for (var i = i0; i < notes.length; i++) {
      var n = notes[i];
      var ns = n.start, ne = n.end;
      if (ne < now - 0.15) continue;
      if (ns > tEnd) break;

      var k = keyMap[n.pitch];
      if (!k) continue;

      var yTop = fallH - ((ne - now) / LOOKAHEAD_SEC) * fallH;
      var yBot = fallH - ((ns - now) / LOOKAHEAD_SEC) * fallH;
      var nh = Math.max(3, yBot - yTop);
      var ny = Math.max(-nh, yTop);
      if (ny > fallH) continue;

      var isPlaying = ns <= now && ne > now;
      if (isPlaying) active[n.pitch] = 1;

      var pad = k.black ? 1 : 1.5;
      var nx = k.x + pad, nw = Math.max(2, k.w - pad * 2);

      if (isPlaying) {
        ctx.shadowColor = 'rgba(167,139,250,.85)';
        ctx.shadowBlur = 16;
      }
      var g = ctx.createLinearGradient(nx, ny, nx, ny + nh);
      if (isPlaying) {
        g.addColorStop(0, '#e9d5ff'); g.addColorStop(1, '#a78bfa');
      } else if (k.black) {
        g.addColorStop(0, '#7c5ce0'); g.addColorStop(1, '#5b3fb8');
      } else {
        g.addColorStop(0, '#a78bfa'); g.addColorStop(1, '#7c5ce0');
      }
      ctx.fillStyle = g;
      roundRect(ctx, nx, ny, nw, Math.min(nh, fallH - ny + nh), Math.min(3.5, nw / 2));
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // linha de impacto
    var glow = ctx.createLinearGradient(0, fallH - 26, 0, fallH);
    glow.addColorStop(0, 'rgba(139,92,246,0)');
    glow.addColorStop(1, 'rgba(139,92,246,.22)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, fallH - 26, w, 26);

    drawKeyboard(w, h, ph, active);
  }

  function drawKeyboard(w, h, ph, active) {
    var y0 = h - ph;
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, y0, w, ph);

    // brancas
    for (var p = MIN_PITCH; p <= MAX_PITCH; p++) {
      if (isBlack(p)) continue;
      var k = keyMap[p];
      var on = active[p] || heldKeys[p];
      var x = k.x + 0.5, ww = k.w - 1;
      var g = ctx.createLinearGradient(x, y0, x, h);
      if (on) { g.addColorStop(0, '#c4b5fd'); g.addColorStop(1, '#8b5cf6'); }
      else { g.addColorStop(0, '#f4f4f8'); g.addColorStop(1, '#c9c9d6'); }
      ctx.fillStyle = g;
      roundRect(ctx, x, y0 + 1, ww, ph - 2, 3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.28)';
      ctx.lineWidth = 1;
      ctx.stroke();

      if (p % 12 === 0 && k.w > 13) {
        ctx.fillStyle = 'rgba(20,20,32,.5)';
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('C' + (Math.floor(p / 12) - 1), x + ww / 2, h - 5);
      }
    }
    // pretas
    var bh = ph * 0.63;
    for (var q = MIN_PITCH; q <= MAX_PITCH; q++) {
      if (!isBlack(q)) continue;
      var kb = keyMap[q];
      var onb = active[q] || heldKeys[q];
      var gb = ctx.createLinearGradient(kb.x, y0, kb.x, y0 + bh);
      if (onb) { gb.addColorStop(0, '#a78bfa'); gb.addColorStop(1, '#6d28d9'); }
      else { gb.addColorStop(0, '#2c2c3d'); gb.addColorStop(1, '#0e0e16'); }
      ctx.fillStyle = gb;
      roundRect(ctx, kb.x, y0, kb.w, bh, 2.5);
      ctx.fill();
    }
  }

  /* Tocar no teclado desenhado */
  function hitKey(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    var x = clientX - rect.left, y = clientY - rect.top;
    var ph = pianoHeight();
    var y0 = rect.height - ph;
    if (y < y0 || !keyMap) return -1;
    var bh = ph * 0.63;
    for (var p = MIN_PITCH; p <= MAX_PITCH; p++) {
      if (!isBlack(p)) continue;
      var k = keyMap[p];
      if (x >= k.x && x <= k.x + k.w && y <= y0 + bh) return p;
    }
    for (var q = MIN_PITCH; q <= MAX_PITCH; q++) {
      if (isBlack(q)) continue;
      var kw = keyMap[q];
      if (x >= kw.x && x <= kw.x + kw.w) return q;
    }
    return -1;
  }

  var pointerPitch = {};
  canvas.addEventListener('pointerdown', function (e) {
    var p = hitKey(e.clientX, e.clientY);
    if (p < 0) return;
    canvas.setPointerCapture(e.pointerId);
    pointerPitch[e.pointerId] = p;
    heldKeys[p] = 1;
    piano.noteOn(p, 0.85);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!(e.pointerId in pointerPitch)) return;
    var p = hitKey(e.clientX, e.clientY);
    var old = pointerPitch[e.pointerId];
    if (p >= 0 && p !== old) {
      delete heldKeys[old];
      piano.noteOff(old);
      pointerPitch[e.pointerId] = p;
      heldKeys[p] = 1;
      piano.noteOn(p, 0.85);
    }
  });
  ['pointerup', 'pointercancel'].forEach(function (ev) {
    canvas.addEventListener(ev, function (e) {
      var p = pointerPitch[e.pointerId];
      if (p == null) return;
      delete pointerPitch[e.pointerId];
      delete heldKeys[p];
      piano.noteOff(p);
    });
  });

  /* ── Partitura ──────────────────────────────────────────────────────── */

  var paper = $('sheetPaper');
  var playhead = $('sheetPlayhead');

  function renderSheet() {
    if (!state.score || $('viewSheet').hidden) return;
    if (!window.Vex) { paper.innerHTML = '<div style="padding:2rem;color:#555">Loading engraver…</div>'; return; }

    var scroll = $('sheetScroll');
    var PAPER_PAD = 20;   // tem de bater certo com o padding de .sheet-paper
    var width = Math.min(1180, Math.max(320, scroll.clientWidth - PAPER_PAD * 2 - 8));
    var host = document.createElement('div');
    paper.innerHTML = '';
    paper.appendChild(host);
    paper.appendChild(playhead);

    state.renderer = new window.ScoreLib.Renderer(host, state.score);
    try {
      state.renderer.render({ width: width });
    } catch (err) {
      paper.innerHTML = '<div style="padding:2rem;color:#a00;font-size:.8rem">Could not draw this score.</div>';
      return;
    }
    paper.style.width = (width + PAPER_PAD * 2) + 'px';
    state.renderer.buildLitIndex();
    litNow = [];
    lastLit = '';
    applySelectionStyles();
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      sizeRoll();
      if (state.view === 'sheet') renderSheet();
    }, 180);
  });

  /* Seleção */
  function applySelectionStyles() {
    if (!state.renderer) return;
    var sel = {};
    state.selection.forEach(function (id) { sel[id] = 1; });
    state.renderer.noteMap.forEach(function (entry) {
      var isSel = entry.ids.some(function (id) { return sel[id]; });
      entry.el.classList.toggle('sel', isSel);
    });
    var has = state.selection.length > 0;
    document.querySelectorAll('.dur-btn').forEach(function (b) { b.disabled = !has; });
    $('deleteBtn').disabled = !has;
  }

  function selectIds(ids, additive) {
    if (additive) {
      ids.forEach(function (id) {
        if (state.selection.indexOf(id) < 0) state.selection.push(id);
      });
    } else {
      state.selection = ids.slice();
    }
    applySelectionStyles();
  }

  /* Edição: arrastar altura */
  var dragState = null;

  paper.addEventListener('pointerdown', function (e) {
    if (!state.score || !state.renderer) return;

    if (state.adding) {
      addNoteAt(e);
      return;
    }
    var entry = state.renderer.findByElement(e.target);
    if (!entry) {
      if (!state.editing) seekFromSheet(e);
      else { state.selection = []; applySelectionStyles(); }
      return;
    }

    selectIds(entry.ids, e.shiftKey);
    piano.pluck(entry.notes.map(function (n) { return n.pitch; }), 0.5);

    if (!state.editing) return;

    e.preventDefault();
    paper.setPointerCapture(e.pointerId);
    dragState = {
      pointerId: e.pointerId,
      startY: e.clientY,
      ids: entry.ids.slice(),
      original: entry.notes.map(function (n) { return { id: n.id, pitch: n.pitch }; }),
      moved: false,
      lastDelta: 0
    };
  });

  paper.addEventListener('pointermove', function (e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    // ~7 px por semitom: perto do espaçamento real da pauta
    var delta = Math.round((dragState.startY - e.clientY) / 7);
    if (delta === dragState.lastDelta) return;

    if (!dragState.moved) { state.score.beginEdit(); dragState.moved = true; }
    dragState.lastDelta = delta;

    var pitches = [];
    dragState.original.forEach(function (o) {
      var n = state.score.byId(o.id);
      if (!n) return;
      n.pitch = Math.max(21, Math.min(108, o.pitch + delta));
      pitches.push(n.pitch);
    });
    if (pitches.length) piano.pluck(pitches, 0.28);
    scheduleDragRender();
  });

  var dragRenderTimer = null;
  function scheduleDragRender() {
    if (dragRenderTimer) return;
    dragRenderTimer = setTimeout(function () {
      dragRenderTimer = null;
      renderSheet();
    }, 55);
  }

  ['pointerup', 'pointercancel'].forEach(function (ev) {
    paper.addEventListener(ev, function (e) {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      var moved = dragState.moved;
      dragState = null;
      if (moved) {
        state.score.commit();
        toast('Pitch changed');
      }
    });
  });

  function addNoteAt(e) {
    var rect = paper.getBoundingClientRect();
    var x = e.clientX - rect.left - 20;
    var y = e.clientY - rect.top - 20;
    var time = state.renderer.positionToTime(x, y);

    // Qual pauta? Pela distância vertical ao centro de cada uma.
    var layout = state.renderer.layout;
    var line = Math.floor(y / layout.systemHeight);
    var localY = y - line * layout.systemHeight;
    var isTreble = localY < (layout.trebleY + layout.bassY) / 2 + 20;

    // Altura a partir da posição na pauta: 1 grau por meia distância entre linhas.
    var staffTop = isTreble ? layout.trebleY : layout.bassY;
    var stepsFromTop = (localY - staffTop) / 5;          // 5 px por grau
    var topPitchDegree = isTreble ? 33 : 21;              // fá5 / lá3 em graus diatónicos
    var degree = Math.round(topPitchDegree - stepsFromTop);
    var pitch = degreeToPitch(degree);

    var slots = parseInt(currentDurSlots, 10) || 4;
    var beat = 60 / state.score.bpm;
    var snapped = Math.round(time / (beat / 4)) * (beat / 4);

    var note = state.score.insert(snapped, pitch, slots);
    piano.pluck([note.pitch], 0.5);
    selectIds([note.id], false);
    toast('Note added: ' + pitchName(note.pitch));
  }

  /* Grau diatónico (dó0 = 0) -> altura MIDI. */
  function degreeToPitch(degree) {
    var SEMI = [0, 2, 4, 5, 7, 9, 11];
    var octave = Math.floor(degree / 7);
    var idx = ((degree % 7) + 7) % 7;
    return Math.max(21, Math.min(108, 12 * (octave + 1) + SEMI[idx]));
  }

  function seekFromSheet(e) {
    if (!state.renderer || !state.renderer.layout) return;
    var rect = paper.getBoundingClientRect();
    var t = state.renderer.positionToTime(e.clientX - rect.left - 20, e.clientY - rect.top - 20);
    transportSeek(t);
  }

  /* Barra de ferramentas */
  var currentDurSlots = 4;

  $('editToggle').addEventListener('click', function () { setEditing(!state.editing); });
  $('addToggle').addEventListener('click', function () { setAdding(!state.adding); });

  function setEditing(on) {
    state.editing = on;
    if (!on) setAdding(false);
    $('editToggle').classList.toggle('active', on);
    $('addToggle').disabled = !on;
    paper.classList.toggle('editing', on);
    $('editHint').hidden = !on;
    $('editHint').textContent = on
      ? 'Drag a note to change its pitch · ↑↓ semitone · ←→ move in time · Del removes'
      : '';
    if (!on) { state.selection = []; applySelectionStyles(); }
  }

  function setAdding(on) {
    state.adding = on && state.editing;
    $('addToggle').classList.toggle('active', state.adding);
    paper.classList.toggle('adding', state.adding);
    if (state.adding) {
      $('editHint').textContent = 'Click on a staff to place a note · pick the length on the left';
    } else if (state.editing) {
      $('editHint').textContent = 'Drag a note to change its pitch · ↑↓ semitone · ←→ move in time · Del removes';
    }
  }

  document.querySelectorAll('.dur-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      currentDurSlots = parseInt(btn.dataset.slots, 10);
      document.querySelectorAll('.dur-btn').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      if (state.selection.length) {
        state.score.setDuration(state.selection, currentDurSlots);
        toast('Length changed');
      }
    });
  });

  $('deleteBtn').addEventListener('click', function () {
    if (!state.selection.length) return;
    var n = state.selection.length;
    state.score.remove(state.selection);
    state.selection = [];
    toast(n + (n === 1 ? ' note removed' : ' notes removed'));
  });

  $('undoBtn').addEventListener('click', function () {
    if (state.score && state.score.undo()) { state.selection = []; toast('Undone'); }
  });
  $('redoBtn').addEventListener('click', function () {
    if (state.score && state.score.redo()) { state.selection = []; toast('Redone'); }
  });

  function applyTimeSignature() {
    if (!state.score) return;
    state.score.timeSig = {
      numerator: parseInt($('tsNum').value, 10) || 4,
      denominator: parseInt($('tsDen').value, 10) || 4
    };
    renderSheet();
    markEdited();
  }

  /* Compasso e andamento não passam pelo histórico da pauta, mas fazem parte
     do trabalho: sem isto, o link reabria com o compasso errado. */
  function markEdited() {
    if (!state.token) return;
    state.dirty = true;
    state.saved = false;
    scheduleSave();
  }
  $('tsNum').addEventListener('change', applyTimeSignature);
  $('tsDen').addEventListener('change', applyTimeSignature);

  /* ── Tabela de notas ────────────────────────────────────────────────── */

  function renderNotesTable() {
    if (!state.score) return;
    var notes = state.score.notes;
    var summary = $('notesSummary');
    var pitches = notes.map(function (n) { return n.pitch; });
    var lo = pitches.length ? Math.min.apply(null, pitches) : 0;
    var hi = pitches.length ? Math.max.apply(null, pitches) : 0;

    summary.innerHTML = '';
    [
      ['Notes', notes.length],
      ['Tempo', Math.round(state.score.bpm) + ' BPM'],
      ['Time', state.score.timeSig.numerator + '/' + state.score.timeSig.denominator],
      ['Key', state.score.key.name + (state.score.key.isMinor ? ' min' : ' maj')],
      ['Range', pitches.length ? pitchName(lo) + ' – ' + pitchName(hi) : '—'],
      ['Length', fmtTime(state.score.totalDuration())]
    ].forEach(function (pair) {
      var d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<div class="stat-label"></div><div class="stat-value"></div>';
      d.querySelector('.stat-label').textContent = pair[0];
      d.querySelector('.stat-value').textContent = pair[1];
      summary.appendChild(d);
    });

    var body = $('notesBody');
    body.innerHTML = '';
    // Tabelas gigantes matam o browser do telemóvel; 600 chega para inspecionar.
    var shown = notes.slice(0, 600);
    var frag = document.createDocumentFragment();
    shown.forEach(function (n, i) {
      var tr = document.createElement('tr');
      [
        i + 1,
        n.start.toFixed(2) + 's',
        n.end.toFixed(2) + 's',
        (n.end - n.start).toFixed(2) + 's',
        pitchName(n.pitch),
        n.pitch,
        Math.round(n.velocity * 100) + '%'
      ].forEach(function (v) {
        var td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      tr.addEventListener('click', function () {
        piano.pluck([n.pitch], Math.min(1.2, n.end - n.start));
        transportSeek(n.start);
      });
      frag.appendChild(tr);
    });
    body.appendChild(frag);
    if (notes.length > shown.length) {
      var tr2 = document.createElement('tr');
      var td2 = document.createElement('td');
      td2.colSpan = 7;
      td2.style.color = 'var(--text-3)';
      td2.textContent = 'Showing the first ' + shown.length + ' of ' + notes.length + ' notes.';
      tr2.appendChild(td2);
      body.appendChild(tr2);
    }
  }

  /* ── Transporte ─────────────────────────────────────────────────────── */

  var seekEl = $('seek');
  var seeking = false;
  var pausedAt = 0;

  /* Tudo aqui conta em segundos da gravação original - a mesma escala em que
     as notas vivem e em que o <audio> mede o seu currentTime. A velocidade de
     ensaio só muda a rapidez com que se atravessa essa escala, nunca a escala. */

  function transportDuration() {
    return state.score ? state.score.totalDuration() : 0;
  }

  function transportPosition() {
    if (!state.score) return 0;
    return state.playing ? piano.position() : pausedAt;
  }

  function transportPlay() {
    if (!state.score) return;
    piano.init();
    piano.resume();
    var from = pausedAt;
    if (from >= transportDuration() - 0.05) from = 0;
    piano.setVolume(state.mixPiano ? parseInt($('volPiano').value, 10) / 100 : 0);
    piano.play(from, state.rate);
    if (state.mixAudio && player.src) {
      player.volume = parseInt($('volOriginal').value, 10) / 100;
      player.playbackRate = state.rate;
      try { player.currentTime = from; } catch (e) {}
      player.play().catch(function () {});
    }
    state.playing = true;
    updatePlayIcon();
  }

  function transportPause() {
    pausedAt = transportPosition();
    piano.stop();
    player.pause();
    state.playing = false;
    updatePlayIcon();
  }

  function transportSeek(seconds) {
    var d = transportDuration();
    pausedAt = Math.max(0, Math.min(d, seconds));
    if (state.playing) {
      piano.play(pausedAt, state.rate);
      if (state.mixAudio && player.src) {
        try { player.currentTime = pausedAt; } catch (e) {}
      }
    }
    updateTransport();
  }

  function updatePlayIcon() {
    $('playBtn').classList.toggle('playing', state.playing);
    $('playBtn').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  }

  $('playBtn').addEventListener('click', function () {
    if (state.playing) transportPause(); else transportPlay();
  });

  seekEl.addEventListener('input', function () {
    seeking = true;
    var d = transportDuration();
    $('timeLabel').textContent = fmtTime(seekEl.value / 1000 * d) + ' / ' + fmtTime(d);
  });
  seekEl.addEventListener('change', function () {
    seeking = false;
    transportSeek(seekEl.value / 1000 * transportDuration());
  });

  function updateTransport() {
    var d = transportDuration();
    var pos = transportPosition();
    if (!seeking) seekEl.value = d > 0 ? String(Math.round(pos / d * 1000)) : '0';
    $('timeLabel').textContent = fmtTime(pos) + ' / ' + fmtTime(d);
  }

  /* Mistura */
  $('mixAudio').addEventListener('click', function () {
    state.mixAudio = !state.mixAudio;
    this.classList.toggle('on', state.mixAudio);
    if (!state.mixAudio) player.pause();
    else if (state.playing && player.src) {
      try { player.currentTime = transportPosition(); } catch (e) {}
      player.play().catch(function () {});
    }
  });
  $('mixPiano').addEventListener('click', function () {
    state.mixPiano = !state.mixPiano;
    this.classList.toggle('on', state.mixPiano);
    piano.setVolume(state.mixPiano ? parseInt($('volPiano').value, 10) / 100 : 0);
  });
  $('loopBtn').addEventListener('click', function () {
    state.loop = !state.loop;
    this.classList.toggle('active', state.loop);
    toast(state.loop ? 'Loop on' : 'Loop off');
  });

  $('volOriginal').addEventListener('input', function () {
    $('volOriginalVal').textContent = this.value + '%';
    player.volume = parseInt(this.value, 10) / 100;
  });
  $('volPiano').addEventListener('input', function () {
    $('volPianoVal').textContent = this.value + '%';
    if (state.mixPiano) piano.setVolume(parseInt(this.value, 10) / 100);
  });

  /* BPM: só notação. Muda onde caem as barras de compasso, não a velocidade. */
  function applyBpm() {
    var v = Math.max(30, Math.min(240, parseInt($('bpmInput').value, 10) || state.baseBpm));
    $('bpmInput').value = v;
    if (!state.score) return;
    state.score.bpm = v;
    if (state.view === 'sheet') renderSheet();
    if (state.view === 'notes') renderNotesTable();
    markEdited();
  }

  /* Velocidade de ensaio: só reprodução. As notas ficam onde estão. */
  function applySpeed() {
    var pct = parseInt($('speed').value, 10) || 100;
    state.rate = pct / 100;
    $('speedVal').textContent = (state.rate).toFixed(2).replace(/0$/, '') + '×';
    if (state.playing) {
      // Retomar do mesmo sítio, agora com o novo passo.
      var pos = transportPosition();
      piano.play(pos, state.rate);
      if (state.mixAudio && player.src) {
        player.playbackRate = state.rate;
        try { player.currentTime = pos; } catch (e) {}
      }
    }
  }
  $('speed').addEventListener('input', applySpeed);
  $('bpmInput').addEventListener('change', applyBpm);
  $('bpmMinus').addEventListener('click', function () {
    $('bpmInput').value = Math.max(30, (parseInt($('bpmInput').value, 10) || 120) - 5); applyBpm();
  });
  $('bpmPlus').addEventListener('click', function () {
    $('bpmInput').value = Math.min(240, (parseInt($('bpmInput').value, 10) || 120) + 5); applyBpm();
  });

  player.addEventListener('error', function () {
    if (!player.src) return;
    // O resultado expira ao fim de uma hora; o piano continua a tocar.
    state.mixAudio = false;
    $('mixAudio').classList.remove('on');
    toast('Original audio expired — the transcription still plays', 'err');
  });

  piano.onEnded = function () {
    if (state.loop) { pausedAt = 0; transportPlay(); }
    else { pausedAt = 0; state.playing = false; player.pause(); updatePlayIcon(); updateTransport(); }
  };

  /* ── Ciclo de desenho ───────────────────────────────────────────────── */

  var lastLit = '';
  var litNow = [];

  function frame() {
    requestAnimationFrame(frame);
    if (!state.score || $('stageResult').hidden) return;

    if (state.view === 'roll') drawRoll();
    if (state.view === 'sheet' && state.renderer && state.renderer.layout) updatePlayhead();

    if (state.playing) {
      updateTransport();
      // O <audio> escorrega; puxá-lo de volta quando passa de um limiar audível.
      if (state.mixAudio && player.src && !player.paused) {
        var drift = player.currentTime - transportPosition();
        if (Math.abs(drift) > 0.14) {
          try { player.currentTime = transportPosition(); } catch (e) {}
        }
      }
    }
  }

  function updatePlayhead() {
    var pos = transportPosition();
    var p = state.renderer.timeToPosition(pos);
    if (!p) { playhead.hidden = true; return; }
    playhead.hidden = false;
    playhead.style.left = (p.x + 20) + 'px';
    playhead.style.top = (p.y + 20) + 'px';
    playhead.style.height = p.height + 'px';

    // Acende as notas que estão a soar. Só se mexe no DOM quando o conjunto
    // muda - tocar em centenas de classes a 60 fps engasga o telemóvel.
    var active = state.renderer.activeAt(pos);
    var key = active.map(function (a) { return a.id; }).join(',');
    if (key !== lastLit) {
      litNow.forEach(function (el) { el.classList.remove('lit'); });
      litNow = active.map(function (a) { return a.el; });
      litNow.forEach(function (el) { el.classList.add('lit'); });
      lastLit = key;
      if (state.playing) scrollSheetTo(p);
    }
  }

  function scrollSheetTo(p) {
    var scroll = $('sheetScroll');
    var top = p.y;
    var view = scroll.scrollTop;
    var h = scroll.clientHeight;
    if (top < view + 20 || top > view + h - 120) {
      scroll.scrollTo({ top: Math.max(0, top - 40), behavior: 'smooth' });
    }
  }

  requestAnimationFrame(frame);

  /* ── Exportar ───────────────────────────────────────────────────────── */

  $('downloadMidi').addEventListener('click', function (e) {
    // Sem edições, o ficheiro do servidor serve. Com edições, é preciso gerar.
    if (!state.dirty || !state.score) return;
    e.preventDefault();
    exportEditedMidi();
  });

  function exportEditedMidi() {
    var MidiCtor = window.Midi || (window.Tone && window.Tone.Midi);
    if (!MidiCtor) { toast('MIDI writer not loaded', 'err'); return; }
    try {
      var midi = new MidiCtor();
      midi.header.setTempo(state.score.bpm);
      try {
        midi.header.timeSignatures.push({
          ticks: 0,
          timeSignature: [state.score.timeSig.numerator, state.score.timeSig.denominator]
        });
      } catch (e) {}
      var track = midi.addTrack();
      track.name = 'Transcription';
      state.score.notes.forEach(function (n) {
        track.addNote({
          midi: n.pitch,
          time: n.start,
          duration: Math.max(0.05, n.end - n.start),
          velocity: Math.max(0.2, Math.min(1, n.velocity))
        });
      });
      var blob = new Blob([midi.toArray()], { type: 'audio/midi' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = (state.result && state.result.midi_filename) || 'transcription.mid';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      toast('MIDI exported with your edits', 'ok');
    } catch (err) {
      toast('Could not build the MIDI file', 'err');
    }
  }

  $('downloadPdf').addEventListener('click', function () {
    if (state.view !== 'sheet') { setView('sheet'); setTimeout(exportPdf, 220); }
    else exportPdf();
  });

  function exportPdf() {
    var JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    var svg = paper.querySelector('svg');
    if (!JsPDF || !svg) { toast('Open the Sheet view first', 'err'); return; }
    toast('Building PDF…');

    var wPx = parseFloat(svg.getAttribute('width')) || 900;
    var hPx = parseFloat(svg.getAttribute('height')) || 600;
    var scale = 2;
    var data = new XMLSerializer().serializeToString(svg);
    var url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(data)));

    var img = new Image();
    img.onload = function () {
      try {
        var full = document.createElement('canvas');
        full.width = wPx * scale;
        full.height = hPx * scale;
        var c = full.getContext('2d');
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, full.width, full.height);
        c.drawImage(img, 0, 0, full.width, full.height);

        var doc = new JsPDF({ orientation: 'p', unit: 'pt', format: 'a4' });
        var pageW = 595.28, pageH = 841.89;
        var margin = 28;
        var systemH = (state.renderer.layout.systemHeight || 190) * scale;
        var perPage = Math.max(1, Math.floor(((pageH - margin * 2) / (pageW - margin * 2) * full.width) / systemH));
        var sliceH = perPage * systemH;

        var y = 0, page = 0;
        while (y < full.height) {
          var h = Math.min(sliceH, full.height - y);
          if (page > 0) doc.addPage();
          var pc = document.createElement('canvas');
          pc.width = full.width;
          pc.height = h;
          var pcx = pc.getContext('2d');
          pcx.fillStyle = '#ffffff';
          pcx.fillRect(0, 0, pc.width, pc.height);
          pcx.drawImage(full, 0, y, full.width, h, 0, 0, full.width, h);

          var availW = pageW - margin * 2;
          var drawW = availW;
          var drawH = h * (availW / full.width);
          if (drawH > pageH - margin * 2) {
            drawH = pageH - margin * 2;
            drawW = full.width * (drawH / h);
          }
          doc.addImage(pc.toDataURL('image/png'), 'PNG', margin, margin, drawW, drawH);
          y += h;
          page++;
        }
        var name = ((state.result && state.result.source_name) || 'score').replace(/[^\w-]+/g, '_');
        doc.save(name + '.pdf');
        toast('PDF saved', 'ok');
      } catch (err) {
        toast('PDF export failed', 'err');
      }
    };
    img.onerror = function () { toast('PDF export failed', 'err'); };
    img.src = url;
  }

  /* ── Recomeçar ──────────────────────────────────────────────────────── */

  $('resetBtn').addEventListener('click', function () {
    // Com o link a guardar tudo, começar de novo já não deita nada fora: o
    // trabalho continua a viver na sua morada. Só avisa se ficou por gravar.
    if (state.dirty && !state.saved &&
        !confirm('The last edit has not been saved yet. Start over anyway?')) return;
    transportPause();
    flushSave();
    var rid = state.result && state.result.result_id;
    if (rid && !state.token) {
      fetch('/results/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result_id: rid })
      }).catch(function () {});
    }
    state.token = null;
    $('shareBlock').hidden = true;
    $('shareBtnTop').hidden = true;
    try { history.replaceState(null, '', '/'); } catch (e) {}
    state.result = null;
    state.score = null;
    state.renderer = null;
    state.selection = [];
    state.dirty = false;
    state.saved = true;
    pausedAt = 0;
    player.removeAttribute('src');
    player.load();
    setEditing(false);
    setStage('empty');
    shell.classList.remove('sidebar-collapsed');
  });

  /* ── Atalhos ────────────────────────────────────────────────────────── */

  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (!state.score || $('stageResult').hidden) return;

    var mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) { if (state.score.redo()) { state.selection = []; toast('Redone'); } }
      else if (state.score.undo()) { state.selection = []; toast('Undone'); }
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      if (state.score.redo()) { state.selection = []; toast('Redone'); }
      return;
    }
    if (mod) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (state.playing) transportPause(); else transportPlay();
        break;
      case 'e': case 'E':
        setEditing(!state.editing);
        break;
      case 'a': case 'A':
        if (state.editing) setAdding(!state.adding);
        break;
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!state.selection.length) return;
        e.preventDefault();
        var step = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        state.score.transpose(state.selection, step);
        var ps = state.selection.map(function (id) {
          var n = state.score.byId(id);
          return n ? n.pitch : null;
        }).filter(function (x) { return x != null; });
        if (ps.length) piano.pluck(ps, 0.3);
        break;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (!state.selection.length) {
          e.preventDefault();
          transportSeek(transportPosition() + (e.key === 'ArrowRight' ? 5 : -5));
          return;
        }
        e.preventDefault();
        state.score.nudgeTime(state.selection, e.key === 'ArrowRight' ? 1 : -1);
        break;
      }
      case 'Delete':
      case 'Backspace':
        if (state.selection.length) {
          e.preventDefault();
          state.score.remove(state.selection);
          state.selection = [];
          toast('Deleted');
        }
        break;
      case '1': setView('roll'); break;
      case '2': setView('sheet'); break;
    }
  });

  /* Pedal com a tecla shift no piano ao vivo */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Shift' && !e.repeat) piano.setSustain(true);
  });
  document.addEventListener('keyup', function (e) {
    if (e.key === 'Shift') piano.setSustain(false);
  });

  /* ── Abrir um trabalho guardado, ou retomar um job em curso ─────────── */

  function openProject(token) {
    setStage('loading');
    setProgress(0.35, 'Opening your score');
    fetch('/api/p/' + token)
      .then(function (r) {
        if (!r.ok) throw new Error(r.status === 404
          ? 'That link has expired or does not exist.'
          : 'Could not open that link.');
        return r.json();
      })
      .then(function (data) {
        setProgress(1, 'Done');
        showResult(data);
        if (data.audio_available === false) {
          toast('The original audio expired — the score still plays', 'err');
        }
      })
      .catch(function (err) {
        setStage('empty');
        showError(err.message || 'Could not open that link.');
        try { history.replaceState(null, '', '/'); } catch (e) {}
      });
  }

  (function boot() {
    if (CFG.bootstrapToken) { openProject(CFG.bootstrapToken); return; }
    var saved = null;
    try { saved = localStorage.getItem('ast_job'); } catch (e) {}
    if (!saved) return;
    state.jobId = saved;
    setStage('loading');
    setProgress(0.05, 'Reconnecting');
    pollJob();
  })();

  /* Fechar o separador a meio da gravação não pode perder a última edição. */
  function flushSave() {
    if (state.saved || !state.token || !state.score) return;
    clearTimeout(saveTimer);
    var body = JSON.stringify({
      notes: notesForSave(),
      meta: {
        bpm: state.score.bpm,
        time_signature: {
          numerator: state.score.timeSig.numerator,
          denominator: state.score.timeSig.denominator
        }
      }
    });
    var sent = false;
    if (navigator.sendBeacon) {
      try {
        sent = navigator.sendBeacon('/api/p/' + state.token + '/notes',
          new Blob([body], { type: 'application/json' }));
      } catch (e) { sent = false; }
    }
    if (sent) state.saved = true;
  }

  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushSave();
  });

  /* Só avisa se houver mesmo algo por gravar - com o link a guardar sozinho,
     o aviso de sempre era só um susto desnecessário. */
  window.addEventListener('beforeunload', function (e) {
    flushSave();
    if (state.dirty && !state.saved) { e.preventDefault(); e.returnValue = ''; }
  });

  loadExamples();
})();
