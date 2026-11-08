/*
 * PianoEngine - piano sintetizado + agendador de precisão.
 *
 * Duas coisas em vez de uma, porque estão acopladas pelo relógio:
 *
 *   1. A voz. Um piano de verdade não é um seno: o martelo bate (ruído curto),
 *      o espectro nasce brilhante e escurece à medida que os parciais agudos
 *      morrem primeiro, e o grave sustenta segundos enquanto o agudo morre em
 *      menos de um. Três osciladores com ondas periódicas próprias (fundamental,
 *      corpo, ataque) mais um estalo de ruído dão isso a três osciladores por
 *      nota - barato o suficiente para um telemóvel aguentar polifonia real.
 *
 *   2. O agendador. Tocar notas com setTimeout dentro de um requestAnimationFrame
 *      dá exatamente o que se ouvia antes: notas trocadas, notas comidas, ritmo
 *      a escorregar. Aqui as notas são marcadas no relógio do AudioContext com
 *      antecedência, e a animação limita-se a ler esse relógio.
 */
/*
 * Nota sobre o som: os três osciladores acima são o plano B. Quando as
 * gravações de um piano de cauda a sério (Salamander, uma nota a cada terceira
 * menor) acabam de carregar, as vozes passam a sair de lá - martelo, madeira,
 * ressonância e tudo. O sintetizador continua a tocar enquanto isso não
 * acontece, e para sempre se o carregamento falhar.
 */
(function (global) {
  'use strict';

  var LOOKAHEAD_MS = 25;      // com que frequência o agendador acorda
  var SCHEDULE_WINDOW = 0.12; // quanto do futuro ele marca de cada vez (s)
  var MAX_VOICES = 24;        // acima disto rouba a voz mais antiga

  // Ficheiro -> altura MIDI. 's' é sustenido, à maneira do Salamander.
  var SAMPLE_NOTES = [
    'A0', 'C1', 'Ds1', 'Fs1', 'A1', 'C2', 'Ds2', 'Fs2', 'A2', 'C3',
    'Ds3', 'Fs3', 'A3', 'C4', 'Ds4', 'Fs4', 'A4', 'C5', 'Ds5', 'Fs5',
    'A5', 'C6', 'Ds6', 'Fs6', 'A6', 'C7', 'Ds7', 'Fs7', 'A7', 'C8'
  ];
  var SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function sampleNameToMidi(name) {
    var letter = name[0];
    var sharp = name.length > 2 ? 1 : 0;
    var octave = parseInt(name[name.length - 1], 10);
    return 12 * (octave + 1) + SEMITONE[letter] + sharp;
  }

  /* Quanto de cada gravação vale a pena guardar na memória. Um telemóvel com
     pouca RAM não aguenta 30 buffers de 8 s estéreo, e ninguém dá pela cauda
     que falta: o abafador cai muito antes disso. */
  function keepSeconds(pitch) {
    if (pitch < 48) return 5.0;
    if (pitch < 72) return 3.2;
    return 2.0;
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // ── Ondas periódicas ─────────────────────────────────────────────────────
  // Três bandas de parciais. Cada uma ganha o seu envelope, e é a diferença
  // entre os envelopes que faz o som "abrir e fechar" como um piano.

  function buildWave(ctx, partials) {
    var n = partials.length + 1;
    var real = new Float32Array(n);
    var imag = new Float32Array(n);
    for (var i = 0; i < partials.length; i++) imag[i + 1] = partials[i];
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  function makeWaves(ctx) {
    return {
      // fundamental com um toque de 2.º - é o que sobra no fim da nota
      core: buildWave(ctx, [1.0, 0.18, 0.04]),
      // corpo: onde vive o timbre
      body: buildWave(ctx, [0.0, 0.55, 0.42, 0.30, 0.20, 0.13, 0.09]),
      // ataque: brilho que desaparece em fração de segundo
      edge: buildWave(ctx, [0.0, 0.0, 0.0, 0.28, 0.24, 0.20, 0.17, 0.13, 0.11, 0.08, 0.06])
    };
  }

  // Um piano decai muito mais depressa no agudo do que no grave.
  function decayFor(pitch) {
    var t = Math.max(0, Math.min(1, (pitch - 21) / 87));
    return {
      core: 14.0 * Math.pow(0.16, t) + 0.55,  // ~14 s no lá0, ~0.8 s no dó8
      body: 6.0 * Math.pow(0.14, t) + 0.35,
      edge: 0.85 * Math.pow(0.35, t) + 0.07
    };
  }

  // Notas graves precisam de menos ganho para pesarem o mesmo.
  function gainFor(pitch, velocity) {
    var v = Math.max(0.05, Math.min(1, velocity));
    var t = Math.max(0, Math.min(1, (pitch - 21) / 87));
    var registerTrim = 0.55 + 0.45 * (1 - t);
    return Math.pow(v, 1.4) * registerTrim;
  }

  // ── Reverb curto, gerado (nada de ficheiros para descarregar) ────────────
  function makeImpulse(ctx, seconds, decay) {
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        var t = i / len;
        // ruído a esmorecer, com uma pré-atenuação que evita o "splash" inicial
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * Math.min(1, t * 40);
      }
    }
    return buf;
  }

  function PianoEngine() {
    this.ctx = null;
    this.ready = false;
    this.voices = {};        // id -> voz viva
    this.heldByPitch = {};   // pitch -> id, para notas seguradas pelo teclado
    this._voiceSeq = 0;
    this.sustain = false;
    this._sustained = [];

    // gravações do piano real
    this.samples = [];       // [{ pitch, buffer }] ordenado por altura
    this.samplesReady = false;
    this._samplesLoading = false;

    // estado de reprodução
    this.playing = false;
    this._timer = null;
    this._events = null;
    this._cursor = 0;        // índice do próximo evento a marcar
    this._startCtxTime = 0;
    this._startPos = 0;
    this._rate = 1;
    this._duration = 0;
    this.onEnded = null;
  }

  PianoEngine.prototype.init = function () {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    var Ctx = global.AudioContext || global.webkitAudioContext;
    var ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.waves = makeWaves(ctx);

    // cadeia: vozes -> soma -> brilho -> limitador -> saída
    //                       \-> reverb -> saída
    this.busDry = ctx.createGain();
    this.busDry.gain.value = 1;

    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 8200;
    this.tone.Q.value = 0.4;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.18;

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;

    this.reverb = ctx.createConvolver();
    try {
      this.reverb.buffer = makeImpulse(ctx, 1.9, 2.6);
    } catch (e) { this.reverb = null; }
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.16;

    this.busDry.connect(this.tone);
    this.tone.connect(this.limiter);
    if (this.reverb) {
      this.tone.connect(this.reverbSend);
      this.reverbSend.connect(this.reverb);
      this.reverb.connect(this.limiter);
    }
    this.limiter.connect(this.master);
    this.master.connect(ctx.destination);

    // ruído do martelo, gerado uma vez e reutilizado
    var nlen = Math.floor(ctx.sampleRate * 0.06);
    this.noiseBuf = ctx.createBuffer(1, nlen, ctx.sampleRate);
    var nd = this.noiseBuf.getChannelData(0);
    for (var i = 0; i < nlen; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / nlen);

    this.ready = true;
    return ctx;
  };

  PianoEngine.prototype.resume = function () {
    if (this.ctx && this.ctx.state === 'suspended') return this.ctx.resume();
    return Promise.resolve();
  };

  PianoEngine.prototype.setVolume = function (v) {
    if (!this.ctx) return;
    var g = Math.max(0, Math.min(1, v));
    this.master.gain.setTargetAtTime(g * 0.85, this.ctx.currentTime, 0.02);
  };

  /* ── Gravações do piano real ──────────────────────────────────────────── */

  function decodeAudio(ctx, arrayBuffer) {
    return new Promise(function (resolve, reject) {
      // A forma com callbacks é a única que o Safari mais velho aceita, e as
      // implementações modernas continuam a suportá-la.
      var p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  /* Corta a cauda e junta os canais: menos de metade da memória, sem
     diferença audível depois de o abafador cair. */
  function trimToMono(ctx, buffer, seconds) {
    var len = Math.min(buffer.length, Math.floor(seconds * buffer.sampleRate));
    var out = ctx.createBuffer(1, len, buffer.sampleRate);
    var dst = out.getChannelData(0);
    var chans = buffer.numberOfChannels;
    var a = buffer.getChannelData(0);
    var b = chans > 1 ? buffer.getChannelData(1) : null;
    for (var i = 0; i < len; i++) dst[i] = b ? (a[i] + b[i]) * 0.5 : a[i];

    // Desvanecer o corte, senão fica um estalo no fim de cada nota longa.
    var fade = Math.min(len, Math.floor(0.09 * buffer.sampleRate));
    for (var j = 0; j < fade; j++) dst[len - fade + j] *= 1 - j / fade;
    return out;
  }

  /**
   * Carrega as gravações do piano em segundo plano. Cada nota que chega entra
   * logo ao serviço; o sintetizador cobre o que ainda falta.
   */
  PianoEngine.prototype.useSamples = function (baseUrl) {
    if (this._samplesLoading || this.samplesReady) return;
    this._samplesLoading = true;

    var ctx = this.init();
    var self = this;
    var base = baseUrl || '/static/audio/piano/';
    if (base.charAt(base.length - 1) !== '/') base += '/';

    // Do centro para fora: as oitavas centrais são as que quase toda a música
    // usa, e são as primeiras que se ouvem.
    var queue = SAMPLE_NOTES.slice().sort(function (a, b) {
      return Math.abs(sampleNameToMidi(a) - 60) - Math.abs(sampleNameToMidi(b) - 60);
    });
    var loaded = [];

    function loadNext() {
      var name = queue.shift();
      if (!name) return Promise.resolve();
      var pitch = sampleNameToMidi(name);
      return fetch(base + name + '.mp3')
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        })
        .then(function (raw) { return decodeAudio(ctx, raw); })
        .then(function (audio) {
          loaded.push({ pitch: pitch, buffer: trimToMono(ctx, audio, keepSeconds(pitch)) });
          loaded.sort(function (x, y) { return x.pitch - y.pitch; });
          self.samples = loaded;
          // Com meia dúzia de notas já cobre o centro do teclado; esperar pelas
          // trinta só atrasaria o momento em que deixa de soar a sintetizador.
          if (loaded.length >= 6) self.samplesReady = true;
        })
        .catch(function () { /* uma gravação a menos: o sintetizador cobre */ })
        .then(loadNext);
    }

    var lanes = [];
    for (var i = 0; i < 3; i++) lanes.push(loadNext());   // o túnel é estreito
    Promise.all(lanes).then(function () {
      self._samplesLoading = false;
      if (loaded.length) self.samplesReady = true;
    });
  };

  PianoEngine.prototype._nearestSample = function (pitch) {
    var best = null, bestDist = Infinity;
    for (var i = 0; i < this.samples.length; i++) {
      var d = Math.abs(this.samples[i].pitch - pitch);
      if (d < bestDist) { bestDist = d; best = this.samples[i]; }
      else if (this.samples[i].pitch > pitch) break;   // a lista está ordenada
    }
    return best;
  };

  /* ── Uma voz ──────────────────────────────────────────────────────────── */

  PianoEngine.prototype._startVoice = function (pitch, velocity, when, duration) {
    var ctx = this.init();
    if (this.samplesReady && this.samples.length) {
      return this._startSampledVoice(pitch, velocity, when, duration);
    }
    var t0 = Math.max(when || 0, ctx.currentTime);
    var freq = midiToFreq(pitch);
    var dec = decayFor(pitch);
    var amp = gainFor(pitch, velocity == null ? 0.8 : velocity);

    if (this._countVoices() >= MAX_VOICES) this._stealOldest();

    var out = ctx.createGain();
    out.gain.value = amp;
    out.connect(this.busDry);

    var layers = [];
    var self = this;

    function layer(wave, level, decaySeconds) {
      var osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = freq;
      var g = ctx.createGain();
      // ataque de 3 ms: instantâneo ao ouvido, mas sem o "click" do degrau
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(level, t0 + 0.003);
      // decaimento exponencial contínuo, como uma corda a perder energia
      g.gain.setTargetAtTime(0.0001, t0 + 0.003, decaySeconds / 3);
      osc.connect(g);
      g.connect(out);
      osc.start(t0);
      layers.push({ osc: osc, gain: g });
    }

    // Mais velocidade = mais brilho, não só mais volume. É isto que distingue
    // um piano tocado com força de um piano com o volume no máximo.
    var bright = 0.35 + 0.65 * Math.max(0, Math.min(1, velocity == null ? 0.8 : velocity));
    layer(this.waves.core, 0.55, dec.core);
    layer(this.waves.body, 0.42 * bright, dec.body);
    layer(this.waves.edge, 0.22 * bright * bright, dec.edge);

    // estalo do martelo
    var noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    var nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = Math.min(9000, freq * 4);
    nf.Q.value = 0.8;
    var ng = ctx.createGain();
    ng.gain.setValueAtTime(0.10 * bright, t0);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    noise.connect(nf); nf.connect(ng); ng.connect(out);
    noise.start(t0);
    noise.stop(t0 + 0.06);

    var id = ++this._voiceSeq;
    var voice = {
      id: id, pitch: pitch, out: out, layers: layers,
      startedAt: t0, released: false, maxDecay: dec.core
    };
    this.voices[id] = voice;

    if (duration != null && duration > 0) {
      this._release(voice, t0 + duration);
    }
    return voice;
  };

  /* A mesma voz, mas com um piano de verdade lá dentro. */
  PianoEngine.prototype._startSampledVoice = function (pitch, velocity, when, duration) {
    var ctx = this.ctx;
    var sample = this._nearestSample(pitch);
    if (!sample) return null;

    var t0 = Math.max(when || 0, ctx.currentTime);
    var v = Math.max(0.05, Math.min(1, velocity == null ? 0.8 : velocity));

    if (this._countVoices() >= MAX_VOICES) this._stealOldest();

    var out = ctx.createGain();
    out.gain.value = Math.pow(v, 1.25);
    out.connect(this.busDry);

    // Cada gravação tem uma dinâmica só. Tocar mais fraco não é baixar o
    // volume, é perder brilho - o filtro é que faz o piano soar tocado com
    // suavidade em vez de soar longe.
    var tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = Math.min(18000, 1400 + 9000 * Math.pow(v, 1.6));
    tone.Q.value = 0.7;
    tone.connect(out);

    var src = ctx.createBufferSource();
    src.buffer = sample.buffer;
    // No máximo uma terça menor de distância: o piano continua a soar a piano.
    src.playbackRate.value = Math.pow(2, (pitch - sample.pitch) / 12);
    var g = ctx.createGain();
    g.gain.value = 1;
    src.connect(g);
    g.connect(tone);
    src.start(t0);

    var id = ++this._voiceSeq;
    var voice = {
      id: id, pitch: pitch, out: out, layers: [{ osc: src, gain: g }],
      startedAt: t0, released: false, maxDecay: sample.buffer.duration
    };
    this.voices[id] = voice;

    // Uma nota que chega ao fim da gravação sem ser abafada tem de sair da
    // lista à mesma, senão o contador de vozes enche-se de fantasmas.
    var self = this;
    src.onended = function () {
      try { out.disconnect(); } catch (e) {}
      delete self.voices[id];
      // Só se ainda for esta a voz desta tecla: entretanto pode ter sido
      // repicada e a seguinte é que manda.
      if (self.heldByPitch[pitch] === id) delete self.heldByPitch[pitch];
    };

    if (duration != null && duration > 0) {
      this._release(voice, t0 + duration);
    }
    return voice;
  };

  PianoEngine.prototype._countVoices = function () {
    return Object.keys(this.voices).length;
  };

  PianoEngine.prototype._stealOldest = function () {
    var oldest = null;
    for (var id in this.voices) {
      var v = this.voices[id];
      if (!oldest || v.startedAt < oldest.startedAt) oldest = v;
    }
    if (oldest) this._release(oldest, this.ctx.currentTime, 0.04);
  };

  /* Abafador: o feltro cai sobre a corda. Rápido, mas não instantâneo - e mais
     lento no grave, onde a corda tem mais energia para dissipar. */
  PianoEngine.prototype._release = function (voice, when, fadeOverride) {
    if (!voice || voice.released) return;
    voice.released = true;
    var ctx = this.ctx;
    var t = Math.max(when || 0, ctx.currentTime);
    var fade = fadeOverride != null
      ? fadeOverride
      : 0.08 + 0.20 * Math.max(0, Math.min(1, (60 - voice.pitch) / 40));

    voice.out.gain.cancelScheduledValues(t);
    voice.out.gain.setValueAtTime(Math.max(0.0001, voice.out.gain.value), t);
    voice.out.gain.setTargetAtTime(0.0001, t, fade / 3);

    var stopAt = t + fade + 0.12;
    for (var i = 0; i < voice.layers.length; i++) {
      try { voice.layers[i].osc.stop(stopAt); } catch (e) {}
    }
    var self = this;
    var delayMs = Math.max(0, (stopAt - ctx.currentTime) * 1000) + 40;
    setTimeout(function () {
      try { voice.out.disconnect(); } catch (e) {}
      delete self.voices[voice.id];
    }, delayMs);
  };

  /* ── Teclado ao vivo ──────────────────────────────────────────────────── */

  PianoEngine.prototype.noteOn = function (pitch, velocity) {
    this.init();
    var existing = this.heldByPitch[pitch];
    if (existing && this.voices[existing]) {
      // retrigger: abafa a anterior rapidamente em vez de somar duas cópias
      this._release(this.voices[existing], this.ctx.currentTime, 0.02);
    }
    var v = this._startVoice(pitch, velocity == null ? 0.8 : velocity, this.ctx.currentTime, null);
    this.heldByPitch[pitch] = v.id;
    return v;
  };

  PianoEngine.prototype.noteOff = function (pitch) {
    var id = this.heldByPitch[pitch];
    if (!id) return;
    delete this.heldByPitch[pitch];
    var v = this.voices[id];
    if (!v) return;
    if (this.sustain) this._sustained.push(v);
    else this._release(v, this.ctx.currentTime);
  };

  PianoEngine.prototype.setSustain = function (on) {
    this.sustain = !!on;
    if (!on) {
      for (var i = 0; i < this._sustained.length; i++) {
        this._release(this._sustained[i], this.ctx.currentTime);
      }
      this._sustained = [];
    }
  };

  /* Toque curto e solto - usado ao clicar numa nota da pauta. */
  PianoEngine.prototype.pluck = function (pitches, duration, velocity) {
    this.init();
    var arr = Array.isArray(pitches) ? pitches : [pitches];
    var dur = Math.max(0.08, Math.min(6, duration || 0.4));
    var now = this.ctx.currentTime + 0.005;
    for (var i = 0; i < arr.length; i++) {
      this._startVoice(arr[i], velocity == null ? 0.8 : velocity, now, dur);
    }
  };

  PianoEngine.prototype.allOff = function (fast) {
    for (var id in this.voices) {
      this._release(this.voices[id], this.ctx ? this.ctx.currentTime : 0, fast ? 0.02 : undefined);
    }
    this.heldByPitch = {};
    this._sustained = [];
  };

  /* ── Reprodução agendada ──────────────────────────────────────────────── */

  /**
   * events: [{ start, end, pitch, velocity }] em segundos, ordenados por start.
   */
  PianoEngine.prototype.load = function (events, duration) {
    this._events = (events || []).slice().sort(function (a, b) { return a.start - b.start; });
    this._duration = duration || (this._events.length
      ? this._events[this._events.length - 1].end + 0.5
      : 0);
  };

  PianoEngine.prototype.play = function (fromSeconds, rate) {
    if (!this._events || !this._events.length) return;
    this.init();
    this.resume();
    this.stop(true);

    this._rate = rate && rate > 0 ? rate : 1;
    this._startPos = Math.max(0, fromSeconds || 0);
    this._startCtxTime = this.ctx.currentTime + 0.06; // margem para o 1.º lote
    this._cursor = 0;
    while (this._cursor < this._events.length &&
           this._events[this._cursor].start < this._startPos) {
      this._cursor++;
    }
    this.playing = true;

    var self = this;
    this._tick();
    this._timer = setInterval(function () { self._tick(); }, LOOKAHEAD_MS);
  };

  PianoEngine.prototype._tick = function () {
    if (!this.playing) return;
    var ctx = this.ctx;
    var horizonPos = this.position() + SCHEDULE_WINDOW * this._rate;

    while (this._cursor < this._events.length) {
      var ev = this._events[this._cursor];
      if (ev.start > horizonPos) break;
      var when = this._startCtxTime + (ev.start - this._startPos) / this._rate;
      var dur = Math.max(0.05, (ev.end - ev.start) / this._rate);
      if (when >= ctx.currentTime - 0.05) {
        this._startVoice(ev.pitch, ev.velocity == null ? 0.78 : ev.velocity, when, dur);
      }
      this._cursor++;
    }

    if (this._cursor >= this._events.length && this.position() >= this._duration) {
      var cb = this.onEnded;
      this.stop();
      if (cb) cb();
    }
  };

  /** Posição atual em segundos do material, lida do relógio de áudio. */
  PianoEngine.prototype.position = function () {
    if (!this.playing || !this.ctx) return this._startPos;
    return this._startPos + (this.ctx.currentTime - this._startCtxTime) * this._rate;
  };

  PianoEngine.prototype.stop = function (keepPosition) {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.playing && !keepPosition) this._startPos = this.position();
    this.playing = false;
    this.allOff(true);
  };

  PianoEngine.prototype.seek = function (seconds) {
    var wasPlaying = this.playing;
    var rate = this._rate;
    this.stop(true);
    this._startPos = Math.max(0, seconds || 0);
    if (wasPlaying) this.play(this._startPos, rate);
  };

  PianoEngine.prototype.isPlaying = function () { return this.playing; };
  PianoEngine.prototype.duration = function () { return this._duration; };

  global.PianoEngine = PianoEngine;
  global.piano = new PianoEngine();
})(window);
