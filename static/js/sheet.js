/*
 * Score - modelo, gravação e edição da partitura.
 *
 * O que estava mal antes e o que aqui muda:
 *
 *   Ritmo. A duração de cada nota era arredondada isoladamente, pelo que os
 *   compassos raramente somavam o que deviam e o VexFlow desenhava o que
 *   calhava. Aqui cada compasso é uma grelha de semicolcheias: as notas caem
 *   em casas, a duração sai do número de casas até à nota seguinte, e o que
 *   sobra vira pausa. Um compasso soma sempre certo.
 *
 *   Armadura. Tudo era escrito em dó maior, com um sustenido colado a cada
 *   nota preta. Agora a tonalidade é estimada (Krumhansl-Schmuckler) e as
 *   notas são soletradas dentro dela, com memória de alterações por compasso.
 *
 *   Mãos. O corte era pitch >= 60, fixo. Agora o ponto de corte segue a peça.
 */
(function (global) {
  'use strict';

  var SHARP_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
  var FLAT_KEYS = ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];
  var LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  var SEMITONE_OF_LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  // Perfis de Krumhansl-Schmuckler: quanto "pesa" cada grau numa tonalidade.
  var MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  var MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  var PC_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  // Relativa maior de cada menor, para escolher a armadura certa.
  var MINOR_TO_RELATIVE_MAJOR = ['Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B', 'C', 'Db', 'D'];

  /* ── Tonalidade ─────────────────────────────────────────────────────── */

  function detectKey(notes) {
    if (!notes || !notes.length) return { name: 'C', isMinor: false };
    var hist = new Array(12).fill(0);
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      // Pesar pela duração: uma semínima conta mais do que uma passagem rápida.
      hist[((n.pitch % 12) + 12) % 12] += Math.max(0.05, n.end - n.start);
    }

    function correlate(profile, rotation) {
      var sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0, n = 12;
      for (var k = 0; k < 12; k++) {
        var x = hist[(k + rotation) % 12];
        var y = profile[k];
        sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y;
      }
      var num = n * sxy - sx * sy;
      var den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
      return den === 0 ? 0 : num / den;
    }

    var best = { score: -Infinity, tonic: 0, isMinor: false };
    for (var r = 0; r < 12; r++) {
      var maj = correlate(MAJOR_PROFILE, r);
      if (maj > best.score) best = { score: maj, tonic: r, isMinor: false };
      var min = correlate(MINOR_PROFILE, r);
      if (min > best.score) best = { score: min, tonic: r, isMinor: true };
    }

    var name = best.isMinor ? MINOR_TO_RELATIVE_MAJOR[best.tonic] : PC_NAMES[best.tonic];
    // VexFlow só aceita armaduras existentes; empurrar enarmónicos raros.
    if (name === 'C#') name = 'Db';
    if (name === 'D#') name = 'Eb';
    if (name === 'G#') name = 'Ab';
    if (name === 'A#') name = 'Bb';
    return { name: name, isMinor: best.isMinor, tonicPc: best.tonic, confidence: best.score };
  }

  function keyAccidentals(keyName) {
    /* Devolve { letra: alteração } com o que a armadura já garante. */
    var sharpOrder = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
    var flatOrder = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
    var map = {};
    var idx = SHARP_KEYS.indexOf(keyName);
    if (idx > 0) {
      for (var i = 0; i < idx; i++) map[sharpOrder[i]] = 1;
      return map;
    }
    idx = FLAT_KEYS.indexOf(keyName);
    if (idx > 0) {
      for (var j = 0; j < idx; j++) map[flatOrder[j]] = -1;
    }
    return map;
  }

  /* Soletra uma nota MIDI dentro da tonalidade: devolve letra, alteração e oitava.
     Evita de propósito B#/Cb/E#/Fb - não valem a confusão de oitava que causam. */
  function spellPitch(pitch, keyName) {
    var pc = ((pitch % 12) + 12) % 12;
    var octave = Math.floor(pitch / 12) - 1;
    var preferFlat = FLAT_KEYS.indexOf(keyName) > 0;

    var natural = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' }[pc];
    if (natural) return { letter: natural, alter: 0, octave: octave };

    var sharpOf = { 1: 'C', 3: 'D', 6: 'F', 8: 'G', 10: 'A' }[pc];
    var flatOf = { 1: 'D', 3: 'E', 6: 'G', 8: 'A', 10: 'B' }[pc];
    if (preferFlat) return { letter: flatOf, alter: -1, octave: octave };
    return { letter: sharpOf, alter: 1, octave: octave };
  }

  function spellToVexKey(spell) {
    var acc = spell.alter === 1 ? '#' : (spell.alter === -1 ? 'b' : '');
    return spell.letter.toLowerCase() + acc + '/' + spell.octave;
  }

  /* ── Grelha rítmica ─────────────────────────────────────────────────── */

  // slots de semicolcheia -> duração VexFlow. Ordem decrescente para o guloso.
  var SLOT_DURATIONS = [
    { slots: 16, dur: 'w' },
    { slots: 12, dur: 'hd' },
    { slots: 8, dur: 'h' },
    { slots: 6, dur: 'qd' },
    { slots: 4, dur: 'q' },
    { slots: 3, dur: '8d' },
    { slots: 2, dur: '8' },
    { slots: 1, dur: '16' }
  ];

  /* Parte um vão de N semicolcheias em durações reais (ligadas entre si). */
  function slotsToDurations(slots) {
    var out = [];
    var remaining = Math.max(1, Math.round(slots));
    var guard = 0;
    while (remaining > 0 && guard++ < 64) {
      var picked = null;
      for (var i = 0; i < SLOT_DURATIONS.length; i++) {
        if (SLOT_DURATIONS[i].slots <= remaining) { picked = SLOT_DURATIONS[i]; break; }
      }
      if (!picked) break;
      out.push(picked);
      remaining -= picked.slots;
    }
    return out.length ? out : [{ slots: 1, dur: '16' }];
  }

  function beatsPerMeasure(timeSig) {
    var num = (timeSig && timeSig.numerator) || 4;
    var den = (timeSig && timeSig.denominator) || 4;
    return num * (4 / den);
  }

  /* ── Modelo ─────────────────────────────────────────────────────────── */

  function Score(opts) {
    opts = opts || {};
    this.notes = [];       // { id, start, end, pitch, velocity }
    this.bpm = opts.bpm || 120;
    this.timeSig = opts.timeSig || { numerator: 4, denominator: 4 };
    this.beatOffset = opts.beatOffset || 0;
    this.duration = opts.duration || 0;
    this.key = { name: 'C', isMinor: false };
    this.splitPitch = 60;
    this._seq = 0;
    this._history = [];
    this._future = [];
    this.onChange = null;
  }

  Score.prototype.loadEvents = function (events, opts) {
    opts = opts || {};
    this._seq = 0;
    var self = this;
    this.notes = (events || []).map(function (e) {
      return {
        id: ++self._seq,
        start: Number(e.start_time != null ? e.start_time : e.start),
        end: Number(e.end_time != null ? e.end_time : e.end),
        pitch: Number(e.pitch),
        velocity: e.confidence != null ? Math.max(0.25, Math.min(1, Number(e.confidence))) : 0.8
      };
    }).filter(function (n) {
      return isFinite(n.start) && isFinite(n.end) && n.end > n.start && n.pitch >= 0 && n.pitch <= 127;
    });
    this.notes.sort(function (a, b) { return a.start - b.start || a.pitch - b.pitch; });

    if (opts.bpm) this.bpm = opts.bpm;
    if (opts.timeSig) this.timeSig = opts.timeSig;
    if (opts.beatOffset != null) this.beatOffset = opts.beatOffset;
    if (opts.duration) this.duration = opts.duration;

    this.key = detectKey(this.notes);
    this.splitPitch = this._chooseSplit();
    this._history = [];
    this._future = [];
    return this;
  };

  /* O corte entre mãos é o que produz menos linhas suplementares.
     A mediana das alturas não serve: numa peça só de mão direita mandava
     metade das notas para a clave de fá, cheias de linhas por cima. */
  Score.prototype._chooseSplit = function () {
    if (!this.notes.length) return 60;

    // Notas que a pauta desenha sem linhas suplementares.
    var TREBLE_LO = 64, TREBLE_HI = 77;   // mi4 - fá5
    var BASS_LO = 43, BASS_HI = 57;       // sol2 - lá3

    function ledgerCost(pitch, isTreble) {
      var lo = isTreble ? TREBLE_LO : BASS_LO;
      var hi = isTreble ? TREBLE_HI : BASS_HI;
      if (pitch < lo) return lo - pitch;
      if (pitch > hi) return pitch - hi;
      return 0;
    }

    var best = 60, bestCost = Infinity;
    for (var split = 48; split <= 72; split++) {
      var cost = 0;
      for (var i = 0; i < this.notes.length; i++) {
        var p = this.notes[i].pitch;
        cost += ledgerCost(p, p >= split);
      }
      // Empate vai para o dó central, que é onde o leitor espera o corte.
      cost += Math.abs(split - 60) * 0.35;
      if (cost < bestCost) { bestCost = cost; best = split; }
    }
    return best;
  };

  Score.prototype.playbackEvents = function () {
    return this.notes.map(function (n) {
      return { start: n.start, end: n.end, pitch: n.pitch, velocity: n.velocity };
    });
  };

  Score.prototype.totalDuration = function () {
    var last = 0;
    for (var i = 0; i < this.notes.length; i++) last = Math.max(last, this.notes[i].end);
    return Math.max(last, this.duration || 0);
  };

  /* ── Histórico ──────────────────────────────────────────────────────── */

  Score.prototype._snapshot = function () {
    return this.notes.map(function (n) {
      return { id: n.id, start: n.start, end: n.end, pitch: n.pitch, velocity: n.velocity };
    });
  };

  Score.prototype.beginEdit = function () {
    this._history.push(this._snapshot());
    if (this._history.length > 60) this._history.shift();
    this._future = [];
  };

  Score.prototype.commit = function () {
    this.notes.sort(function (a, b) { return a.start - b.start || a.pitch - b.pitch; });
    if (this.onChange) this.onChange();
  };

  Score.prototype.undo = function () {
    if (!this._history.length) return false;
    this._future.push(this._snapshot());
    this.notes = this._history.pop();
    this.commit();
    return true;
  };

  Score.prototype.redo = function () {
    if (!this._future.length) return false;
    this._history.push(this._snapshot());
    this.notes = this._future.pop();
    this.commit();
    return true;
  };

  Score.prototype.canUndo = function () { return this._history.length > 0; };
  Score.prototype.canRedo = function () { return this._future.length > 0; };

  /* ── Edições ────────────────────────────────────────────────────────── */

  Score.prototype.byId = function (id) {
    for (var i = 0; i < this.notes.length; i++) if (this.notes[i].id === id) return this.notes[i];
    return null;
  };

  Score.prototype.transpose = function (ids, semitones) {
    this.beginEdit();
    for (var i = 0; i < ids.length; i++) {
      var n = this.byId(ids[i]);
      if (n) n.pitch = Math.max(21, Math.min(108, n.pitch + semitones));
    }
    this.commit();
  };

  Score.prototype.setDuration = function (ids, slots) {
    /* slots em semicolcheias. */
    this.beginEdit();
    var sixteenth = (60 / this.bpm) / 4;
    for (var i = 0; i < ids.length; i++) {
      var n = this.byId(ids[i]);
      if (n) n.end = n.start + Math.max(sixteenth, slots * sixteenth);
    }
    this.commit();
  };

  Score.prototype.remove = function (ids) {
    this.beginEdit();
    var set = {};
    for (var i = 0; i < ids.length; i++) set[ids[i]] = true;
    this.notes = this.notes.filter(function (n) { return !set[n.id]; });
    this.commit();
  };

  Score.prototype.insert = function (start, pitch, slots) {
    this.beginEdit();
    var sixteenth = (60 / this.bpm) / 4;
    var note = {
      id: ++this._seq,
      start: Math.max(0, start),
      end: Math.max(0, start) + Math.max(sixteenth, (slots || 4) * sixteenth),
      pitch: Math.max(21, Math.min(108, Math.round(pitch))),
      velocity: 0.8
    };
    this.notes.push(note);
    this.commit();
    return note;
  };

  Score.prototype.nudgeTime = function (ids, slots) {
    this.beginEdit();
    var delta = slots * ((60 / this.bpm) / 4);
    for (var i = 0; i < ids.length; i++) {
      var n = this.byId(ids[i]);
      if (n) {
        var len = n.end - n.start;
        n.start = Math.max(0, n.start + delta);
        n.end = n.start + len;
      }
    }
    this.commit();
  };

  /* ── Compassos ──────────────────────────────────────────────────────── */

  /**
   * Constrói os compassos prontos a desenhar. Cada compasso tem duas pautas e
   * cada pauta tem uma lista de elementos { slots, dur, keys, ids, isRest }.
   */
  Score.prototype.buildMeasures = function () {
    var beatSec = 60 / this.bpm;
    var bpMeasure = beatsPerMeasure(this.timeSig);
    var measureSec = beatSec * bpMeasure;
    var slotsPerMeasure = Math.max(1, Math.round(bpMeasure * 4));
    var sixteenth = beatSec / 4;
    var total = this.totalDuration();
    var origin = 0;
    var count = Math.max(1, Math.ceil((total - origin) / measureSec));
    if (count > 400) count = 400; // travão: peças enormes não rebentam o browser

    var buckets = [];
    for (var m = 0; m < count; m++) buckets.push({ treble: {}, bass: {} });

    for (var i = 0; i < this.notes.length; i++) {
      var n = this.notes[i];
      var rel = n.start - origin;
      var mi = Math.floor(rel / measureSec);
      if (mi < 0 || mi >= count) continue;
      var slot = Math.round((rel - mi * measureSec) / sixteenth);
      if (slot >= slotsPerMeasure) { slot = slotsPerMeasure - 1; }
      if (slot < 0) slot = 0;
      var staff = n.pitch >= this.splitPitch ? 'treble' : 'bass';
      var bucket = buckets[mi][staff];
      if (!bucket[slot]) bucket[slot] = [];
      bucket[slot].push(n);
    }

    var measures = [];
    for (var mm = 0; mm < count; mm++) {
      measures.push({
        index: mm,
        startTime: origin + mm * measureSec,
        endTime: origin + (mm + 1) * measureSec,
        treble: this._layoutStaff(buckets[mm].treble, slotsPerMeasure, sixteenth, origin + mm * measureSec),
        bass: this._layoutStaff(buckets[mm].bass, slotsPerMeasure, sixteenth, origin + mm * measureSec)
      });
    }
    return {
      measures: measures,
      slotsPerMeasure: slotsPerMeasure,
      measureSec: measureSec,
      beatsPerMeasure: bpMeasure,
      origin: origin
    };
  };

  /* Transforma um dicionário casa->notas numa sequência que soma o compasso
     inteiro: acordes onde há notas, pausas onde não há. */
  Score.prototype._layoutStaff = function (bucket, slotsPerMeasure, sixteenth, measureStart) {
    var occupied = Object.keys(bucket).map(Number).sort(function (a, b) { return a - b; });
    var items = [];
    var cursor = 0;
    var self = this;

    function pushSpan(slots, chordNotes, atSlot) {
      var parts = slotsToDurations(slots);
      for (var p = 0; p < parts.length; p++) {
        var isFirst = p === 0;
        items.push({
          dur: parts[p].dur,
          slots: parts[p].slots,
          startSlot: atSlot,
          time: measureStart + atSlot * sixteenth,
          isRest: !chordNotes,
          notes: chordNotes || [],
          ids: chordNotes ? chordNotes.map(function (n) { return n.id; }) : [],
          tiedFromPrevious: !isFirst && !!chordNotes,
          tieToNext: !!chordNotes && p < parts.length - 1
        });
        atSlot += parts[p].slots;
      }
      return atSlot;
    }

    for (var i = 0; i < occupied.length; i++) {
      var slot = occupied[i];
      if (slot > cursor) cursor = pushSpan(slot - cursor, null, cursor);
      var nextSlot = i + 1 < occupied.length ? occupied[i + 1] : slotsPerMeasure;
      var chord = bucket[slot];
      // A nota dura até à próxima, mas nunca mais do que realmente soa.
      var longest = 0;
      for (var c = 0; c < chord.length; c++) {
        longest = Math.max(longest, chord[c].end - chord[c].start);
      }
      var wantedSlots = Math.max(1, Math.round(longest / sixteenth));
      var available = nextSlot - slot;
      var span = Math.max(1, Math.min(wantedSlots, available));
      // Uma nota curta seguida de um vão pequeno enchia o compasso de pausas de
      // semicolcheia e tornava tudo ilegível. Só se escreve pausa a partir da
      // semínima; abaixo disso a nota estende-se até à seguinte, que é como se
      // escreve uma transcrição à mão.
      var gap = available - span;
      if (gap > 0 && gap < 4) { span = available; gap = 0; }
      cursor = pushSpan(span, chord, slot);
      if (gap > 0) cursor = pushSpan(gap, null, cursor);
    }
    if (cursor < slotsPerMeasure) pushSpan(slotsPerMeasure - cursor, null, cursor);

    return items;
  };

  /* ── Gravação (VexFlow) ─────────────────────────────────────────────── */

  function Renderer(container, score) {
    this.container = container;
    this.score = score;
    this.noteMap = [];     // { ids, time, el, staff, measureIndex }
    this.measurePos = [];  // { index, x, y, width, lineIndex, startTime, endTime }
    this.layout = null;
  }

  Renderer.prototype.render = function (opts) {
    opts = opts || {};
    var VF = global.Vex && global.Vex.Flow;
    if (!VF) throw new Error('VexFlow not loaded');

    var score = this.score;
    var built = score.buildMeasures();
    var measures = built.measures;

    this.container.innerHTML = '';
    this.noteMap = [];
    this.measurePos = [];

    var containerWidth = Math.max(320, opts.width || this.container.clientWidth || 900);
    var padLeft = 16;
    var usable = containerWidth - padLeft * 2;
    // 190 px por compasso era o que fazia as colcheias encavalitarem-se umas
    // nas outras. Com o dobro, o formatador tem espaço para respirar.
    var minMeasureWidth = opts.minMeasureWidth || 320;
    var perLine = Math.max(1, Math.floor(usable / minMeasureWidth));
    var measureWidth = Math.floor(usable / perLine);

    // Uma pauta ocupa ~40 px. O que interessa é a folga: acima da clave de sol
    // e abaixo da de fá cabem notas com linhas suplementares, e sem folga elas
    // invadiam o sistema seguinte.
    var trebleY = 48;
    var bassY = trebleY + 124;
    var systemHeight = 296;
    var lines = Math.ceil(measures.length / perLine);
    var totalHeight = lines * systemHeight + 56;

    var renderer = new VF.Renderer(this.container, VF.Renderer.Backends.SVG);
    renderer.resize(containerWidth, totalHeight);
    var context = renderer.getContext();
    context.setFont('Arial', 10);

    var keyName = score.key.name;
    var keyMap = keyAccidentals(keyName);
    var self = this;

    for (var mi = 0; mi < measures.length; mi++) {
      var measure = measures[mi];
      var lineIndex = Math.floor(mi / perLine);
      var col = mi % perLine;
      var isFirstOfLine = col === 0;
      var x = padLeft + col * measureWidth;
      var yTop = lineIndex * systemHeight + trebleY;
      var yBottom = lineIndex * systemHeight + bassY;

      var treble = new VF.Stave(x, yTop, measureWidth);
      var bass = new VF.Stave(x, yBottom, measureWidth);

      if (isFirstOfLine) {
        treble.addClef('treble');
        bass.addClef('bass');
        if (keyName && keyName !== 'C') {
          treble.addKeySignature(keyName);
          bass.addKeySignature(keyName);
        }
      }
      if (mi === 0) {
        var tsText = score.timeSig.numerator + '/' + score.timeSig.denominator;
        treble.addTimeSignature(tsText);
        bass.addTimeSignature(tsText);
      }
      treble.setContext(context).draw();
      bass.setContext(context).draw();

      if (isFirstOfLine) {
        new VF.StaveConnector(treble, bass).setType(VF.StaveConnector.type.BRACE).setContext(context).draw();
        new VF.StaveConnector(treble, bass).setType(VF.StaveConnector.type.SINGLE_LEFT).setContext(context).draw();
      }
      new VF.StaveConnector(treble, bass).setType(VF.StaveConnector.type.SINGLE_RIGHT).setContext(context).draw();

      this.measurePos.push({
        index: mi, x: x, y: lineIndex * systemHeight, width: measureWidth,
        lineIndex: lineIndex, startTime: measure.startTime, endTime: measure.endTime,
        systemTop: lineIndex * systemHeight + trebleY - 28,
        systemHeight: (bassY - trebleY) + 72
      });

      this._drawStaff(context, treble, measure.treble, 'treble', keyMap, mi, measureWidth);
      this._drawStaff(context, bass, measure.bass, 'bass', keyMap, mi, measureWidth);
    }

    this.layout = {
      perLine: perLine, measureWidth: measureWidth, systemHeight: systemHeight,
      lines: lines, padLeft: padLeft, trebleY: trebleY, bassY: bassY,
      totalHeight: totalHeight, built: built,
      totalDuration: score.totalDuration()
    };
    return this.layout;
  };

  Renderer.prototype._drawStaff = function (context, stave, items, clef, keyMap, measureIndex, width) {
    var VF = global.Vex && global.Vex.Flow;
    var score = this.score;
    var self = this;
    if (!items.length) return;

    // Memória de alterações dentro do compasso, começando pela armadura.
    var measureState = {};
    function needsAccidental(spell) {
      var slot = spell.letter + spell.octave;
      var current = measureState[slot];
      if (current === undefined) current = keyMap[spell.letter] || 0;
      if (current === spell.alter) return null;
      measureState[slot] = spell.alter;
      return spell.alter === 1 ? '#' : (spell.alter === -1 ? 'b' : 'n');
    }

    var vfNotes = [];
    var ties = [];
    var meta = [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var note;
      if (item.isRest) {
        note = new VF.StaveNote({
          clef: clef,
          keys: [clef === 'treble' ? 'b/4' : 'd/3'],
          duration: item.dur + 'r'
        });
        // A duração 'qd' já conta o tempo certo, mas o ponto só aparece
        // se lhe for pendurado um modificador.
        if (item.dur.indexOf('d') >= 0) {
          try { note.addModifier(new VF.Dot(), 0); } catch (e) {}
        }
      } else {
        var sorted = item.notes.slice().sort(function (a, b) { return a.pitch - b.pitch; });
        var keys = [];
        var spells = [];
        for (var k = 0; k < sorted.length; k++) {
          var sp = spellPitch(sorted[k].pitch, score.key.name);
          spells.push(sp);
          keys.push(spellToVexKey(sp));
        }
        note = new VF.StaveNote({ clef: clef, keys: keys, duration: item.dur });
        for (var a = 0; a < spells.length; a++) {
          // Só o primeiro de um grupo ligado leva alteração.
          var accid = item.tiedFromPrevious ? null : needsAccidental(spells[a]);
          if (accid) {
            try { note.addModifier(new VF.Accidental(accid), a); } catch (e) {}
          }
        }
        if (item.dur.indexOf('d') >= 0) {
          for (var d = 0; d < keys.length; d++) {
            try { note.addModifier(new VF.Dot(), d); } catch (e) {}
          }
        }
      }
      vfNotes.push(note);
      meta.push(item);
    }

    // Ligaduras entre pedaços da mesma nota partida pela grelha.
    for (var t = 0; t < meta.length - 1; t++) {
      if (meta[t].tieToNext && !meta[t].isRest && !meta[t + 1].isRest) {
        try {
          ties.push(new VF.StaveTie({ first_note: vfNotes[t], last_note: vfNotes[t + 1] }));
        } catch (e) {}
      }
    }

    var totalBeats = beatsPerMeasure(score.timeSig);
    var voice = new VF.Voice({
      num_beats: score.timeSig.numerator,
      beat_value: score.timeSig.denominator
    });
    voice.setStrict(false);
    voice.addTickables(vfNotes);

    var beams = [];
    try { beams = VF.Beam.generateBeams(vfNotes.filter(function (n) { return !n.isRest(); })); } catch (e) {}

    try {
      new VF.Formatter().joinVoices([voice]).format([voice], Math.max(60, width - 40));
      voice.draw(context, stave);
    } catch (e) {
      return;
    }
    for (var b = 0; b < beams.length; b++) {
      try { beams[b].setContext(context).draw(); } catch (e) {}
    }
    for (var ti = 0; ti < ties.length; ti++) {
      try { ties[ti].setContext(context).draw(); } catch (e) {}
    }

    // Regista onde cada nota ficou, para clique, arrasto e brilho.
    for (var v = 0; v < vfNotes.length; v++) {
      if (meta[v].isRest) continue;
      var el = vfNotes[v].getAttribute && vfNotes[v].getAttribute('el');
      if (!el) { try { el = vfNotes[v].getSVGElement(); } catch (e) { el = null; } }
      if (!el) continue;
      el.classList.add('sn');
      el.setAttribute('data-ids', meta[v].ids.join(','));
      this.noteMap.push({
        ids: meta[v].ids,
        notes: meta[v].notes,
        time: meta[v].time,
        el: el,
        staff: clef,
        measureIndex: measureIndex,
        vfNote: vfNotes[v]
      });
    }
  };

  /**
   * Índice para saber, a cada frame, que notas estão a soar - sem varrer a
   * partitura toda. As entradas ficam ordenadas pelo início e a procura começa
   * na primeira que ainda pode estar a soar (pos menos a nota mais longa).
   */
  Renderer.prototype.buildLitIndex = function () {
    var entries = [];
    var maxDur = 0.5;
    for (var i = 0; i < this.noteMap.length; i++) {
      var e = this.noteMap[i];
      var tStart = Infinity, tEnd = -Infinity;
      for (var n = 0; n < e.notes.length; n++) {
        tStart = Math.min(tStart, e.notes[n].start);
        tEnd = Math.max(tEnd, e.notes[n].end);
      }
      if (!isFinite(tStart)) continue;
      maxDur = Math.max(maxDur, tEnd - tStart);
      entries.push({ tStart: tStart, tEnd: tEnd, el: e.el, id: e.ids[0] });
    }
    entries.sort(function (a, b) { return a.tStart - b.tStart; });
    this._lit = { entries: entries, maxDur: maxDur };
    return this._lit;
  };

  Renderer.prototype.activeAt = function (pos) {
    if (!this._lit) this.buildLitIndex();
    var entries = this._lit.entries;
    var lo = lowerBound(entries, pos - this._lit.maxDur);
    var out = [];
    for (var i = lo; i < entries.length; i++) {
      if (entries[i].tStart > pos) break;
      if (entries[i].tEnd > pos) out.push(entries[i]);
    }
    return out;
  };

  /* Primeiro índice cujo tStart >= t. */
  function lowerBound(entries, t) {
    var lo = 0, hi = entries.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (entries[mid].tStart < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Primeiro índice de `notes` cujo fim ainda pode ser >= t. */
  function firstVisible(notes, t, maxDur) {
    var lo = 0, hi = notes.length;
    var target = t - maxDur;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (notes[mid].start < target) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  Renderer.prototype.findByElement = function (target) {
    for (var i = 0; i < this.noteMap.length; i++) {
      if (this.noteMap[i].el === target || this.noteMap[i].el.contains(target)) return this.noteMap[i];
    }
    return null;
  };

  /** Converte um instante em coordenadas dentro da partitura desenhada. */
  Renderer.prototype.timeToPosition = function (time) {
    var pos = this.measurePos;
    if (!pos.length) return null;
    var mi = 0;
    for (var i = 0; i < pos.length; i++) {
      if (time >= pos[i].startTime) mi = i; else break;
    }
    var m = pos[mi];
    var span = Math.max(0.001, m.endTime - m.startTime);
    var frac = Math.max(0, Math.min(1, (time - m.startTime) / span));
    return {
      x: m.x + 12 + frac * (m.width - 20),
      y: m.systemTop,
      height: m.systemHeight,
      lineIndex: m.lineIndex,
      measureIndex: mi
    };
  };

  Renderer.prototype.positionToTime = function (x, y) {
    var pos = this.measurePos;
    if (!pos.length) return 0;
    var best = null;
    for (var i = 0; i < pos.length; i++) {
      var m = pos[i];
      if (y >= m.y && y <= m.y + this.layout.systemHeight &&
          x >= m.x && x <= m.x + m.width) { best = m; break; }
    }
    if (!best) {
      // fora de um compasso: usa a linha mais próxima
      var line = Math.floor(y / this.layout.systemHeight);
      var candidates = pos.filter(function (m) { return m.lineIndex === line; });
      best = candidates.length ? candidates[Math.min(candidates.length - 1,
        Math.max(0, Math.floor((x - this.layout.padLeft) / this.layout.measureWidth)))] : pos[0];
    }
    var frac = Math.max(0, Math.min(1, (x - best.x - 12) / Math.max(1, best.width - 20)));
    return best.startTime + frac * (best.endTime - best.startTime);
  };

  global.ScoreLib = {
    Score: Score,
    Renderer: Renderer,
    detectKey: detectKey,
    spellPitch: spellPitch,
    slotsToDurations: slotsToDurations,
    beatsPerMeasure: beatsPerMeasure,
    firstVisible: firstVisible
  };
})(window);
