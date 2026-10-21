/**
 * app.js — かくしてフォト メイン処理
 *  - 画像読み込み / Canvas描画
 *  - Gemini（GAS経由）による顔・文字の自動検出
 *  - 四角・ブラシ・消しゴム・選択移動
 *  - モザイク / ぼかし
 *  - ダウンロード / Googleドライブ保存
 *  - 音声案内（Gemini TTS → 失敗時はブラウザ読み上げ）
 *  - 設定モーダル / 更新履歴
 */
window.App = (() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const CFG = window.APP_CONFIG;

  const COLORS = { face: '#E8590C', text: '#1C7ED6', manual: '#C2255C' };
  const SOURCE_LABEL = { face: '顔', text: '文字', manual: '手動' };

  const state = {
    src: null,             // 作業用の元画像キャンバス
    fileName: 'image',
    originalFile: null,
    regions: [],           // {id, x, y, w, h, source, label, enabled}
    tool: 'rect',
    effect: 'mosaic',
    mosaicSize: 16,
    blurRadius: 14,
    brushSize: 40,
    format: 'image/png',
    selectedId: null,
    showOutlines: true,
    comparing: false,
    history: [],
    future: [],
    pointer: null,         // 操作中の情報
    hover: null,           // ブラシカーソル位置
    busy: false
  };

  let nextId = 1;
  let view, vctx, overlay, octx;
  let maskCanvas, maskCtx;            // ブラシで塗ったマスク（白＝隠す）
  let maskVersion = 0;
  let maskSnap = { version: -1, canvas: null };
  let effectCache = { key: '', canvas: null };
  let combinedCanvas, combinedCtx, tmpCanvas, tmpCtx;
  let rafPending = false;
  const supportsCanvasFilter = (() => {
    try {
      const c = document.createElement('canvas').getContext('2d');
      if (!('filter' in c)) return false;
      c.filter = 'blur(2px)';
      return c.filter === 'blur(2px)';
    } catch (e) { return false; }
  })();

  /* =========================================================
   * トースト
   * ========================================================= */
  function toast(message, type = 'info', opts = {}) {
    const host = $('#toastHost');
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.type = type;
    if (opts.html) el.innerHTML = message; else el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), opts.duration || (type === 'error' ? 6000 : 3500));
  }

  /* =========================================================
   * 音声案内（Gemini TTS）
   * ========================================================= */
  const Voice = {
    enabled: Config.get('VOICE') === 'on',
    cache: new Map(),
    audio: null,

    setEnabled(on) {
      this.enabled = on;
      Config.set('VOICE', on ? 'on' : 'off');
      const t = $('#voiceToggle');
      t.setAttribute('aria-checked', on ? 'true' : 'false');
      if (!on) this.stop();
    },

    stop() {
      if (this.audio) { this.audio.pause(); this.audio = null; }
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    },

    async speak(text, force = false) {
      if (!text || (!this.enabled && !force)) return;
      this.stop();
      try {
        if (!Auth.isLoggedIn()) throw new Error('not logged in');
        let url = this.cache.get(text);
        if (!url) {
          const r = await Auth.call('tts', { text });
          const blob = audioToBlob(r.audio, r.mimeType);
          url = URL.createObjectURL(blob);
          this.cache.set(text, url);
        }
        const a = new Audio(url);
        this.audio = a;
        await a.play();
      } catch (e) {
        this.browserSpeak(text);
      }
    },

    browserSpeak(text) {
      if (!('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      u.rate = 1.0;
      const ja = window.speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('ja'));
      if (ja) u.voice = ja;
      window.speechSynthesis.speak(u);
    }
  };

  /** Gemini TTSのPCM（audio/L16）をWAVに変換。wav/mp3等はそのまま */
  function audioToBlob(b64, mimeType = '') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!/l16|pcm/i.test(mimeType)) return new Blob([bytes], { type: mimeType || 'audio/wav' });

    const rateMatch = /rate=(\d+)/i.exec(mimeType);
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
    const channels = 1, bits = 16;
    const header = new ArrayBuffer(44);
    const dv = new DataView(header);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + bytes.length, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, channels, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * channels * bits / 8, true);
    dv.setUint16(32, channels * bits / 8, true);
    dv.setUint16(34, bits, true);
    writeStr(36, 'data');
    dv.setUint32(40, bytes.length, true);
    return new Blob([header, bytes], { type: 'audio/wav' });
  }

  /* =========================================================
   * 画像の読み込み
   * ========================================================= */
  async function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      toast('画像ファイル（JPEG・PNG・WebPなど）を選んでください', 'error');
      return;
    }
    setBusy(true, '画像を読み込んでいます…');
    try {
      const bmp = await decodeImage(file);
      const maxSide = Number(Config.get('WORK_MAX_SIDE')) || CFG.WORK_MAX_SIDE;
      const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);

      const src = document.createElement('canvas');
      src.width = w; src.height = h;
      const sctx = src.getContext('2d');
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();

      state.src = src;
      state.fileName = file.name.replace(/\.[^.]+$/, '') || 'image';
      state.originalFile = file;
      state.regions = [];
      state.selectedId = null;
      state.history = [];
      state.future = [];

      view.width = overlay.width = w;
      view.height = overlay.height = h;
      maskCanvas = makeCanvas(w, h); maskCtx = maskCanvas.getContext('2d');
      combinedCanvas = makeCanvas(w, h); combinedCtx = combinedCanvas.getContext('2d');
      tmpCanvas = makeCanvas(w, h); tmpCtx = tmpCanvas.getContext('2d');
      maskVersion = 1;
      maskSnap = { version: -1, canvas: null };
      effectCache = { key: '', canvas: null };

      $('#dropzone').hidden = true;
      $('#canvasWrap').hidden = false;
      $('#stageHint').textContent = scale < 1
        ? `大きな画像のため ${w}×${h}px に縮小して編集します。`
        : `${w}×${h}px`;
      updateControls();
      renderRegionList();
      requestRender();
      Voice.speak('画像を読み込みました。顔や文字の検出ボタンを押すか、隠したい場所を囲んでください。');
    } catch (e) {
      console.error(e);
      toast('画像を開けませんでした。別の形式（JPEG・PNG）でお試しください', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function decodeImage(file) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch (e) { /* フォールバック */ }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function resetImage() {
    if (state.src && (state.regions.length || maskVersion > 1) && !confirm('今の編集内容は破棄されます。別の画像を開きますか？')) return;
    state.src = null;
    state.regions = [];
    state.history = [];
    state.future = [];
    state.selectedId = null;
    $('#canvasWrap').hidden = true;
    $('#dropzone').hidden = false;
    $('#fileInput').value = '';
    $('#driveResult').hidden = true;
    $('#stageHint').textContent = '画像を読み込むと、ここで範囲を指定できます。';
    updateControls();
    renderRegionList();
  }

  /* =========================================================
   * エフェクト生成
   * ========================================================= */
  function longSideFactor() {
    return Math.max(state.src.width, state.src.height) / 1000;
  }

  function getEffectCanvas() {
    const val = state.effect === 'mosaic' ? state.mosaicSize : state.blurRadius;
    const key = `${state.effect}:${val}:${state.src.width}x${state.src.height}`;
    if (effectCache.key === key && effectCache.canvas) return effectCache.canvas;

    const { width: w, height: h } = state.src;
    const out = makeCanvas(w, h);
    const ctx = out.getContext('2d');

    if (state.effect === 'mosaic') {
      const block = Math.max(2, Math.round(state.mosaicSize * longSideFactor()));
      const sw = Math.max(1, Math.ceil(w / block));
      const sh = Math.max(1, Math.ceil(h / block));
      const small = makeCanvas(sw, sh);
      const sctx = small.getContext('2d');
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(state.src, 0, 0, sw, sh);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, sw, sh, 0, 0, sw * block, sh * block);
    } else {
      const r = Math.max(1, Math.round(state.blurRadius * longSideFactor()));
      ctx.drawImage(state.src, 0, 0);
      if (supportsCanvasFilter) {
        ctx.filter = `blur(${r}px)`;
        ctx.drawImage(state.src, 0, 0);
        ctx.filter = 'none';
      } else {
        // Canvas filter 非対応ブラウザ向け：縮小→拡大を繰り返して近似
        const f = Math.max(2, r / 2);
        const sw = Math.max(1, Math.round(w / f));
        const sh = Math.max(1, Math.round(h / f));
        const small = makeCanvas(sw, sh);
        const sctx = small.getContext('2d');
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(state.src, 0, 0, sw, sh);
        for (let i = 0; i < 2; i++) {
          const half = makeCanvas(Math.max(1, sw >> 1), Math.max(1, sh >> 1));
          half.getContext('2d').drawImage(small, 0, 0, half.width, half.height);
          sctx.clearRect(0, 0, sw, sh);
          sctx.drawImage(half, 0, 0, sw, sh);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(small, 0, 0, w, h);
      }
    }
    effectCache = { key, canvas: out };
    return out;
  }

  /* =========================================================
   * 合成・描画
   * ========================================================= */
  function hasAnyMask() {
    return state.regions.some(r => r.enabled) || maskVersion > 1;
  }

  function buildCombinedMask() {
    const { width: w, height: h } = state.src;
    combinedCtx.clearRect(0, 0, w, h);
    combinedCtx.drawImage(maskCanvas, 0, 0);
    combinedCtx.fillStyle = '#fff';
    state.regions.forEach(r => { if (r.enabled) combinedCtx.fillRect(r.x, r.y, r.w, r.h); });
    return combinedCanvas;
  }

  /** 元画像＋マスク部分にエフェクトを合成して ctx に描く */
  function composeTo(ctx) {
    const { width: w, height: h } = state.src;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(state.src, 0, 0);
    if (!hasAnyMask()) return;
    const mask = buildCombinedMask();
    const eff = getEffectCanvas();
    tmpCtx.globalCompositeOperation = 'source-over';
    tmpCtx.clearRect(0, 0, w, h);
    tmpCtx.drawImage(eff, 0, 0);
    tmpCtx.globalCompositeOperation = 'destination-in';
    tmpCtx.drawImage(mask, 0, 0);
    tmpCtx.globalCompositeOperation = 'source-over';
    ctx.drawImage(tmpCanvas, 0, 0);
  }

  function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      render();
    });
  }

  function render() {
    if (!state.src) return;
    if (state.comparing) {
      vctx.clearRect(0, 0, view.width, view.height);
      vctx.drawImage(state.src, 0, 0);
    } else {
      composeTo(vctx);
    }
    renderOverlay();
  }

  /** 表示サイズに対する画像の倍率（線の太さを画面上で一定にするため） */
  function displayScale() {
    const rect = overlay.getBoundingClientRect();
    return rect.width ? overlay.width / rect.width : 1;
  }

  function renderOverlay() {
    const s = displayScale();
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (state.comparing) return;

    if (state.showOutlines) {
      state.regions.forEach(r => {
        const color = COLORS[r.source] || COLORS.manual;
        const selected = r.id === state.selectedId;
        octx.save();
        octx.lineWidth = (selected ? 3 : 2) * s;
        octx.strokeStyle = color;
        octx.setLineDash(r.enabled ? [] : [6 * s, 4 * s]);
        octx.globalAlpha = r.enabled ? 1 : 0.55;
        octx.strokeRect(r.x, r.y, r.w, r.h);
        if (selected) {
          octx.fillStyle = color;
          const hs = 8 * s;
          [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]].forEach(([x, y]) => {
            octx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
          });
        }
        // ラベル
        const text = SOURCE_LABEL[r.source] + (r.label && r.source === 'text' ? '：' + r.label : '');
        octx.font = `700 ${12 * s}px 'Zen Kaku Gothic New', sans-serif`;
        const tw = Math.min(octx.measureText(text).width, 220 * s);
        const lh = 18 * s;
        const ly = r.y - lh >= 0 ? r.y - lh : r.y;
        octx.globalAlpha = r.enabled ? 0.92 : 0.5;
        octx.fillStyle = color;
        octx.fillRect(r.x, ly, tw + 10 * s, lh);
        octx.fillStyle = '#fff';
        octx.textBaseline = 'middle';
        octx.fillText(text, r.x + 5 * s, ly + lh / 2, 220 * s);
        octx.restore();
      });
    }

    // ドラッグ中の四角
    const p = state.pointer;
    if (p && p.mode === 'rect') {
      const r = normRect(p.startX, p.startY, p.x, p.y);
      octx.save();
      octx.fillStyle = 'rgba(255, 210, 63, .25)';
      octx.fillRect(r.x, r.y, r.w, r.h);
      octx.lineWidth = 2 * s;
      octx.strokeStyle = '#1D232B';
      octx.setLineDash([6 * s, 4 * s]);
      octx.strokeRect(r.x, r.y, r.w, r.h);
      octx.restore();
    }

    // ブラシカーソル
    if ((state.tool === 'brush' || state.tool === 'eraser') && state.hover) {
      const rad = brushRadius();
      octx.save();
      octx.beginPath();
      octx.arc(state.hover.x, state.hover.y, rad, 0, Math.PI * 2);
      octx.lineWidth = 2 * s;
      octx.strokeStyle = '#fff';
      octx.stroke();
      octx.lineWidth = 1 * s;
      octx.strokeStyle = state.tool === 'eraser' ? '#C92A2A' : '#1D232B';
      octx.stroke();
      octx.restore();
    }
  }

  function brushRadius() {
    return (state.brushSize / 2) * longSideFactor();
  }

  function normRect(x1, y1, x2, y2) {
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }

  /* =========================================================
   * 元に戻す / やり直す
   * ========================================================= */
  function snapshotMask() {
    if (maskSnap.version === maskVersion && maskSnap.canvas) return maskSnap.canvas;
    const c = makeCanvas(maskCanvas.width, maskCanvas.height);
    c.getContext('2d').drawImage(maskCanvas, 0, 0);
    maskSnap = { version: maskVersion, canvas: c };
    return c;
  }

  function currentSnapshot() {
    return {
      regions: state.regions.map(r => Object.assign({}, r)),
      mask: snapshotMask(),
      maskVersion
    };
  }

  function pushHistory() {
    if (!state.src) return;
    state.history.push(currentSnapshot());
    const limit = Number(CFG.HISTORY_LIMIT) || 20;
    if (state.history.length > limit) state.history.shift();
    state.future = [];
    updateControls();
  }

  function restore(snap) {
    state.regions = snap.regions.map(r => Object.assign({}, r));
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.drawImage(snap.mask, 0, 0);
    maskVersion = snap.maskVersion;
    maskSnap = { version: maskVersion, canvas: snap.mask };
    if (!state.regions.some(r => r.id === state.selectedId)) state.selectedId = null;
  }

  function undo() {
    if (!state.history.length) return;
    state.future.push(currentSnapshot());
    restore(state.history.pop());
    afterChange();
  }

  function redo() {
    if (!state.future.length) return;
    state.history.push(currentSnapshot());
    restore(state.future.pop());
    afterChange();
  }

  function clearAll() {
    if (!state.src || !hasAnyMask()) return;
    if (!confirm('指定したすべての範囲を解除しますか？')) return;
    pushHistory();
    state.regions = [];
    state.selectedId = null;
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskVersion = 1;
    maskSnap = { version: -1, canvas: null };
    afterChange();
  }

  function afterChange() {
    renderRegionList();
    updateControls();
    requestRender();
  }

  /* =========================================================
   * ポインター操作
   * ========================================================= */
  function toImageCoords(e) {
    const r = overlay.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * overlay.width / r.width,
      y: (e.clientY - r.top) * overlay.height / r.height
    };
  }

  function hitRegion(pt) {
    for (let i = state.regions.length - 1; i >= 0; i--) {
      const r = state.regions[i];
      if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) return r;
    }
    return null;
  }

  function onPointerDown(e) {
    if (!state.src || state.busy || e.button > 0) return;
    overlay.setPointerCapture(e.pointerId);
    const pt = toImageCoords(e);

    if (state.tool === 'rect') {
      state.pointer = { mode: 'rect', startX: pt.x, startY: pt.y, x: pt.x, y: pt.y };
    } else if (state.tool === 'brush' || state.tool === 'eraser') {
      pushHistory();
      state.pointer = { mode: 'paint', lastX: pt.x, lastY: pt.y };
      paintSegment(pt.x, pt.y, pt.x, pt.y);
    } else if (state.tool === 'select') {
      const hit = hitRegion(pt);
      state.selectedId = hit ? hit.id : null;
      if (hit) {
        pushHistory();
        state.pointer = { mode: 'move', id: hit.id, offX: pt.x - hit.x, offY: pt.y - hit.y, moved: false };
      }
      renderRegionList();
    }
    requestRender();
  }

  function onPointerMove(e) {
    if (!state.src) return;
    const pt = toImageCoords(e);
    state.hover = pt;
    const p = state.pointer;

    if (!p) {
      if (state.tool === 'select') overlay.classList.toggle('is-hovering', !!hitRegion(pt));
      if (state.tool === 'brush' || state.tool === 'eraser') requestRender();
      return;
    }
    if (p.mode === 'rect') {
      p.x = clamp(pt.x, 0, overlay.width);
      p.y = clamp(pt.y, 0, overlay.height);
    } else if (p.mode === 'paint') {
      paintSegment(p.lastX, p.lastY, pt.x, pt.y);
      p.lastX = pt.x; p.lastY = pt.y;
    } else if (p.mode === 'move') {
      const r = state.regions.find(x => x.id === p.id);
      if (r) {
        r.x = clamp(pt.x - p.offX, 0, overlay.width - r.w);
        r.y = clamp(pt.y - p.offY, 0, overlay.height - r.h);
        p.moved = true;
      }
    }
    requestRender();
  }

  function onPointerUp(e) {
    const p = state.pointer;
    state.pointer = null;
    if (overlay.hasPointerCapture && overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
    if (!p) return;

    if (p.mode === 'rect') {
      const r = normRect(p.startX, p.startY, p.x, p.y);
      const min = 6 * displayScale();
      if (r.w >= min && r.h >= min) {
        pushHistory();
        const region = { id: nextId++, x: r.x, y: r.y, w: r.w, h: r.h, source: 'manual', label: '', enabled: true };
        state.regions.push(region);
        state.selectedId = region.id;
      }
    } else if (p.mode === 'move' && !p.moved) {
      // 動かしていなければ履歴を戻す
      state.history.pop();
    }
    afterChange();
  }

  function paintSegment(x1, y1, x2, y2) {
    maskCtx.save();
    maskCtx.globalCompositeOperation = state.tool === 'eraser' ? 'destination-out' : 'source-over';
    maskCtx.strokeStyle = '#fff';
    maskCtx.fillStyle = '#fff';
    maskCtx.lineWidth = brushRadius() * 2;
    maskCtx.lineCap = 'round';
    maskCtx.lineJoin = 'round';
    maskCtx.beginPath();
    maskCtx.moveTo(x1, y1);
    maskCtx.lineTo(x2, y2);
    maskCtx.stroke();
    maskCtx.restore();
    maskVersion++;
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function deleteRegion(id) {
    pushHistory();
    state.regions = state.regions.filter(r => r.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    afterChange();
  }

  /* =========================================================
   * 自動検出（Gemini via GAS）
   * ========================================================= */
  function encodeForDetect() {
    const maxSide = Number(CFG.DETECT_MAX_SIDE) || 1536;
    const { width: w, height: h } = state.src;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const c = makeCanvas(Math.round(w * scale), Math.round(h * scale));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(state.src, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.9);
    return { b64: dataUrl.split(',')[1], mime: 'image/jpeg' };
  }

  async function detect(mode) {
    if (!state.src || state.busy) return;
    const label = mode === 'face' ? '顔' : '文字';
    setBusy(true, `${label}を探しています…`);
    try {
      const { b64, mime } = encodeForDetect();
      const r = await Auth.call('detect', { mode, imageBase64: b64, mimeType: mime });
      const items = Array.isArray(r.items) ? r.items : [];
      if (!items.length) {
        toast(`${label}は見つかりませんでした。必要なら四角で囲んでください`, 'info');
        Voice.speak(`${label}は見つかりませんでした。`);
        return;
      }
      pushHistory();
      const { width: W, height: H } = state.src;
      const padRatio = mode === 'face' ? 0.12 : 0.04;
      let added = 0;
      items.forEach(it => {
        const [ymin, xmin, ymax, xmax] = it.box_2d;
        let x = xmin / 1000 * W, y = ymin / 1000 * H;
        let w = (xmax - xmin) / 1000 * W, h = (ymax - ymin) / 1000 * H;
        const pad = Math.max(w, h) * padRatio;
        x = clamp(x - pad, 0, W); y = clamp(y - pad, 0, H);
        w = clamp(w + pad * 2, 1, W - x); h = clamp(h + pad * 2, 1, H - y);
        // ほぼ同じ位置の重複は追加しない
        const dup = state.regions.some(rg => rg.source === mode && iou(rg, { x, y, w, h }) > 0.7);
        if (dup) return;
        state.regions.push({ id: nextId++, x, y, w, h, source: mode, label: it.label || '', enabled: true });
        added++;
      });
      afterChange();
      const msg = added ? `${label}を${added}か所見つけて隠しました` : `新しい${label}は見つかりませんでした`;
      toast(msg, 'success');
      Voice.speak(msg + '。');
    } catch (e) {
      toast(e.message, 'error');
      Voice.speak('検出できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
  }

  /* =========================================================
   * 書き出し
   * ========================================================= */
  function exportCanvas() {
    const c = makeCanvas(state.src.width, state.src.height);
    const ctx = c.getContext('2d');
    if (state.format === 'image/jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      const t = makeCanvas(c.width, c.height);
      composeTo(t.getContext('2d'));
      ctx.drawImage(t, 0, 0);
    } else {
      composeTo(ctx);
    }
    return c;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('画像を作成できませんでした')), type, quality);
    });
  }

  async function download() {
    if (!state.src) return;
    try {
      const blob = await canvasToBlob(exportCanvas(), state.format, 0.92);
      const ext = state.format === 'image/jpeg' ? 'jpg' : 'png';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.fileName}_masked.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('ダウンロードしました', 'success');
      Voice.speak('マスキングした画像をダウンロードしました。');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = () => reject(new Error('ファイルを読み込めませんでした'));
      fr.readAsDataURL(blob);
    });
  }

  async function saveToDrive() {
    if (!state.src || state.busy) return;
    setBusy(true, 'Googleドライブに保存しています…');
    const btn = $('#driveBtn');
    btn.disabled = true;
    try {
      const blob = await canvasToBlob(exportCanvas(), state.format, 0.92);
      const payload = {
        fileName: state.fileName,
        maskedBase64: await blobToBase64(blob),
        maskedMime: state.format
      };
      if ($('#saveOriginal').checked && state.originalFile) {
        let ob = state.originalFile, om = state.originalFile.type;
        // 大きすぎる元画像は作業用画像をJPEGで送る（GASの受信上限対策）
        if (ob.size > 15 * 1024 * 1024) {
          ob = await canvasToBlob(state.src, 'image/jpeg', 0.92);
          om = 'image/jpeg';
        }
        payload.originalBase64 = await blobToBase64(ob);
        payload.originalMime = om;
      }
      const r = await Auth.call('saveImage', payload);
      const res = $('#driveResult');
      res.innerHTML = '';
      const a = document.createElement('a');
      a.href = r.maskedUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '保存した画像を開く';
      a.className = 'text-link';
      res.append('保存しました。', a);
      res.hidden = false;
      toast('Googleドライブに保存しました', 'success');
      Voice.speak('グーグルドライブに保存しました。');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      setBusy(false);
    }
  }

  /* =========================================================
   * UI 更新
   * ========================================================= */
  function setBusy(on, text) {
    state.busy = on;
    $('#stageBusy').hidden = !on;
    if (text) $('#stageBusyText').textContent = text;
    updateControls();
  }

  function updateControls() {
    const has = !!state.src;
    const idle = !state.busy;
    $('#detectFaceBtn').disabled = !has || !idle;
    $('#detectTextBtn').disabled = !has || !idle;
    $('#downloadBtn').disabled = !has || !idle;
    $('#driveBtn').disabled = !has || !idle;
    $('#undoBtn').disabled = !has || !state.history.length;
    $('#redoBtn').disabled = !has || !state.future.length;
    $('#clearBtn').disabled = !has || !hasAnyMask();
    $('#compareBtn').disabled = !has;
    $('#newImageBtn').disabled = !has || !idle;
  }

  function renderRegionList() {
    const list = $('#regionList');
    list.innerHTML = '';
    $('#regionCount').textContent = String(state.regions.length);
    $('#regionEmpty').hidden = state.regions.length > 0;

    const counters = { face: 0, text: 0, manual: 0 };
    state.regions.forEach(r => {
      counters[r.source] = (counters[r.source] || 0) + 1;
      const li = document.createElement('li');
      li.className = 'region-item' + (r.id === state.selectedId ? ' is-selected' : '');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = r.enabled;
      cb.setAttribute('aria-label', '隠す');
      cb.addEventListener('change', () => {
        pushHistory();
        r.enabled = cb.checked;
        afterChange();
      });

      const sw = document.createElement('span');
      sw.className = 'region-swatch';
      sw.style.background = COLORS[r.source];

      const label = document.createElement('span');
      label.className = 'region-label';
      const n = counters[r.source];
      label.textContent = `${SOURCE_LABEL[r.source]} ${n}` + (r.source === 'text' && r.label ? `「${r.label}」` : '');
      label.title = label.textContent;
      label.addEventListener('click', () => {
        state.selectedId = r.id;
        renderRegionList();
        requestRender();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'region-del';
      del.setAttribute('aria-label', '削除');
      del.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      del.addEventListener('click', () => deleteRegion(r.id));

      li.append(cb, sw, label, del);
      list.appendChild(li);
    });
  }

  const TOOL_NOTES = {
    rect: '画像の上をドラッグして、隠したい範囲を囲みます。',
    brush: 'なぞったところを隠します。細かい形に合わせたいときに。',
    eraser: 'ブラシで塗った部分を消します。四角は「選択・移動」で消してください。',
    select: '四角をつかんで動かせます。選んだ四角は Delete キーか一覧の×で消せます。'
  };

  function setTool(tool) {
    state.tool = tool;
    $$('[data-tool]').forEach(b => {
      const on = b.dataset.tool === tool;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    overlay.dataset.tool = tool;
    $('#brushSizeField').hidden = !(tool === 'brush' || tool === 'eraser');
    $('#toolNote').textContent = TOOL_NOTES[tool];
    requestRender();
  }

  function setEffect(effect) {
    state.effect = effect;
    $$('[data-effect]').forEach(b => {
      const on = b.dataset.effect === effect;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    $('#mosaicField').hidden = effect !== 'mosaic';
    $('#blurField').hidden = effect !== 'blur';
    updateBlurWarn();
    requestRender();
  }

  function updateBlurWarn() {
    $('#blurWarn').hidden = !(state.effect === 'blur' && state.blurRadius < 10);
  }

  function setFormat(fmt) {
    state.format = fmt;
    $$('[data-format]').forEach(b => {
      const on = b.dataset.format === fmt;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  /* =========================================================
   * モーダル（設定・更新履歴・使い方）
   * ========================================================= */
  function openModal(id) {
    const m = document.getElementById(id);
    m.hidden = false;
    const first = m.querySelector('input, button:not([data-close-modal])');
    if (first) setTimeout(() => first.focus(), 30);
  }
  function closeModal(m) {
    if (m.id === 'pwChangeModal') return; // パスワード変更は auth.js が管理
    m.hidden = true;
  }

  function openSettings() {
    $('#cfgGasUrl').value = Config.get('GAS_URL');
    $('#cfgEarthUrl').value = Config.get('EARTH_STUDIO_VIDEO_URL');
    const msg = $('#settingsMsg');
    msg.hidden = true;
    openModal('settingsModal');
  }

  function showSettingsMsg(text, type) {
    const msg = $('#settingsMsg');
    msg.textContent = text;
    msg.dataset.type = type || '';
    msg.hidden = !text;
  }

  function bindSettings() {
    $$('[data-open-settings]').forEach(b => b.addEventListener('click', openSettings));

    $('#settingsForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const url = $('#cfgGasUrl').value.trim();
      if (url && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
        showSettingsMsg('GASのURLは https://script.google.com/macros/s/…/exec の形式で入力してください', 'error');
        return;
      }
      Config.set('GAS_URL', url === CFG.GAS_URL ? '' : url);
      const earth = $('#cfgEarthUrl').value.trim();
      Config.set('EARTH_STUDIO_VIDEO_URL', earth === CFG.EARTH_STUDIO_VIDEO_URL ? '' : earth);
      applyEarthStudio();
      showSettingsMsg('保存しました', 'success');
      toast('設定を保存しました', 'success');
      setTimeout(() => { $('#settingsModal').hidden = true; }, 600);
    });

    $('#cfgTestBtn').addEventListener('click', async () => {
      const url = $('#cfgGasUrl').value.trim();
      if (!url) { showSettingsMsg('URLを入力してください', 'error'); return; }
      showSettingsMsg('接続を確認しています…', '');
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'ping' })
        });
        const data = await res.json();
        if (data.ok) showSettingsMsg(`接続できました（サーバー ${data.version || ''}）`, 'success');
        else showSettingsMsg(data.error || '接続できませんでした', 'error');
      } catch (e) {
        showSettingsMsg('接続できませんでした。URLとデプロイ設定（アクセス：全員）を確認してください', 'error');
      }
    });

    $('#cfgResetBtn').addEventListener('click', () => {
      if (!confirm('設定を初期値（config.js の値）に戻しますか？')) return;
      Config.reset(['GAS_URL', 'EARTH_STUDIO_VIDEO_URL']);
      $('#cfgGasUrl').value = Config.get('GAS_URL');
      $('#cfgEarthUrl').value = Config.get('EARTH_STUDIO_VIDEO_URL');
      applyEarthStudio();
      showSettingsMsg('初期値に戻しました', 'success');
    });
  }

  function renderChangelog() {
    const body = $('#changelogBody');
    body.innerHTML = '';
    (CFG.CHANGELOG || []).forEach(entry => {
      const h = document.createElement('h3');
      h.textContent = entry.version;
      const small = document.createElement('small');
      small.textContent = entry.date;
      h.appendChild(small);
      const ul = document.createElement('ul');
      entry.notes.forEach(n => {
        const li = document.createElement('li');
        li.textContent = n;
        ul.appendChild(li);
      });
      body.append(h, ul);
    });
  }

  /** Google Earth Studio で書き出した動画をログイン画面の背景に流す */
  function applyEarthStudio() {
    const video = $('#bgVideo');
    const url = String(Config.get('EARTH_STUDIO_VIDEO_URL') || '').trim();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!url || reduce) {
      video.pause();
      video.removeAttribute('src');
      video.hidden = true;
      return;
    }
    if (video.getAttribute('src') !== url) {
      video.src = url;
      video.onerror = () => { video.hidden = true; };
      video.oncanplay = () => { video.hidden = false; };
      video.play().catch(() => { /* 自動再生不可でも静止で表示 */ });
    }
  }

  const HELP_TEXT = '写真を選んだら、顔を検出、または文字を検出のボタンを押してください。足りないところは四角やブラシで追加できます。モザイクかぼかしを選んで、強さを調整したら、ダウンロードかグーグルドライブに保存で書き出します。';

  /* =========================================================
   * イベント登録
   * ========================================================= */
  function bindEvents() {
    // ファイル選択・ドロップ
    $('#fileInput').addEventListener('change', (e) => loadFile(e.target.files[0]));
    const stage = $('#stage');
    ['dragenter', 'dragover'].forEach(ev => stage.addEventListener(ev, (e) => {
      e.preventDefault();
      if (!state.src) stage.classList.add('is-dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => stage.addEventListener(ev, (e) => {
      e.preventDefault();
      stage.classList.remove('is-dragover');
    }));
    stage.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (state.src && !confirm('今の編集内容は破棄されます。この画像を開きますか？')) return;
      loadFile(f);
    });
    // 貼り付け
    document.addEventListener('paste', (e) => {
      if (!Auth.isActive()) return;
      const item = Array.from(e.clipboardData ? e.clipboardData.items : []).find(i => i.type.startsWith('image/'));
      if (!item) return;
      if (state.src && !confirm('今の編集内容は破棄されます。貼り付けた画像を開きますか？')) return;
      const f = item.getAsFile();
      if (f) loadFile(new File([f], 'pasted.' + (f.type.split('/')[1] || 'png'), { type: f.type }));
    });

    // キャンバス操作
    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('pointercancel', onPointerUp);
    overlay.addEventListener('pointerleave', () => { state.hover = null; if (!state.pointer) requestRender(); });

    // ツール
    $$('[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $$('[data-effect]').forEach(b => b.addEventListener('click', () => setEffect(b.dataset.effect)));
    $$('[data-format]').forEach(b => b.addEventListener('click', () => setFormat(b.dataset.format)));

    $('#brushSize').addEventListener('input', (e) => {
      state.brushSize = Number(e.target.value);
      $('#brushSizeOut').textContent = e.target.value;
      requestRender();
    });
    $('#mosaicSize').addEventListener('input', (e) => {
      state.mosaicSize = Number(e.target.value);
      $('#mosaicOut').textContent = e.target.value;
      requestRender();
    });
    $('#blurRadius').addEventListener('input', (e) => {
      state.blurRadius = Number(e.target.value);
      $('#blurOut').textContent = e.target.value;
      updateBlurWarn();
      requestRender();
    });

    $('#detectFaceBtn').addEventListener('click', () => detect('face'));
    $('#detectTextBtn').addEventListener('click', () => detect('text'));
    $('#undoBtn').addEventListener('click', undo);
    $('#redoBtn').addEventListener('click', redo);
    $('#clearBtn').addEventListener('click', clearAll);
    $('#newImageBtn').addEventListener('click', resetImage);
    $('#downloadBtn').addEventListener('click', download);
    $('#driveBtn').addEventListener('click', saveToDrive);
    $('#outlineToggle').addEventListener('change', (e) => { state.showOutlines = e.target.checked; requestRender(); });

    // 元画像を見る（押している間）
    const cmp = $('#compareBtn');
    const startCompare = (e) => { e.preventDefault(); if (!state.src) return; state.comparing = true; cmp.classList.add('is-pressed'); requestRender(); };
    const endCompare = () => { if (!state.comparing) return; state.comparing = false; cmp.classList.remove('is-pressed'); requestRender(); };
    cmp.addEventListener('pointerdown', startCompare);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => cmp.addEventListener(ev, endCompare));
    cmp.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') startCompare(e); });
    cmp.addEventListener('keyup', endCompare);

    // 音声案内
    $('#voiceToggle').addEventListener('click', () => {
      const on = !Voice.enabled;
      Voice.setEnabled(on);
      if (on) Voice.speak('音声案内をオンにしました。');
    });

    // 使い方・更新履歴
    $('#helpBtn').addEventListener('click', () => {
      openModal('helpModal');
      Voice.speak(HELP_TEXT);
    });
    $('#helpSpeakBtn').addEventListener('click', () => Voice.speak(HELP_TEXT, true));
    $$('[data-open-changelog]').forEach(b => b.addEventListener('click', () => openModal('changelogModal')));

    // モーダルを閉じる
    document.addEventListener('click', (e) => {
      const closer = e.target.closest('[data-close-modal]');
      if (closer) closeModal(closer.closest('.modal'));
    });

    // ユーザーメニューを外側クリックで閉じる
    document.addEventListener('click', (e) => {
      const menu = $('.user-menu');
      if (menu && menu.open && !menu.contains(e.target)) menu.open = false;
    });

    // キーボード
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $$('.modal:not([hidden])').forEach(closeModal);
        return;
      }
      if (!Auth.isActive() || !state.src) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId != null) {
        e.preventDefault();
        deleteRegion(state.selectedId);
      }
    });

    window.addEventListener('resize', () => requestRender());
  }

  /* =========================================================
   * 起動
   * ========================================================= */
  function init() {
    view = $('#viewCanvas');
    vctx = view.getContext('2d');
    overlay = $('#overlayCanvas');
    octx = overlay.getContext('2d');

    $$('[data-version]').forEach(el => { el.textContent = CFG.VERSION; });
    $$('[data-build-date]').forEach(el => { el.textContent = 'ビルド ' + CFG.BUILD_DATE; });
    document.title = `${CFG.APP_NAME} — 顔と文字を隠す画像マスキング`;

    renderChangelog();
    bindSettings();
    bindEvents();
    setTool('rect');
    setEffect('mosaic');
    setFormat('image/png');
    Voice.setEnabled(Voice.enabled);
    updateControls();
    renderRegionList();
    applyEarthStudio();

    Auth.onChange((st) => {
      if (st === 'loggedOut') {
        Voice.stop();
        applyEarthStudio();
      } else {
        $('#bgVideo').pause();
      }
      if (st === 'active') requestRender();
    });
    Auth.init();

    if (!Config.get('GAS_URL')) {
      setTimeout(() => toast('はじめに歯車アイコンの「設定」で、サーバー（GAS）のURLを登録してください', 'info', { duration: 7000 }), 400);
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  return { toast, speak: (t) => Voice.speak(t) };
})();
