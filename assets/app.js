/* PixelPress engine v3 — 100% on-device. Resilient decode + render. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const kb = b => b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(2)} MB`;
const DPI_DEF = 300, MM = 25.4, MAX_BYTES = 80 * 1048576, MIN_CROP = 16;

/* ---------- chrome + bot-safe contact assembly ---------- */
(() => {
  const t = localStorage.getItem('pp-theme');
  if (t) document.documentElement.dataset.theme = t;
  $('#theme')?.addEventListener('click', () => {
    const n = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = n;
    localStorage.setItem('pp-theme', n);
  });
  $('#menu')?.addEventListener('click', e => {
    $('.nav-links')?.classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded',
      String($('.nav-links')?.classList.contains('open')));
  });
  ['q'].forEach(id => {
    const el = $('#' + id), outEl = $('#qv');
    if (el && outEl) el.addEventListener('input', () => { outEl.textContent = el.value; });
  });

  // Bot-safe contact assembly: parts assembled only on user click or after load
  const uParts = ['avnesh', 'g45'];
  const dParts = ['gmail', 'com'];
  const getAddr = () => `${uParts.join('')}@${dParts.join('.')}`;

  $$('[data-contact-reveal]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const addr = getAddr();
      const targetId = btn.dataset.contactTarget;
      const target = targetId ? $('#' + targetId) : null;
      if (target) target.textContent = addr;
      try {
        await navigator.clipboard.writeText(addr);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = addr;
      }
    });
  });

  $$('[data-contact-display]').forEach(el => {
    el.textContent = getAddr();
  });
})();

/* ---------- heic & resilient image loader ---------- */
let heicP;
const loadHeic = () => heicP ??= new Promise((ok, no) => {
  if (window.heic2any) return ok();
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
  s.onload = ok;
  s.onerror = () => { heicP = null; no(new Error('HEIC decoder load failed')); };
  document.head.appendChild(s);
});
const isHeic = f => /heic|heif/i.test(f.type) || /\.hei[cf]$/i.test(f.name);
const isImageLike = f => /^image\//.test(f.type) || isHeic(f) || /\.(jpe?g|png|webp|gif|bmp|avif|svg)$/i.test(f.name);

function loadImageElement(blob) {
  return new Promise((ok, no) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); ok(img); };
    img.onerror = () => { URL.revokeObjectURL(url); no(new Error('Image element decode failed')); };
    img.src = url;
  });
}

async function decode(file) {
  let src = file;
  if (isHeic(file)) {
    await loadHeic();
    const o = await window.heic2any({ blob: file, toType: 'image/png', quality: 0.95 });
    src = Array.isArray(o) ? o[0] : o;
  }
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(src, { imageOrientation: 'from-image' });
    } catch {
      try {
        return await createImageBitmap(src);
      } catch {}
    }
  }
  const img = await loadImageElement(src);
  const w = img.naturalWidth || img.width || 1;
  const h = img.naturalHeight || img.height || 1;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(c); } catch {}
  }
  return c;
}

const getW = src => src.naturalWidth || src.width;
const getH = src => src.naturalHeight || src.height;
const closeSrc = src => { try { src.close?.(); } catch {} };

const toBlob = (c, type, q) => new Promise((ok, no) => {
  try {
    c.toBlob(b => b ? ok(b) : no(new Error('toBlob returned null')), type, q);
  } catch (e) {
    no(e);
  }
});

/* ---------- viewer ---------- */
class Viewer {
  constructor(canvas) {
    this.c = canvas;
    this.x = canvas ? canvas.getContext('2d') : null;
    this.bmp = null;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.crop = null;
    this.ratio = null;
    this.mode = null;
    this.ptrs = new Map();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.c && this.x) {
      this.bind();
      new ResizeObserver(() => this.paint()).observe(canvas.parentElement);
    }
  }
  bind() {
    const s = this.c.parentElement;
    s.addEventListener('pointerdown', e => this.down(e));
    s.addEventListener('pointermove', e => this.move(e));
    s.addEventListener('pointerup', e => this.up(e));
    s.addEventListener('pointercancel', e => this.up(e));
    s.addEventListener('wheel', e => this.wheel(e), { passive: false });
    s.addEventListener('dblclick', () => { this.fit(); this.paint(); });
  }
  size() {
    if (!this.c) return { w: 0, h: 0 };
    const r = this.c.parentElement.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }
  toImg(e) {
    const r = this.c.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.tx) / this.scale, y: (e.clientY - r.top - this.ty) / this.scale };
  }
  load(bmp) {
    this.bmp = bmp;
    this.crop = { x: 0, y: 0, w: getW(bmp), h: getH(bmp) };
    if (this.ratio) this.applyRatio(); else this.fit();
    this.paint();
  }
  clear() { this.bmp = null; this.crop = null; this.paint(); }
  setRatio(r) {
    this.ratio = r || null;
    if (this.bmp && r) this.applyRatio();
    this.paint();
  }
  applyRatio() {
    if (!this.bmp || !this.ratio) return;
    const bw = getW(this.bmp), bh = getH(this.bmp);
    const c = this.crop || { x: 0, y: 0, w: bw, h: bh };
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    let w = c.w, h = w / this.ratio;
    if (h > bh) { h = bh; w = h * this.ratio; }
    if (w > bw) { w = bw; h = w / this.ratio; }
    this.crop = { x: cx - w / 2, y: cy - h / 2, w, h };
    this.clampCrop();
    this.fit();
  }
  clampCrop() {
    const b = this.bmp, c = this.crop;
    if (!b || !c) return;
    const bw = getW(b), bh = getH(b);
    c.w = Math.min(Math.max(c.w, Math.min(MIN_CROP, bw)), bw);
    c.h = this.ratio ? c.w / this.ratio : Math.min(Math.max(c.h, Math.min(MIN_CROP, bh)), bh);
    if (c.h > bh) { c.h = bh; if (this.ratio) c.w = c.h * this.ratio; }
    if (c.w > bw) { c.w = bw; if (this.ratio) c.h = c.w / this.ratio; }
    c.x = Math.min(Math.max(c.x, 0), Math.max(0, bw - c.w));
    c.y = Math.min(Math.max(c.y, 0), Math.max(0, bh - c.h));
  }
  fit() {
    if (!this.bmp) return;
    const s = this.size();
    const bw = getW(this.bmp), bh = getH(this.bmp);
    if (!bw || !bh) return;
    const k = Math.min(s.w / bw, s.h / bh) * 0.94;
    this.scale = k || 1;
    this.tx = (s.w - bw * this.scale) / 2;
    this.ty = (s.h - bh * this.scale) / 2;
  }
  down(e) {
    if (!this.bmp) return;
    this.c.parentElement.setPointerCapture(e.pointerId);
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = this.toImg(e), c = this.crop;
    const inside = c && p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h;
    this.mode = inside ? 'crop' : 'pan';
    this.grab = { p, c: c ? { ...c } : null, tx: this.tx, ty: this.ty };
  }
  move(e) {
    if (!this.mode || !this.ptrs.has(e.pointerId)) return;
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.ptrs.size === 2) {
      const [a, b] = [...this.ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchD) {
        const r = d / this.pinchD;
        const r0 = this.c.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - r0.left, my = (a.y + b.y) / 2 - r0.top;
        const ix = (mx - this.tx) / this.scale, iy = (my - this.ty) / this.scale;
        this.scale = Math.min(Math.max(this.scale * r, 0.04), 10);
        this.tx = mx - ix * this.scale;
        this.ty = my - iy * this.scale;
        this.paint();
      }
      this.pinchD = d;
      return;
    }

    const p = this.toImg(e);
    if (this.mode === 'crop' && this.grab.c) {
      const c = this.crop;
      c.x = this.grab.c.x + (p.x - this.grab.p.x);
      c.y = this.grab.c.y + (p.y - this.grab.p.y);
      this.clampCrop();
    } else {
      const r0 = this.c.getBoundingClientRect();
      this.tx = this.grab.tx + (e.clientX - r0.left - this.grab.p.x * this.scale);
      this.ty = this.grab.ty + (e.clientY - r0.top - this.grab.p.y * this.scale);
    }
    this.paint();
  }
  up(e) {
    this.ptrs.delete(e.pointerId);
    if (this.ptrs.size < 2) this.pinchD = 0;
    if (!this.ptrs.size) this.mode = null;
  }
  wheel(e) {
    if (!this.bmp) return;
    e.preventDefault();
    const r = this.c.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const ix = (mx - this.tx) / this.scale, iy = (my - this.ty) / this.scale;
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.scale = Math.min(Math.max(this.scale * f, 0.04), 10);
    this.tx = mx - ix * this.scale;
    this.ty = my - iy * this.scale;
    this.paint();
  }
  zoom(f) {
    const s = this.size(), mx = s.w / 2, my = s.h / 2;
    const ix = (mx - this.tx) / this.scale, iy = (my - this.ty) / this.scale;
    this.scale = Math.min(Math.max(this.scale * f, 0.04), 10);
    this.tx = mx - ix * this.scale;
    this.ty = my - iy * this.scale;
    this.paint();
  }
  paint() {
    if (!this.c || !this.x) return;
    const { w, h } = this.size();
    if (!w || !h) return;
    this.c.width = Math.round(w * this.dpr);
    this.c.height = Math.round(h * this.dpr);
    const x = this.x;
    x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    if (!this.bmp) return;
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale,
      this.dpr * this.tx, this.dpr * this.ty);
    x.drawImage(this.bmp, 0, 0);
    x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const c = this.crop;
    if (!c) return;
    const X = c.x * this.scale + this.tx, Y = c.y * this.scale + this.ty;
    const W = c.w * this.scale, H = c.h * this.scale;
    x.fillStyle = 'rgba(0,0,0,.55)';
    x.fillRect(0, 0, w, Y);
    x.fillRect(0, Y + H, w, h - Y - H);
    x.fillRect(0, Y, X, H);
    x.fillRect(X + W, Y, w - X - W, H);
    x.strokeStyle = '#c6ff4d';
    x.lineWidth = 1.5;
    x.strokeRect(X, Y, W, H);
    x.strokeStyle = 'rgba(255,255,255,.35)';
    x.beginPath();
    x.moveTo(X + W / 3, Y); x.lineTo(X + W / 3, Y + H);
    x.moveTo(X + 2 * W / 3, Y); x.lineTo(X + 2 * W / 3, Y + H);
    x.moveTo(X, Y + H / 3); x.lineTo(X + W, Y + H / 3);
    x.moveTo(X, Y + 2 * H / 3); x.lineTo(X + W, Y + 2 * H / 3);
    x.stroke();
  }
}

/* ---------- render ---------- */
function dims(bmp, o) {
  const bw = getW(bmp), bh = getH(bmp);
  const c = o.crop && o.crop.w > 0 && o.crop.h > 0 ? o.crop : { x: 0, y: 0, w: bw, h: bh };
  let w = c.w, h = c.h;
  if (o.exactW && o.exactH) {
    w = o.exactW;
    h = o.exactH;
  } else {
    if (o.maxW && w > o.maxW) { h = h * o.maxW / w; w = o.maxW; }
    if (o.maxH && h > o.maxH) { w = w * o.maxH / h; h = o.maxH; }
    if (o.pct) { w *= o.pct / 100; h *= o.pct / 100; }
  }
  return {
    c: {
      x: Math.max(0, Math.min(c.x, bw - 1)),
      y: Math.max(0, Math.min(c.y, bh - 1)),
      w: Math.max(1, Math.min(c.w, bw)),
      h: Math.max(1, Math.min(c.h, bh))
    },
    w: Math.max(1, Math.round(w)),
    h: Math.max(1, Math.round(h))
  };
}

function render(bmp, o) {
  const { c, w, h } = dims(bmp, o);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const x = cv.getContext('2d');
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  if (o.type === 'image/jpeg' || o.bg) {
    x.fillStyle = o.bg || '#fff';
    x.fillRect(0, 0, w, h);
  }
  x.drawImage(bmp, c.x, c.y, c.w, c.h, 0, 0, w, h);
  return cv;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/* ---------- app ---------- */
const tool = document.body.dataset.tool;
if (tool) boot();

function boot() {
  const files = [], urls = {}, out = [];
  let active = 0, busy = false;
  const viewer = new Viewer($('#view'));
  const list = $('#list'), results = $('#results'), drop = $('#drop'), input = $('#file');
  const run = $('#run'), bar = $('#bar'), barI = $('#bar i'), msg = $('#msg');

  const num = id => parseFloat($('#' + id)?.value) || 0;
  const val = id => $('#' + id)?.value || '';
  const px = (v, unit, dpi) => {
    if (!v) return 0;
    if (unit === 'cm' || unit === 'mm') return Math.round(v * dpi / MM);
    if (unit === 'in') return Math.round(v * dpi);
    return Math.round(v);
  };

  const lockRatio = () => {
    if (tool === 'passport') {
      const parts = val('preset').split('x').map(Number);
      const [w, h] = parts.length === 2 && parts[0] && parts[1] ? parts : [35, 45];
      viewer.setRatio(w / h);
    } else if (tool === 'resize' && val('mode') === 'exact') {
      const w = px(num('w'), val('wunit'), num('dpi') || DPI_DEF);
      const h = px(num('h'), val('hunit'), num('dpi') || DPI_DEF);
      viewer.setRatio(w && h ? w / h : null);
    } else {
      viewer.setRatio(null);
    }
  };

  ['preset', 'mode', 'w', 'h', 'wunit', 'hunit', 'dpi'].forEach(id => {
    $('#' + id)?.addEventListener('input', lockRatio);
    $('#' + id)?.addEventListener('change', lockRatio);
  });

  const add = fs => {
    if (!fs || !fs.length) return;
    let added = 0;
    for (const f of fs) {
      if (!isImageLike(f)) {
        msg.textContent = `${f.name}: unsupported image format`;
        continue;
      }
      if (f.size > MAX_BYTES) {
        msg.textContent = `${f.name}: exceeds 80 MB limit`;
        continue;
      }
      files.push(f);
      added++;
    }
    if (!files.length) return;
    if (added > 0) msg.textContent = '';
    if (active >= files.length) active = files.length - 1;
    paintRail();
    select(active);
  };

  const select = async i => {
    active = Math.max(0, Math.min(i, files.length - 1));
    paintRail();
    const f = files[active];
    if (!f) return;
    try {
      const bmp = await decode(f);
      viewer.load(bmp);
      lockRatio();
      msg.textContent = '';
    } catch (err) {
      viewer.clear();
      msg.textContent = `${f.name}: unable to decode (${err?.message || 'format error'})`;
    }
  };

  const paintRail = () => {
    if (!list) return;
    list.innerHTML = '';
    files.forEach((f, i) => {
      const d = document.createElement('div');
      d.className = 'thumb' + (i === active ? ' on' : '');
      d.innerHTML = `<img alt="" src="${urls['t' + i] || ''}"><b title="Remove">✕</b>`;
      d.onclick = e => { if (e.target.tagName === 'B') remove(i); else select(i); };
      list.appendChild(d);
      if (!urls['t' + i]) {
        const u = URL.createObjectURL(f);
        urls['t' + i] = u;
        const im = d.querySelector('img');
        im.src = u;
      }
    });
    if (!files.length) list.innerHTML = '<div class="empty">No files selected</div>';
    if (run) {
      run.disabled = !files.length || busy;
      run.textContent = files.length > 1 ? `Process ${files.length} files` : 'Process';
    }
  };

  const remove = i => {
    const u = urls['t' + i];
    if (u) { URL.revokeObjectURL(u); delete urls['t' + i]; }
    files.splice(i, 1);
    paintRail();
    if (!files.length) { viewer.clear(); return; }
    select(Math.max(0, Math.min(i, files.length - 1)));
  };

  $('#clear')?.addEventListener('click', () => {
    files.length = 0;
    Object.values(urls).forEach(URL.revokeObjectURL);
    Object.keys(urls).forEach(k => delete urls[k]);
    out.forEach(o => URL.revokeObjectURL(o.url));
    out.length = 0;
    if (results) results.innerHTML = '';
    viewer.clear();
    paintRail();
    if (msg) msg.textContent = '';
  });

  drop?.addEventListener('click', () => input?.click());
  input?.addEventListener('change', e => { add(e.target.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach(k => drop?.addEventListener(k, e => { e.preventDefault(); drop.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach(k => drop?.addEventListener(k, e => { e.preventDefault(); drop.classList.remove('hot'); }));
  drop?.addEventListener('drop', e => add(e.dataTransfer?.files));
  window.addEventListener('paste', e => {
    const fs = [...(e.clipboardData?.files || [])];
    if (fs.length) add(fs);
  });

  $('#zin')?.addEventListener('click', () => viewer.zoom(1.25));
  $('#zout')?.addEventListener('click', () => viewer.zoom(0.8));
  $('#zfit')?.addEventListener('click', () => { viewer.fit(); viewer.paint(); });

  $('#sheet')?.addEventListener('change', e => {
    const row = $('#sheetrow');
    if (row) row.classList.toggle('hide', !e.target.value);
  });

  const cfg = () => {
    const dpi = num('dpi') || DPI_DEF;
    const crop = viewer.crop;
    switch (tool) {
      case 'compress': {
        const unit = val('tunit');
        const t = num('target');
        const bytes = t > 0 ? (unit === 'MB' ? t * 1048576 : t * 1024) : 0;
        return {
          crop,
          type: val('fmt') || 'image/webp',
          q: (num('q') || 80) / 100,
          maxW: num('maxw') || 0,
          target: bytes
        };
      }
      case 'convert':
        return {
          crop,
          type: val('to') || 'image/jpeg',
          q: (num('q') || 92) / 100
        };
      case 'resize': {
        const mode = val('mode');
        const w = px(num('w'), val('wunit'), dpi);
        const h = px(num('h'), val('hunit'), dpi);
        const base = { crop, type: val('fmt') || 'image/webp', q: (num('q') || 90) / 100 };
        if (mode === 'exact') return { ...base, exactW: w || 1, exactH: h || 1 };
        if (mode === 'pct') return { ...base, pct: num('pct') || 100 };
        return { ...base, maxW: w, maxH: h };
      }
      case 'passport': {
        const parts = val('preset').split('x').map(Number);
        const [w, h] = parts.length === 2 && parts[0] && parts[1] ? parts : [35, 45];
        return {
          crop,
          type: 'image/jpeg',
          q: 0.93,
          exactW: Math.round(w * DPI_DEF / MM),
          exactH: Math.round(h * DPI_DEF / MM),
          bg: '#fff',
          sheet: val('sheet')
        };
      }
      default:
        return { type: 'image/webp', q: 0.85 };
    }
  };

  async function sheet(blobIn) {
    const bmp = await decode(blobIn);
    const S = document.createElement('canvas');
    S.width = 6 * DPI_DEF;
    S.height = 4 * DPI_DEF;
    const x = S.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, S.width, S.height);
    const gap = Math.round(0.06 * DPI_DEF), w = getW(bmp), h = getH(bmp);
    const cols = Math.max(1, Math.floor((S.width - gap) / (w + gap)));
    const rows = Math.max(1, Math.floor((S.height - gap) / (h + gap)));
    const ox = Math.round((S.width - (cols * w + (cols - 1) * gap)) / 2);
    const oy = Math.round((S.height - (rows * h + (rows - 1) * gap)) / 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        x.drawImage(bmp, ox + c * (w + gap), oy + r * (h + gap));
      }
    }
    closeSrc(bmp);
    const outBlob = await toBlob(S, 'image/jpeg', 0.95);
    S.width = S.height = 0;
    return outBlob;
  }

  function card(name, blob, orig) {
    const u = URL.createObjectURL(blob);
    out.push({ name, url: u, blob });
    const d = document.createElement('div');
    d.className = 'res';
    const saved = orig && orig > blob.size ? Math.round((1 - blob.size / orig) * 100) : 0;
    d.innerHTML = `<img alt="" src="${u}"><span class="nm">${name}</span>
      <span class="sz">${orig ? kb(orig) + ' → ' : ''}<b>${kb(blob.size)}</b>${saved ? ` <i>−${saved}%</i>` : ''}</span>
      <a class="dl btn sm" href="${u}" download="${name}">Save</a>`;
    results.appendChild(d);
  }

  run?.addEventListener('click', async () => {
    if (!files.length || busy) return;
    busy = true;
    run.disabled = true;
    if (msg) msg.textContent = '';
    bar?.classList.add('on');
    if (barI) barI.style.width = '0';
    if (results) results.innerHTML = '';
    out.forEach(o => URL.revokeObjectURL(o.url));
    out.length = 0;
    const c = cfg();
    const dlAll = $('#dlall');
    if (dlAll) dlAll.classList.add('hide');

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const bmp = await decode(f);
        const cv = render(bmp, { ...c, crop: c.crop && files.length === 1 ? c.crop : undefined });
        let blob = null;

        if (c.target) {
          const hi = await toBlob(cv, c.type, 0.92);
          if (hi.size <= c.target) {
            blob = hi;
          } else {
            let lo = 0.12, hiQ = 0.92;
            for (let n = 0; n < 7; n++) {
              const q = (lo + hiQ) / 2;
              const b = await toBlob(cv, c.type, q);
              if (b.size <= c.target) { blob = b; lo = q; } else hiQ = q;
            }
            if (!blob) blob = await toBlob(cv, c.type, 0.12);
          }
        } else {
          blob = await toBlob(cv, c.type, c.q);
        }

        const baseName = f.name.replace(/\.[^.]+$/, '') || 'image';
        const name = baseName + '.' + (EXT[blob.type] || EXT[c.type] || 'jpg');

        if (f.size && blob.size > f.size && !c.target && c.type === f.type) {
          card(name, f, f.size);
        } else {
          card(name, blob, f.size);
        }

        if (c.sheet) {
          const sb = await sheet(blob);
          card(baseName + '-sheet-4x6.jpg', sb, 0);
        }

        cv.width = cv.height = 0;
        closeSrc(bmp);
      } catch (err) {
        results?.insertAdjacentHTML('beforeend',
          `<div class="res"><span class="nm">${f.name}</span><span class="sz" style="color:var(--bad)">fail: ${err?.message || 'error'}</span></div>`);
      }
      if (barI) barI.style.width = `${((i + 1) / files.length) * 100}%`;
    }

    busy = false;
    run.disabled = false;
    bar?.classList.remove('on');
    if (barI) barI.style.width = '0';
    if (msg) msg.textContent = out.length ? `${out.length} file(s) ready.` : 'No files processed.';
    if (out.length > 1 && dlAll) dlAll.classList.remove('hide');
  });

  $('#dlall')?.addEventListener('click', async () => {
    if (!out.length) return;
    if (out.length === 1) return $('.dl', results)?.click();
    const btn = $('#dlall');
    btn.disabled = true;
    btn.textContent = 'Building ZIP…';
    try {
      if (!window.JSZip) {
        await new Promise((ok, no) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
          s.onload = ok;
          s.onerror = no;
          document.head.appendChild(s);
        });
      }
      const z = new window.JSZip();
      out.forEach(o => z.file(o.name, o.blob));
      const b = await z.generateAsync({ type: 'blob' });
      const u = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = u;
      a.download = 'pixelpress.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(u), 8000);
    } catch {
      if (msg) msg.textContent = 'ZIP failed — save files individually.';
    }
    btn.disabled = false;
    btn.textContent = 'Download all (ZIP)';
  });

  paintRail();
  lockRatio();
}
})();
