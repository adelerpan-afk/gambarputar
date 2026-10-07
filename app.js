(() => {
  'use strict';

  // ============================================================
  // 1. KONSTANTA
  // ============================================================
  const BASE_WIDTH = 540;
  const BASE_HEIGHT = 960;
  const BACKGROUND_COLOR = '#1a1a2e';
  const MP4_MUXER_URL = 'https://esm.run/mp4-muxer@5.1.1';

  const ENCODER_QUEUE_HIGH = 8;
  const ENCODER_QUEUE_LOW = 4;
  const UI_YIELD_EVERY_N_FRAMES = 5;
  const DOWNLOAD_REVOKE_DELAY_MS = 5000;
  const DOWNLOAD_BATCH_GAP_MS = 400;

  const FORCED_VIDEO_DURATION = 60;   // semua video dipaksa 60s
  const FORCED_FPS = 30;              // semua video dipaksa 30fps

  const AUDIO_SAMPLE_RATE = 48000;
  const AUDIO_CHANNELS = 1;
  const AUDIO_BITRATE = 128000;
  const URGENT_THRESHOLD_SEC = 5;     // 5 detik terakhir = tick tajam
  const BUZZER_WINDOW_SEC = 15;       // buzzer aktif 15 detik terakhir

  const OBJECT_KEYS = ['A', 'B'];
  const DIRECTIONS = { clockwise: 1, counterclockwise: -1 };

  const CODEC_CANDIDATES = [
    'avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.64002A',
    'avc1.640028', 'avc1.64001F', 'avc1.4D402A', 'avc1.4D401F',
    'avc1.42E01E',
  ];

  const EXPORT_STATUS = {
    PENDING: 'pending',
    EXPORTING: 'exporting',
    DONE: 'done',
    ERROR: 'error',
  };

  const JSON_TYPE = 'shape-rotator-settings';
  const JSON_VERSION = 2;

  // ============================================================
  // 2. UTIL
  // ============================================================
  const $ = (id) => document.getElementById(id);
  const nextTick = () => new Promise((r) => setTimeout(r, 0));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = () => (crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  const deepClone = (obj) => JSON.parse(JSON.stringify(obj));

  function sanitizeFilename(name) {
    return (name || 'video')
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 60) || 'video';
  }

  // ============================================================
  // 3. GEOMETRI SHAPE
  // ============================================================
  function tracePolygon(ctx, cx, cy, sides, radius, startAngle = -Math.PI / 2) {
    for (let i = 0; i < sides; i++) {
      const a = startAngle + (i * 2 * Math.PI) / sides;
      const x = cx + radius * Math.cos(a);
      const y = cy + radius * Math.sin(a);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function traceStar(ctx, cx, cy, points, outerR, innerR) {
    const total = points * 2;
    for (let i = 0; i < total; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / points;
      const r = i % 2 === 0 ? outerR : innerR;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  const SHAPE_PATHS = {
    circle:   (ctx, cx, cy, r) => ctx.arc(cx, cy, r, 0, Math.PI * 2),
    triangle: (ctx, cx, cy, r) => tracePolygon(ctx, cx, cy, 3, r),
    cube:     (ctx, cx, cy, r) => ctx.rect(cx - r, cy - r, r * 2, r * 2),
    hexagon:  (ctx, cx, cy, r) => tracePolygon(ctx, cx, cy, 6, r),
    star:     (ctx, cx, cy, r) => traceStar(ctx, cx, cy, 5, r, r * 0.45),
    prism: (ctx, cx, cy, r) => {
      for (let i = 0; i < 6; i++) {
        const a = (i * 2 * Math.PI) / 6 - Math.PI / 2;
        const rr = i % 2 === 0 ? r : r * 0.6;
        const x = cx + rr * Math.cos(a);
        const y = cy + rr * Math.sin(a);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
    },
  };

  function traceShape(ctx, cx, cy, size, shape) {
    ctx.beginPath();
    (SHAPE_PATHS[shape] || SHAPE_PATHS.circle)(ctx, cx, cy, size / 2);
  }

  // ============================================================
  // 4. DEFAULT SETTINGS
  // ============================================================
  function defaultObject(overrides = {}) {
    return {
      shape: 'circle',
      size: 180,
      duration: 4,
      direction: 'clockwise',
      borderColor: '#e94560',
      showBorder: true,
      position: 'top',
      angle: 0,
      ...overrides,
    };
  }

  function defaultSettings() {
    return {
      showBackground: true,
      showTimer: true,
      showSound: true,
      objects: {
        A: defaultObject({ shape: 'circle', position: 'top', borderColor: '#e94560', duration: 4 }),
        B: defaultObject({ shape: 'hexagon', position: 'bottom', borderColor: '#f5a623', duration: 6, direction: 'counterclockwise' }),
      },
      export: {
        fps: FORCED_FPS,
        duration: FORCED_VIDEO_DURATION,
        width: 540,
        height: 960,
        bitrate: 5000000,
      },
    };
  }

  // ============================================================
  // 5. STATE
  // ============================================================
  const state = {
    settings: defaultSettings(),
    presets: [],
    items: [],
    activeId: null,
    activeObjectKey: 'A',
    isAnimating: false,
    isExporting: false,
    animationId: null,
    animationStart: 0,
    animationBaseAngles: { A: 0, B: 0 },
  };

  const getActiveItem = () => state.items.find((i) => i.id === state.activeId) || null;

  // ============================================================
  // 6. ITEM MODEL
  // ============================================================
  function createItem({ name, source }) {
    return {
      id: uid(),
      name,
      source,
      image: null,
      dataURL: null,
      status: EXPORT_STATUS.PENDING,
      progress: 0,
      errorMessage: null,
    };
  }

  async function ensureItemImage(item) {
    if (item.image) return item.image;
    const dataUrl = await resolveDataURL(item.source);
    if (!item.dataURL) item.dataURL = dataUrl;
    const img = await loadImageFromDataURL(dataUrl);
    item.image = img;
    return img;
  }

  function resolveDataURL(source) {
    return new Promise((resolve, reject) => {
      if (source.type === 'dataURL') { resolve(source.data); return; }
      if (source.type === 'file') {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Gagal membaca file'));
        reader.readAsDataURL(source.file);
        return;
      }
      reject(new Error('Sumber gambar tidak dikenal'));
    });
  }

  function loadImageFromDataURL(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Gagal memuat gambar'));
      img.src = dataUrl;
    });
  }

  // ============================================================
  // 7. DOM REFS
  // ============================================================
  const dom = {
    canvas: $('mainCanvas'),

    uploadArea: $('uploadArea'),
    fileInput: $('fileInput'),
    jsonInput: $('jsonInput'),
    btnImportJson: $('btnImportJson'),
    btnExportJson: $('btnExportJson'),

    presetList: $('presetList'),
    presetCount: $('presetCount'),
    btnSavePreset: $('btnSavePreset'),
    btnClearPresets: $('btnClearPresets'),

    queueList: $('queueList'),
    queueCount: $('queueCount'),
    btnClearCompleted: $('btnClearCompleted'),
    btnClearAll: $('btnClearAll'),

    tabButtons: document.querySelectorAll('.tab-btn'),
    positionButtons: document.querySelectorAll('.position-btn'),
    shapeButtons: document.querySelectorAll('#shapeSelector .shape-btn'),
    sizeSlider: $('sizeSlider'),
    sizeValue: $('sizeValue'),
    durationSlider: $('durationSlider'),
    durationValue: $('durationValue'),
    rotationDirection: $('rotationDirection'),
    borderColor: $('borderColor'),
    showBorder: $('showBorder'),
    showTimer: $('showTimer'),
    showSound: $('showSound'),
    showBackground: $('showBackground'),

    btnPlay: $('btnPlay'),
    btnReset: $('btnReset'),

    resolutionSelect: $('resolutionSelect'),
    bitrateSelect: $('bitrateSelect'),
    btnExportCurrent: $('btnExportCurrent'),
    btnExportAll: $('btnExportAll'),
    jobHint: $('jobHint'),
    progressBar: $('progressBar'),
    progressFill: $('progressFill'),
    batchProgressBar: $('batchProgressBar'),
    batchProgressFill: $('batchProgressFill'),
    statusText: $('statusText'),
    warningBox: $('warningBox'),
  };
  const ctx = dom.canvas.getContext('2d');

  // ============================================================
  // 8. RENDER HELPERS
  // ============================================================
  function drawImageCover(targetCtx, img, x, y, w, h) {
    const imgRatio = img.width / img.height;
    const canvasRatio = w / h;
    let drawW, drawH, drawX, drawY;
    if (imgRatio > canvasRatio) {
      drawH = h;
      drawW = h * imgRatio;
      drawX = x + (w - drawW) / 2;
      drawY = y;
    } else {
      drawW = w;
      drawH = w / imgRatio;
      drawX = x;
      drawY = y + (h - drawH) / 2;
    }
    targetCtx.drawImage(img, drawX, drawY, drawW, drawH);
  }

  const getObjectY = (h, pos) => (pos === 'bottom' ? h * 0.7 : h * 0.3);

  function drawObject(targetCtx, obj, image, w, h, scale = 1) {
    const cx = w / 2;
    const cy = getObjectY(h, obj.position);
    const size = obj.size * scale;

    targetCtx.save();
    targetCtx.translate(cx, cy);
    targetCtx.rotate(obj.angle || 0);
    targetCtx.translate(-cx, -cy);

    targetCtx.save();
    traceShape(targetCtx, cx, cy, size, obj.shape);
    targetCtx.clip();
    drawImageCover(targetCtx, image, 0, 0, w, h);
    targetCtx.restore();

    if (obj.showBorder) {
      targetCtx.strokeStyle = obj.borderColor;
      targetCtx.lineWidth = 3 * scale;
      targetCtx.shadowColor = obj.borderColor;
      targetCtx.shadowBlur = 15 * scale;
      traceShape(targetCtx, cx, cy, size, obj.shape);
      targetCtx.stroke();
    }

    targetCtx.restore();
  }

  /**
   * Countdown timer — selalu merah, glow makin besar di 5 detik terakhir.
   */
  function drawTimer(targetCtx, remaining, w, h) {
    const seconds = Math.max(0, Math.ceil(remaining));
    const isUrgent = seconds <= 5;

    const pad = Math.round(w * 0.05);
    const fontSize = Math.round(w * 0.14);
    const red = isUrgent ? '#ff0000' : '#ff2b2b';

    targetCtx.save();
    targetCtx.font = `bold ${fontSize}px "Segoe UI", "Helvetica Neue", sans-serif`;
    targetCtx.textAlign = 'center';
    targetCtx.textBaseline = 'top';

    // Glow merah — lebih besar saat urgent
    targetCtx.shadowColor = red;
    targetCtx.shadowBlur = isUrgent ? fontSize * 0.55 : fontSize * 0.35;
    targetCtx.fillStyle = red;
    targetCtx.fillText(String(seconds), w / 2, pad);

    // Outline gelap untuk kontras di background terang
    targetCtx.shadowBlur = 0;
    targetCtx.lineWidth = Math.max(2, w * 0.004);
    targetCtx.strokeStyle = '#5a0000';
    targetCtx.strokeText(String(seconds), w / 2, pad);

    targetCtx.restore();
  }

  function drawPlaceholder(targetCtx, w, h) {
    targetCtx.fillStyle = '#333';
    targetCtx.fillRect(0, 0, w, h);
    targetCtx.fillStyle = '#666';
    targetCtx.textAlign = 'center';
    targetCtx.font = '18px "Segoe UI", sans-serif';
    targetCtx.fillText('Upload gambar untuk preview', w / 2, h / 2 - 10);
    targetCtx.font = '14px "Segoe UI", sans-serif';
    targetCtx.fillText('Setting di panel kiri tetap bisa diubah', w / 2, h / 2 + 20);
  }

  function getElapsedForPreview() {
    const videoDuration = state.settings.export.duration || FORCED_VIDEO_DURATION;

    if (!state.isAnimating) {
      const obj = state.settings.objects.A;
      const cycle = Math.PI * 2;
      const normalized = ((obj.angle % cycle) + cycle) % cycle;
      return (normalized / cycle) * obj.duration;
    }
    const elapsedTotal = (performance.now() - state.animationStart) / 1000;
    return elapsedTotal % videoDuration;
  }

  function drawFrame() {
    const w = dom.canvas.width;
    const h = dom.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const item = getActiveItem();

    if (!item || !item.image) {
      ctx.fillStyle = BACKGROUND_COLOR;
      ctx.fillRect(0, 0, w, h);
      drawPlaceholder(ctx, w, h);
      return;
    }

    const s = state.settings;
    if (s.showBackground) {
      ctx.fillStyle = BACKGROUND_COLOR;
      ctx.fillRect(0, 0, w, h);
    }

    drawImageCover(ctx, item.image, 0, 0, w, h);
    for (const key of OBJECT_KEYS) {
      drawObject(ctx, s.objects[key], item.image, w, h, 1);
    }

    if (s.showTimer) {
      const remaining = (s.export.duration || FORCED_VIDEO_DURATION) - getElapsedForPreview();
      drawTimer(ctx, remaining, w, h);
    }
  }

  function renderToCanvas(targetCtx, image, settings, w, h, timeSec) {
    const scale = w / BASE_WIDTH;

    targetCtx.clearRect(0, 0, w, h);
    if (settings.showBackground) {
      targetCtx.fillStyle = BACKGROUND_COLOR;
      targetCtx.fillRect(0, 0, w, h);
    }
    drawImageCover(targetCtx, image, 0, 0, w, h);

    for (const key of OBJECT_KEYS) {
      const obj = settings.objects[key];
      const dir = DIRECTIONS[obj.direction] || 1;
      const angle = dir * (timeSec / obj.duration) * Math.PI * 2;
      drawObject(targetCtx, { ...obj, angle }, image, w, h, scale);
    }

    if (settings.showTimer) {
      const total = settings.export.duration || FORCED_VIDEO_DURATION;
      drawTimer(targetCtx, total - timeSec, w, h);
    }
  }

  // ============================================================
  // 9. ANIMASI PREVIEW
  // ============================================================
  function animate() {
    if (!state.isAnimating) return;

    const elapsed = (performance.now() - state.animationStart) / 1000;
    for (const key of OBJECT_KEYS) {
      const obj = state.settings.objects[key];
      const dir = DIRECTIONS[obj.direction] || 1;
      const base = state.animationBaseAngles[key];
      obj.angle = base + dir * (elapsed / obj.duration) * Math.PI * 2;
    }
    drawFrame();
    state.animationId = requestAnimationFrame(animate);
  }

  function startAnimation() {
    const item = getActiveItem();
    if (!item || !item.image) { alert('Upload gambar dulu untuk preview.'); return; }
    if (state.isAnimating) return;

    state.isAnimating = true;
    state.animationStart = performance.now();
    state.animationBaseAngles.A = state.settings.objects.A.angle || 0;
    state.animationBaseAngles.B = state.settings.objects.B.angle || 0;
    dom.btnPlay.textContent = '⏸ Pause';
    state.animationId = requestAnimationFrame(animate);
  }

  function stopAnimation() {
    if (!state.isAnimating) return;
    state.isAnimating = false;
    if (state.animationId) cancelAnimationFrame(state.animationId);
    state.animationId = null;
    dom.btnPlay.textContent = '▶ Play';
  }

  function toggleAnimation() {
    state.isAnimating ? stopAnimation() : startAnimation();
  }

  function resetAnimation() {
    stopAnimation();
    state.settings.objects.A.angle = 0;
    state.settings.objects.B.angle = 0;
    state.animationBaseAngles = { A: 0, B: 0 };
    drawFrame();
  }

  // ============================================================
  // 10. QUEUE RENDER
  // ============================================================
  function renderQueue() {
    const { items } = state;
    dom.queueCount.textContent = `${items.length} item`;

    if (items.length === 0) {
      dom.queueList.innerHTML = '<div class="queue-empty">Belum ada gambar di antrean</div>';
    } else {
      dom.queueList.innerHTML = '';
      for (const item of items) {
        dom.queueList.appendChild(renderQueueItem(item));
      }
    }

    const hasCompleted = items.some((i) => i.status === EXPORT_STATUS.DONE);
    dom.btnClearCompleted.disabled = !hasCompleted;
    dom.btnClearAll.disabled = items.length === 0;

    updateJobHint();
    updateExportAvailability();
  }

  function renderQueueItem(item) {
    const el = document.createElement('div');
    el.className = 'queue-item';
    el.dataset.id = item.id;
    el.dataset.status = item.status;
    if (item.id === state.activeId) el.classList.add('active');

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.alt = '';
    if (item.dataURL || item.source.type === 'dataURL') {
      thumb.src = item.dataURL || item.source.data;
    } else {
      thumb.style.background = 'var(--c-panel-soft)';
    }
    el.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.name;
    name.title = item.name;
    meta.appendChild(name);

    const sub = document.createElement('div');
    sub.className = 'sub';
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    sub.appendChild(dot);
    const statusLabel = document.createElement('span');
    statusLabel.textContent = statusLabelFor(item);
    sub.appendChild(statusLabel);
    meta.appendChild(sub);
    el.appendChild(meta);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.title = 'Hapus item';
    remove.textContent = '×';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      removeItem(item.id);
    });
    el.appendChild(remove);

    const progress = document.createElement('div');
    progress.className = 'progress';
    progress.style.width = `${Math.round(item.progress * 100)}%`;
    el.appendChild(progress);

    el.addEventListener('click', () => selectItem(item.id));
    return el;
  }

  function statusLabelFor(item) {
    switch (item.status) {
      case EXPORT_STATUS.EXPORTING: return `Exporting ${Math.round(item.progress * 100)}%`;
      case EXPORT_STATUS.DONE: return 'Selesai';
      case EXPORT_STATUS.ERROR: return item.errorMessage || 'Error';
      default: return 'Menunggu';
    }
  }

  function refreshItemElement(item) {
    const el = dom.queueList.querySelector(`[data-id="${item.id}"]`);
    if (!el) return;
    el.dataset.status = item.status;
    const sub = el.querySelector('.sub span:nth-child(2)');
    if (sub) sub.textContent = statusLabelFor(item);
    const prog = el.querySelector('.progress');
    if (prog) prog.style.width = `${Math.round(item.progress * 100)}%`;
  }

  // ============================================================
  // 11. PRESET RENDER & OPERASI
  // ============================================================
  function renderPresets() {
    dom.presetCount.textContent = `${state.presets.length} preset`;
    dom.btnClearPresets.disabled = state.presets.length === 0;

    if (state.presets.length === 0) {
      dom.presetList.innerHTML =
        '<div class="queue-empty">Belum ada preset. Import JSON atau simpan setting global sebagai preset.</div>';
    } else {
      dom.presetList.innerHTML = '';
      for (const preset of state.presets) {
        dom.presetList.appendChild(renderPresetItem(preset));
      }
    }

    updateJobHint();
    updateExportAvailability();
  }

  function renderPresetItem(preset) {
    const el = document.createElement('div');
    el.className = 'queue-item preset-item';
    el.dataset.presetId = preset.id;

    const icon = document.createElement('div');
    icon.className = 'preset-thumb';
    icon.textContent = '🎛️';
    el.appendChild(icon);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = preset.name;
    name.title = preset.name;
    meta.appendChild(name);

    const s = preset.settings;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent =
      `${s.objects.A.shape}/${s.objects.B.shape} · ` +
      `${s.objects.A.duration}s/${s.objects.B.duration}s · ` +
      `${s.export.fps}fps · ${s.export.width}×${s.export.height}`;
    meta.appendChild(sub);
    el.appendChild(meta);

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'preset-action';
    apply.title = 'Muat preset ini ke setting global';
    apply.textContent = '↧';
    apply.addEventListener('click', (e) => {
      e.stopPropagation();
      applyPresetToSettings(preset);
    });
    el.appendChild(apply);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.title = 'Hapus preset';
    remove.textContent = '×';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      removePreset(preset.id);
    });
    el.appendChild(remove);

    el.addEventListener('click', () => applyPresetToSettings(preset));
    return el;
  }

  function applyPresetToSettings(preset) {
    const angles = {
      A: state.settings.objects.A.angle || 0,
      B: state.settings.objects.B.angle || 0,
    };
    state.settings = mergeSettings(defaultSettings(), preset.settings);
    state.settings.objects.A.angle = angles.A;
    state.settings.objects.B.angle = angles.B;

    syncControlsFromSettings();
    drawFrame();
    setStatus(`↧ Preset "${preset.name}" dimuat ke setting global.`);
    setTimeout(() => setStatus(''), 2000);
  }

  function addPresetFromSettings() {
    const name = prompt('Nama preset:', `Preset ${state.presets.length + 1}`);
    if (!name || !name.trim()) return;

    state.presets.push({
      id: uid(),
      name: name.trim(),
      settings: deepClone(state.settings),
    });
    renderPresets();
    setStatus(`💾 Preset "${name.trim()}" disimpan.`);
    setTimeout(() => setStatus(''), 2000);
  }

  function removePreset(id) {
    const idx = state.presets.findIndex((p) => p.id === id);
    if (idx === -1) return;
    state.presets.splice(idx, 1);
    renderPresets();
  }

  function clearPresets() {
    if (state.presets.length === 0) return;
    if (!confirm(`Hapus semua ${state.presets.length} preset?`)) return;
    state.presets = [];
    renderPresets();
  }

  // ============================================================
  // 12. QUEUE OPERASI
  // ============================================================
  async function addImagesFromFiles(files) {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    const newItems = imageFiles.map((file) =>
      createItem({
        name: file.name,
        source: { type: 'file', file },
      })
    );

    state.items.push(...newItems);
    renderQueue();

    if (!state.activeId && newItems.length > 0) {
      await selectItem(newItems[0].id);
    }

    for (const item of newItems) {
      try {
        const dataUrl = await resolveDataURL(item.source);
        item.dataURL = dataUrl;
        item.image = await loadImageFromDataURL(dataUrl);
        const thumbEl = dom.queueList.querySelector(`[data-id="${item.id}"] .thumb`);
        if (thumbEl) thumbEl.src = dataUrl;
        if (item.id === state.activeId) drawFrame();
      } catch (err) {
        console.warn('Gagal preload:', item.name, err);
      }
    }
  }

  async function selectItem(id) {
    if (state.activeId === id) return;
    state.activeId = id;

    dom.queueList.querySelectorAll('.queue-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === id);
    });

    stopAnimation();
    state.animationBaseAngles = { A: 0, B: 0 };

    const item = getActiveItem();
    if (!item) { drawFrame(); return; }

    try { await ensureItemImage(item); } catch (err) { console.error(err); }
    drawFrame();
  }

  function removeItem(id) {
    const idx = state.items.findIndex((i) => i.id === id);
    if (idx === -1) return;
    state.items.splice(idx, 1);

    if (state.activeId === id) {
      stopAnimation();
      state.activeId = state.items.length > 0 ? state.items[0].id : null;
    }
    renderQueue();
    drawFrame();
  }

  function clearCompleted() {
    state.items = state.items.filter((i) => i.status !== EXPORT_STATUS.DONE);
    if (!state.items.find((i) => i.id === state.activeId)) {
      state.activeId = state.items.length > 0 ? state.items[0].id : null;
    }
    renderQueue();
    drawFrame();
  }

  function clearAll() {
    if (state.items.length === 0) return;
    if (!confirm('Hapus semua gambar dari antrean?')) return;
    stopAnimation();
    state.items = [];
    state.activeId = null;
    renderQueue();
    drawFrame();
  }

  // ============================================================
  // 13. SETTINGS SYNC
  // ============================================================
  function syncControlsFromSettings() {
    const s = state.settings;
    const obj = s.objects[state.activeObjectKey];

    dom.sizeSlider.value = obj.size;
    dom.sizeValue.textContent = `${obj.size}px`;
    dom.durationSlider.value = obj.duration;
    dom.durationValue.textContent = `${obj.duration} detik`;
    dom.rotationDirection.value = obj.direction;
    dom.borderColor.value = obj.borderColor;
    dom.showBorder.checked = obj.showBorder;
    dom.showTimer.checked = s.showTimer !== false;
    dom.showSound.checked = s.showSound !== false;
    dom.showBackground.checked = s.showBackground;

    dom.tabButtons.forEach((b) =>
      b.classList.toggle('active', b.dataset.obj === state.activeObjectKey)
    );
    dom.positionButtons.forEach((b) =>
      b.classList.toggle('active', b.dataset.pos === obj.position)
    );
    dom.shapeButtons.forEach((b) =>
      b.classList.toggle('active', b.dataset.shape === obj.shape)
    );

    dom.resolutionSelect.value = `${s.export.width}x${s.export.height}`;
    dom.bitrateSelect.value = s.export.bitrate;
  }

  function mutateSettingsObject(mutator) {
    mutator(state.settings.objects[state.activeObjectKey]);
    drawFrame();
  }

  function mutateSettings(mutator) {
    mutator(state.settings);
    drawFrame();
  }

  // ============================================================
  // 14. BIND UI
  // ============================================================
  function bindUI() {
    dom.uploadArea.addEventListener('click', () => dom.fileInput.click());
    dom.uploadArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        dom.fileInput.click();
      }
    });
    dom.uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      dom.uploadArea.classList.add('dragover');
    });
    dom.uploadArea.addEventListener('dragleave', () => {
      dom.uploadArea.classList.remove('dragover');
    });
    dom.uploadArea.addEventListener('drop', async (e) => {
      e.preventDefault();
      dom.uploadArea.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files || []);
      const jsonFiles = files.filter((f) => f.type === 'application/json' || f.name.endsWith('.json'));
      const imageFiles = files.filter((f) => f.type.startsWith('image/'));
      for (const jf of jsonFiles) await importJsonFile(jf);
      if (imageFiles.length > 0) await addImagesFromFiles(imageFiles);
    });

    dom.fileInput.addEventListener('change', async (e) => {
      if (e.target.files?.length) await addImagesFromFiles(e.target.files);
      e.target.value = '';
    });

    dom.jsonInput.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (f) await importJsonFile(f);
      e.target.value = '';
    });

    dom.btnImportJson.addEventListener('click', () => dom.jsonInput.click());
    dom.btnExportJson.addEventListener('click', () => exportJson());
    dom.btnSavePreset.addEventListener('click', addPresetFromSettings);
    dom.btnClearPresets.addEventListener('click', clearPresets);

    dom.btnClearCompleted.addEventListener('click', clearCompleted);
    dom.btnClearAll.addEventListener('click', clearAll);

    dom.tabButtons.forEach((btn) =>
      btn.addEventListener('click', () => {
        state.activeObjectKey = btn.dataset.obj;
        syncControlsFromSettings();
      })
    );

    dom.positionButtons.forEach((btn) =>
      btn.addEventListener('click', () => {
        mutateSettingsObject((obj) => { obj.position = btn.dataset.pos; });
        syncControlsFromSettings();
      })
    );

    dom.shapeButtons.forEach((btn) =>
      btn.addEventListener('click', () => {
        mutateSettingsObject((obj) => { obj.shape = btn.dataset.shape; });
        syncControlsFromSettings();
      })
    );

    dom.sizeSlider.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      mutateSettingsObject((obj) => { obj.size = v; });
      dom.sizeValue.textContent = `${v}px`;
    });

    dom.durationSlider.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      mutateSettingsObject((obj) => { obj.duration = v; });
      dom.durationValue.textContent = `${v} detik`;
    });

    dom.rotationDirection.addEventListener('change', (e) => {
      mutateSettingsObject((obj) => { obj.direction = e.target.value; });
    });

    dom.borderColor.addEventListener('input', (e) => {
      mutateSettingsObject((obj) => { obj.borderColor = e.target.value; });
    });

    dom.showBorder.addEventListener('change', (e) => {
      mutateSettingsObject((obj) => { obj.showBorder = e.target.checked; });
    });

    dom.showTimer.addEventListener('change', (e) => {
      mutateSettings((s) => { s.showTimer = e.target.checked; });
    });

    dom.showSound.addEventListener('change', (e) => {
      mutateSettings((s) => { s.showSound = e.target.checked; });
    });

    dom.showBackground.addEventListener('change', (e) => {
      mutateSettings((s) => { s.showBackground = e.target.checked; });
    });

    dom.resolutionSelect.addEventListener('change', () => {
      const [w, h] = dom.resolutionSelect.value.split('x').map(Number);
      mutateSettings((s) => { s.export.width = w; s.export.height = h; });
    });
    dom.bitrateSelect.addEventListener('change', () => {
      mutateSettings((s) => { s.export.bitrate = parseInt(dom.bitrateSelect.value, 10); });
    });

    dom.btnPlay.addEventListener('click', toggleAnimation);
    dom.btnReset.addEventListener('click', resetAnimation);

    dom.btnExportCurrent.addEventListener('click', () => exportOne(getActiveItem()));
    dom.btnExportAll.addEventListener('click', exportAll);
  }

  // ============================================================
  // 15. JSON IMPORT / EXPORT
  // ============================================================
  function buildSettingsPayload() {
    return {
      version: JSON_VERSION,
      type: JSON_TYPE,
      exportedAt: new Date().toISOString(),
      items: [],
      settings: deepClone(state.settings),
      presets: state.presets.map((p) => ({
        name: p.name,
        settings: deepClone(p.settings),
      })),
    };
  }

  function exportJson() {
    const payload = buildSettingsPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shape-rotator-settings_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);

    setStatus(
      `✅ JSON diexport: 1 setting global` +
      (state.presets.length ? ` + ${state.presets.length} preset.` : '.')
    );
    setTimeout(() => setStatus(''), 3000);
  }

  function normalizeImportedJson(data) {
    const result = { settings: null, presets: [] };
    if (!data) return result;

    if (Array.isArray(data)) {
      result.presets = data.map((raw, i) => ({
        name: String(raw?.name || `Preset ${i + 1}`),
        settings: mergeSettings(defaultSettings(), raw?.settings || raw),
      }));
      return result;
    }

    if (data.settings && typeof data.settings === 'object') {
      result.settings = mergeSettings(defaultSettings(), data.settings);
    } else if (data.objects || data.export || typeof data.showBackground === 'boolean') {
      result.settings = mergeSettings(defaultSettings(), data);
    }

    if (Array.isArray(data.presets)) {
      result.presets = data.presets.map((p, i) => ({
        name: String(p?.name || `Preset ${i + 1}`),
        settings: mergeSettings(defaultSettings(), p?.settings || p),
      }));
    }

    return result;
  }

  async function importJsonFile(file) {
    try {
      setStatus('📥 Membaca JSON...');
      const text = await file.text();
      const data = JSON.parse(text);

      const { settings, presets } = normalizeImportedJson(data);

      if (!settings && presets.length === 0) {
        throw new Error('Tidak ada setting atau preset di JSON.');
      }

      if (settings) {
        state.settings = settings;
        state.animationBaseAngles = { A: 0, B: 0 };
      }

      if (presets.length > 0) {
        const newPresets = presets.map((p) => ({
          id: uid(),
          name: p.name,
          settings: p.settings,
        }));

        if (state.presets.length > 0) {
          const replace = confirm(
            `Ada ${state.presets.length} preset saat ini.\n` +
            `OK = ganti dengan ${newPresets.length} preset dari JSON.\n` +
            `Cancel = tambahkan ke daftar.`
          );
          if (replace) state.presets = newPresets;
          else state.presets.push(...newPresets);
        } else {
          state.presets = newPresets;
        }
      }

      syncControlsFromSettings();
      renderPresets();
      drawFrame();

      const parts = [];
      if (settings) parts.push('setting global');
      if (presets.length > 0) parts.push(`${presets.length} preset`);
      setStatus(`✅ Import berhasil: ${parts.join(' + ')}.`);
      setTimeout(() => setStatus(''), 3000);
    } catch (err) {
      console.error(err);
      alert('Gagal membaca JSON: ' + err.message);
      setStatus('❌ Import JSON gagal.');
    }
  }

  function mergeSettings(base, override) {
    const result = deepClone(base);
    if (!override || typeof override !== 'object') return result;

    if (typeof override.showBackground === 'boolean') {
      result.showBackground = override.showBackground;
    }
    if (typeof override.showTimer === 'boolean') {
      result.showTimer = override.showTimer;
    }
    if (typeof override.showSound === 'boolean') {
      result.showSound = override.showSound;
    }
    if (override.objects && typeof override.objects === 'object') {
      for (const key of OBJECT_KEYS) {
        if (override.objects[key]) {
          Object.assign(result.objects[key], override.objects[key]);
        }
      }
    }
    if (override.export && typeof override.export === 'object') {
      Object.assign(result.export, override.export);
      // Paksa durasi & fps, apa pun yang ada di JSON
      result.export.duration = FORCED_VIDEO_DURATION;
      result.export.fps = FORCED_FPS;
    }
    return result;
  }

  // ============================================================
  // 16. AUDIO GENERATOR
  // ============================================================
  async function generateTickAudioBuffer(durationSec, urgentFromSec) {
    const totalSamples = Math.ceil(durationSec * AUDIO_SAMPLE_RATE);
    const offline = new OfflineAudioContext(AUDIO_CHANNELS, totalSamples, AUDIO_SAMPLE_RATE);

    const master = offline.createGain();
    master.gain.value = 1.0;
    master.connect(offline.destination);

    // ============ TICK (setiap detik) ============
    for (let s = 0; s < durationSec; s++) {
      const isUrgent = s >= durationSec - urgentFromSec;

      scheduleTick(offline, master, s, {
        freq: isUrgent ? 1400 : 800,
        volume: isUrgent ? 0.55 : 0.20,
        decay: isUrgent ? 0.09 : 0.045,
      });

      // Double-beep pada 5 detik terakhir
      if (isUrgent) {
        scheduleTick(offline, master, s + 0.35, {
          freq: 1700,
          volume: 0.45,
          decay: 0.08,
        });
      }
    }

    // ============ BUZZER (15 detik terakhir, tempo naik mendekati akhir) ============
    const buzzerZoneStart = durationSec - BUZZER_WINDOW_SEC;
    let t = buzzerZoneStart;

    while (t < durationSec) {
      const secondsLeft = durationSec - t;

      let step, baseFreq, volume, buzDur;

      if (secondsLeft > 10) {
        // 45–50s: warning lambat (1 pip per 2 detik)
        step = 2.0; baseFreq = 330; volume = 0.14; buzDur = 0.22;
      } else if (secondsLeft > 5) {
        // 50–55s: warning reguler (1 pip per detik)
        step = 1.0; baseFreq = 440; volume = 0.18; buzDur = 0.18;
      } else {
        // 55–60s: alarm cepat (2 pip per detik)
        step = 0.5; baseFreq = 660; volume = 0.22; buzDur = 0.12;
      }

      scheduleBuzzer(offline, master, t, buzDur, baseFreq, volume);
      t += step;
    }

    return await offline.startRendering();
  }

  function scheduleTick(offline, destination, startTimeSec, { freq, volume, decay }) {
    const osc = offline.createOscillator();
    const gain = offline.createGain();

    osc.type = 'sine';
    osc.frequency.value = freq;

    gain.gain.setValueAtTime(0.0001, startTimeSec);
    gain.gain.exponentialRampToValueAtTime(volume, startTimeSec + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTimeSec + decay);

    osc.connect(gain);
    gain.connect(destination);
    osc.start(startTimeSec);
    osc.stop(startTimeSec + decay + 0.01);
  }

  function scheduleBuzzer(offline, destination, startTimeSec, duration, baseFreq, volume) {
    const freqs = [baseFreq, baseFreq * 1.06];
    for (const f of freqs) {
      const osc = offline.createOscillator();
      const gain = offline.createGain();

      osc.type = 'square';
      osc.frequency.value = f;

      gain.gain.setValueAtTime(0.0001, startTimeSec);
      gain.gain.exponentialRampToValueAtTime(volume, startTimeSec + 0.01);
      gain.gain.setValueAtTime(volume, startTimeSec + Math.max(0.02, duration - 0.03));
      gain.gain.exponentialRampToValueAtTime(0.0001, startTimeSec + duration);

      osc.connect(gain);
      gain.connect(destination);
      osc.start(startTimeSec);
      osc.stop(startTimeSec + duration + 0.01);
    }
  }

  // ============================================================
  // 17. EXPORT MP4 ENGINE
  // ============================================================
  let muxerModulePromise = null;
  function loadMuxerModule() {
    if (!muxerModulePromise) muxerModulePromise = import(MP4_MUXER_URL);
    return muxerModulePromise;
  }

  const supportsWebCodecs = () => 'VideoEncoder' in window;

  function computeJobCount() {
    if (state.items.length === 0) return 0;
    if (state.presets.length > 0) return state.items.length * state.presets.length;
    return state.items.length;
  }

  function updateJobHint() {
    const n = state.items.length;
    const m = state.presets.length;
    const dur = FORCED_VIDEO_DURATION;
    let text;
    if (n === 0 && m === 0) {
      text = 'Belum ada gambar. Atur setting, atau upload gambar untuk mulai.';
    } else if (n === 0) {
      text = `${m} preset siap dipakai. Upload gambar untuk mulai export.`;
    } else if (m === 0) {
      text = `${n} gambar × 1 setting global = ${n} video × ${dur}s @ ${FORCED_FPS}fps.`;
    } else {
      text = `${n} gambar × ${m} preset = ${n * m} video × ${dur}s @ ${FORCED_FPS}fps.`;
    }
    dom.jobHint.textContent = text;
  }

  function updateExportAvailability() {
    const supported = supportsWebCodecs();
    const canExport = supported && !state.isExporting;
    const jobs = computeJobCount();

    dom.btnExportCurrent.disabled = !canExport || !getActiveItem();
    dom.btnExportAll.disabled = !canExport || jobs === 0;
    dom.warningBox.classList.toggle('show', !supported);
  }

  async function pickEncoderConfig(width, height, bitrate, framerate) {
    for (const codec of CODEC_CANDIDATES) {
      const config = { codec, width, height, bitrate, framerate };
      try {
        const { supported } = await VideoEncoder.isConfigSupported(config);
        if (supported) return config;
      } catch { /* coba berikutnya */ }
    }
    return null;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);
  }

  async function waitForEncoderQueue(encoder) {
    while (encoder.encodeQueueSize > ENCODER_QUEUE_LOW) await sleep(2);
  }

  function setStatus(text) { dom.statusText.textContent = text; }
  function setProgress(ratio) { dom.progressFill.style.width = `${Math.round(ratio * 100)}%`; }
  function setBatchProgress(ratio) { dom.batchProgressFill.style.width = `${Math.round(ratio * 100)}%`; }

  function setExporting(isExporting, { batch = false } = {}) {
    state.isExporting = isExporting;
    dom.progressBar.classList.toggle('active', isExporting);
    dom.batchProgressBar.classList.toggle('active', isExporting && batch);
    if (!isExporting) {
      setProgress(0);
      setBatchProgress(0);
    }
    updateExportAvailability();
  }

  async function renderImageToMp4(image, settings, opts, onProgress) {
    const { fps, duration, width, height, bitrate, includeAudio } = opts;

    const { Muxer, ArrayBufferTarget } = await loadMuxerModule();

    const encoderConfig = await pickEncoderConfig(width, height, bitrate, fps);
    if (!encoderConfig) throw new Error('Tidak ada codec H.264 yang didukung.');

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width, height },
      audio: includeAudio
        ? { codec: 'aac', sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: AUDIO_CHANNELS }
        : undefined,
      fastStart: 'in-memory',
    });

    // ---- Video encoder ----
    let videoError = null;
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { videoError = e; console.error('[VideoEncoder]', e); },
    });
    videoEncoder.configure(encoderConfig);

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;
    const exportCtx = exportCanvas.getContext('2d');

    const totalFrames = fps * duration;
    const keyframeInterval = fps * 2;

    // ---- Audio encoder (opsional) ----
    let audioEncoder = null;
    if (includeAudio && 'AudioEncoder' in window) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => console.error('[AudioEncoder]', e),
      });

      const audioConfig = {
        codec: 'mp4a.40.2',
        sampleRate: AUDIO_SAMPLE_RATE,
        numberOfChannels: AUDIO_CHANNELS,
        bitrate: AUDIO_BITRATE,
      };

      try {
        const { supported } = await AudioEncoder.isConfigSupported(audioConfig);
        if (!supported) {
          console.warn('[Audio] AAC tidak didukung, export tanpa suara.');
          audioEncoder = null;
        } else {
          audioEncoder.configure(audioConfig);
        }
      } catch (e) {
        console.warn('[Audio] isConfigSupported gagal:', e);
        audioEncoder = null;
      }
    }

    try {
      // ============ 1. Encode VIDEO ============
      for (let frame = 0; frame < totalFrames; frame++) {
        if (videoError) throw videoError;

        renderToCanvas(exportCtx, image, settings, width, height, frame / fps);

        const videoFrame = new VideoFrame(exportCanvas, {
          timestamp: Math.round((frame * 1_000_000) / fps),
        });
        videoEncoder.encode(videoFrame, { keyFrame: frame % keyframeInterval === 0 });
        videoFrame.close();

        const ratio = (frame + 1) / totalFrames;
        if (onProgress) onProgress(ratio);

        if (videoEncoder.encodeQueueSize > ENCODER_QUEUE_HIGH) await waitForEncoderQueue(videoEncoder);
        if (frame % UI_YIELD_EVERY_N_FRAMES === 0) await nextTick();
      }

      await videoEncoder.flush();

      // ============ 2. Encode AUDIO ============
      if (audioEncoder) {
        const audioBuffer = await generateTickAudioBuffer(duration, URGENT_THRESHOLD_SEC);
        const channelData = audioBuffer.getChannelData(0);
        const totalSamples = channelData.length;
        const chunkSize = 1024;

        for (let i = 0; i < totalSamples; i += chunkSize) {
          const end = Math.min(i + chunkSize, totalSamples);
          const slice = channelData.slice(i, end);

          const audioData = new AudioData({
            format: 'f32-planar',
            sampleRate: AUDIO_SAMPLE_RATE,
            numberOfFrames: slice.length,
            numberOfChannels: AUDIO_CHANNELS,
            timestamp: Math.round((i * 1_000_000) / AUDIO_SAMPLE_RATE),
            data: slice,
          });
          audioEncoder.encode(audioData);
          audioData.close();

          if (audioEncoder.encodeQueueSize > ENCODER_QUEUE_HIGH) {
            while (audioEncoder.encodeQueueSize > ENCODER_QUEUE_LOW) await sleep(2);
          }
        }

        await audioEncoder.flush();
      }
    } finally {
      try { videoEncoder.close(); } catch { /* ignore */ }
      try { audioEncoder?.close(); } catch { /* ignore */ }
    }

    muxer.finalize();
    return new Blob([target.buffer], { type: 'video/mp4' });
  }

  /**
   * Format nama file output:
   *   Dengan preset : {presetName}-{imageName}-{WxH}.mp4
   *   Tanpa preset  : {imageName}-{WxH}.mp4
   */
  function buildJobFilename(itemName, presetName, width, height) {
    const imgName = sanitizeFilename(itemName);
    const presetTag = presetName ? `${sanitizeFilename(presetName)}-` : '';
    return `${presetTag}${imgName}-${width}x${height}.mp4`;
  }

  // ------------------------------------------------------------
  // Export item aktif
  // ------------------------------------------------------------
  async function exportOne(item) {
    if (!item) { alert('Pilih gambar dulu.'); return; }
    if (!supportsWebCodecs()) { alert('Browser tidak mendukung WebCodecs API.'); return; }
    if (state.isExporting) return;

    if (!item.image) {
      try { await ensureItemImage(item); }
      catch { alert('Gambar item ini belum siap.'); return; }
    }

    setExporting(true);
    setStatus(`🎬 Export "${item.name}"...`);

    const settings = deepClone(state.settings);
    settings.export.fps = FORCED_FPS;
    settings.export.duration = FORCED_VIDEO_DURATION;
    const opts = {
      ...settings.export,
      includeAudio: settings.showSound !== false,
    };

    try {
      item.status = EXPORT_STATUS.EXPORTING;
      item.progress = 0;
      item.errorMessage = null;
      refreshItemElement(item);

      const blob = await renderImageToMp4(item.image, settings, opts, (ratio) => {
        item.progress = ratio;
        refreshItemElement(item);
        setProgress(ratio);
        setStatus(`Encoding "${item.name}" — ${Math.round(ratio * 100)}%`);
      });
      downloadBlob(blob, buildJobFilename(item.name, null, opts.width, opts.height));

      item.status = EXPORT_STATUS.DONE;
      item.progress = 1;
      refreshItemElement(item);
      setStatus(`✅ "${item.name}" selesai.`);
      setTimeout(() => setStatus(''), 3000);
    } catch (err) {
      console.error(err);
      item.status = EXPORT_STATUS.ERROR;
      item.errorMessage = err.message || 'Export gagal';
      refreshItemElement(item);
      setStatus(`❌ "${item.name}": ${item.errorMessage}`);
    } finally {
      setExporting(false);
    }
  }

  // ------------------------------------------------------------
  // Export semua
  // ------------------------------------------------------------
  async function exportAll() {
    if (state.items.length === 0) { alert('Upload gambar dulu.'); return; }
    if (!supportsWebCodecs()) { alert('Browser tidak mendukung WebCodecs API.'); return; }
    if (state.isExporting) return;

    const jobs = [];
    if (state.presets.length > 0) {
      for (const item of state.items) {
        for (const preset of state.presets) {
          jobs.push({ item, settings: deepClone(preset.settings), presetName: preset.name });
        }
      }
    } else {
      const globalSettings = deepClone(state.settings);
      for (const item of state.items) {
        jobs.push({ item, settings: globalSettings, presetName: null });
      }
    }

    const total = jobs.length;
    if (total === 0) { alert('Tidak ada job untuk diexport.'); return; }

    const summary = state.presets.length > 0
      ? `${state.items.length} gambar × ${state.presets.length} preset = ${total} video × ${FORCED_VIDEO_DURATION}s`
      : `${total} video × ${FORCED_VIDEO_DURATION}s (setting global)`;

    if (!confirm(`Export ${summary}?\nBrowser akan mengunduh satu per satu.`)) return;

    for (const item of state.items) {
      item.status = EXPORT_STATUS.PENDING;
      item.progress = 0;
      item.errorMessage = null;
    }
    renderQueue();

    setExporting(true, { batch: true });
    setBatchProgress(0);

    const totalPerItem = new Map();
    const donePerItem = new Map();
    for (const job of jobs) {
      totalPerItem.set(job.item.id, (totalPerItem.get(job.item.id) || 0) + 1);
      if (!donePerItem.has(job.item.id)) donePerItem.set(job.item.id, 0);
    }

    let completed = 0;
    let failed = 0;

    for (let i = 0; i < jobs.length; i++) {
      const { item, settings, presetName } = jobs[i];
      const tag = presetName ? ` [${presetName}]` : '';

      setStatus(`🎬 (${i + 1}/${total}) ${item.name}${tag}`);

      if (!item.image) {
        try { await ensureItemImage(item); }
        catch {
          item.status = EXPORT_STATUS.ERROR;
          item.errorMessage = 'Gambar gagal dimuat';
          refreshItemElement(item);
          failed++;
          donePerItem.set(item.id, donePerItem.get(item.id) + 1);
          setBatchProgress((i + 1) / total);
          continue;
        }
      }

      item.status = EXPORT_STATUS.EXPORTING;
      refreshItemElement(item);

      // Paksa fps & durasi
      settings.export = {
        ...(settings.export || {}),
        fps: FORCED_FPS,
        duration: FORCED_VIDEO_DURATION,
      };

      const opts = {
        fps: FORCED_FPS,
        duration: FORCED_VIDEO_DURATION,
        width: settings.export.width ?? 540,
        height: settings.export.height ?? 960,
        bitrate: settings.export.bitrate ?? 5000000,
        includeAudio: settings.showSound !== false,
      };

      try {
        const blob = await renderImageToMp4(item.image, settings, opts, (ratio) => {
          const done = donePerItem.get(item.id);
          const tot = totalPerItem.get(item.id);
          item.progress = (done + ratio) / tot;
          refreshItemElement(item);
          setProgress(ratio);
        });

        downloadBlob(blob, buildJobFilename(item.name, presetName, opts.width, opts.height));

        completed++;
        const doneNow = donePerItem.get(item.id) + 1;
        donePerItem.set(item.id, doneNow);
        item.progress = doneNow / totalPerItem.get(item.id);
        if (doneNow >= totalPerItem.get(item.id)) item.status = EXPORT_STATUS.DONE;
        refreshItemElement(item);
      } catch (err) {
        console.error(err);
        failed++;
        item.status = EXPORT_STATUS.ERROR;
        item.errorMessage = err.message || 'Export gagal';
        donePerItem.set(item.id, donePerItem.get(item.id) + 1);
        refreshItemElement(item);
      }

      setBatchProgress((i + 1) / total);
      setStatus(`✅ ${completed} selesai, ${failed} gagal, ${total - i - 1} tersisa.`);

      if (i < jobs.length - 1) await sleep(DOWNLOAD_BATCH_GAP_MS);
    }

    setExporting(false);
    setStatus(`🎉 Batch selesai: ${completed} berhasil, ${failed} gagal dari ${total} video.`);
    drawFrame();
    setTimeout(() => setStatus(''), 6000);
  }

  // ============================================================
  // 18. SERVICE WORKER
  // ============================================================
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./sw.js')
        .catch((err) => console.warn('[App] Registrasi SW gagal:', err));
    });
  }

  // ============================================================
  // 19. INIT
  // ============================================================
  function init() {
    bindUI();
    renderQueue();
    renderPresets();
    syncControlsFromSettings();
    drawFrame();
    updateExportAvailability();
    registerServiceWorker();
  }

  init();
})();