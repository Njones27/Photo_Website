/* Shared site code: data helpers, ambient light, full-screen viewer. Needs photos.js first. */
(() => {
  const D = window.PORTFOLIO;
  const byId = Object.fromEntries(D.photos.map(p => [p.id, p]));
  const inAlbum = a => D.photos.filter(p => p.album === a);
  // story photos have their own file (p.src); archive-only photos live four to a file (p.pack) and are cut out on demand
  const src = (p, size = 'lg') => p.src || (p.pack ? '' : `assets/${p.id}-${size}.jpg`);
  const packImg = new Map(), cut = new Map();
  const loadPack = n => {
    if (!packImg.has(n)) packImg.set(n, new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = D.packs[n]; }));
    return packImg.get(n);
  };
  async function url(p) {
    if (!p.pack) return src(p);
    if (cut.has(p.id)) return cut.get(p.id);
    const [n, x, y, w, h] = p.pack, im = await loadPack(n);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(im, x, y, w, h, 0, 0, w, h);
    const u = URL.createObjectURL(await new Promise(r => c.toBlob(r, 'image/jpeg', .92)));
    cut.set(p.id, u);
    if (cut.size > 16) { const [k, v] = cut.entries().next().value; URL.revokeObjectURL(v); cut.delete(k); }
    if (packImg.size > 6) packImg.delete(packImg.keys().next().value);   // let decoded sheets go
    return u;
  }
  // thumbnail cut from a contact sheet: the whole photo at its own shape, or a centred square ({square: true})
  const pc = v => +(v * 100).toFixed(3) + '%';
  function thumbHTML(p, { square = false } = {}) {
    if (!p.thumb || !D.sheets) return `<img src="${src(p, 'sm')}" alt="" loading="lazy">`;
    // trim a pixel off each edge so rounding never shows a sliver of the neighbouring photo on the sheet
    const [n, x0, y0, w0, h0] = p.thumb, sh = D.sheets[n], x = x0 + 1, y = y0 + 1, w = w0 - 2, h = h0 - 2;
    const m = square ? Math.min(w, h) : 0, bw = square ? m : w, bh = square ? m : h;
    const ox = square ? x + (w - m) / 2 : x, oy = square ? y + (h - m) / 2 : y;
    return `<span class="nj-thumb" style="aspect-ratio:${bw} / ${bh}"><img src="${sh.src}" alt="" loading="lazy" decoding="async" style="width:${pc(sh.w / bw)};left:${pc(-ox / bw)};top:${pc(-oy / bh)}"></span>`;
  }
  const isPortrait = p => p.h > p.w;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthYear = p => { const t = p.exif.taken; return t ? `${MONTHS[+t.slice(5, 7) - 1]} ${t.slice(0, 4)}` : ''; };

  function readout(p) {
    const e = p.exif, out = [];
    if (e.focal) out.push(['', `${Math.round(e.focal)} mm`]);
    if (e.aperture) out.push(['ƒ/', `${+e.aperture.toFixed(1)}`]);
    if (e.shutter) out.push(['', `${e.shutter} s`]);
    if (e.iso) out.push(['ISO ', `${e.iso}`]);
    return out;
  }
  const readoutHTML = p => readout(p).map(([k, v]) => `<span>${k}<b>${v}</b></span>`).join('');
  const gear = p => [p.exif.camera, p.exif.lens].filter(Boolean).join(', ');

  function setAmbient(p, el = document.documentElement) {
    if (!p) return;
    const c = p.color;
    el.style.setProperty('--base', c.base); el.style.setProperty('--deep', c.deep);
    el.style.setProperty('--glow', c.glow); el.style.setProperty('--ink', c.ink);
  }

  /* ---------- Viewer ---------- */
  let V, list = [], idx = 0, fill = false, returnFocus = null, lastAmbient = null;
  function build() {
    V = document.createElement('div');
    V.className = 'nj-viewer'; V.setAttribute('role', 'dialog'); V.setAttribute('aria-modal', 'true'); V.setAttribute('aria-label', 'Photo viewer');
    V.innerHTML = `
      <div class="nj-spill"></div>
      <div class="nj-count"></div>
      <div class="nj-ctrl">
        <button class="nj-btn" data-act="fill" title="Fill the screen (F)">Fill</button>
        <button class="nj-btn" data-act="close" title="Close (Esc)" aria-label="Close">✕</button>
      </div>
      <button class="nj-btn nj-nav nj-prev" data-act="prev" aria-label="Previous photo">‹</button>
      <button class="nj-btn nj-nav nj-next" data-act="next" aria-label="Next photo">›</button>
      <div class="nj-stage"><div class="nj-frame"><img class="nj-img nj-drift" alt=""></div></div>
      <div class="nj-bar">
        <div class="nj-cap"><h2></h2><p></p></div>
        <div class="nj-readout"></div>
      </div>`;
    document.body.appendChild(V);
    V.addEventListener('click', e => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'close') close(); else if (a === 'next') step(1); else if (a === 'prev') step(-1);
      else if (a === 'fill') { fill = !fill; V.classList.toggle('is-fill', fill); e.target.textContent = fill ? 'Fit' : 'Fill'; }
    });
    addEventListener('keydown', e => {
      if (!V.classList.contains('is-open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key.toLowerCase() === 'f') V.querySelector('[data-act=fill]').click();
    });
    // parallax: photo leans toward the cursor, light spill leans away
    const img = V.querySelector('.nj-img'), spill = V.querySelector('.nj-spill');
    if (!reduced) V.addEventListener('pointermove', e => {
      const x = e.clientX / innerWidth - .5, y = e.clientY / innerHeight - .5;
      img.style.translate = `${x * -14}px ${y * -10}px`;
      spill.style.translate = `${x * 30}px ${y * 22}px`;
    });
    // touch: swipe sideways to change photo, swipe down to close
    let sx = null, sy = null;
    V.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    V.addEventListener('touchend', e => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = sy = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
      else if (dy > 90 && dy > Math.abs(dx)) close();
    });
    // tap the photo to hide or show captions and buttons
    V.querySelector('.nj-stage').addEventListener('click', () => V.classList.toggle('is-clean'));
  }
  let ticket = 0;
  function render() {
    const p = list[idx], a = D.albums[p.album], t = ++ticket;
    const img = V.querySelector('.nj-img');
    img.alt = [p.caption || a.title, a.place].filter(Boolean).join(', ');
    const spill = u => { V.querySelector('.nj-spill').style.backgroundImage = `url(${u})`; };
    if (p.pack) { img.removeAttribute('src'); url(p).then(u => { if (t === ticket) { img.src = u; spill(u); } }); }
    else { img.src = src(p); spill(src(p, 'sm')); }
    V.querySelector('.nj-cap h2').textContent = p.caption || a.title;
    V.querySelector('.nj-cap p').textContent = [p.caption ? a.title : '', a.place, monthYear(p)].filter(Boolean).join(', ');
    V.querySelector('.nj-readout').innerHTML = readoutHTML(p) + `<span class="nj-gear">${gear(p)}</span>`;
    V.querySelector('.nj-count').textContent = `${idx + 1} of ${list.length}`;
    setAmbient(p);
    [1, -1].forEach(d => { const n = list[(idx + d + list.length) % list.length]; if (n) n.pack ? url(n) : (new Image().src = src(n)); });
  }
  function step(d) { idx = (idx + d + list.length) % list.length; render(); }
  function open(photos, start = 0, fromEl = null) {
    if (!V) build();
    list = photos; idx = start; returnFocus = document.activeElement;
    lastAmbient = ['--base', '--deep', '--glow', '--ink'].map(k => document.documentElement.style.getPropertyValue(k));
    render();
    V.classList.add('is-open'); document.documentElement.style.overflow = 'hidden';
    V.querySelector('[data-act=close]').focus({ preventScroll: true });
    // FLIP: grow from the thumbnail that was clicked
    const img = V.querySelector('.nj-img');
    if (fromEl && !reduced) {
      const go = () => {
        const a = fromEl.getBoundingClientRect(), b = img.getBoundingClientRect();
        // only grow from the thumbnail when it is actually on screen
        if (!b.width || !a.width || a.bottom < 0 || a.top > innerHeight || a.right < 0 || a.left > innerWidth) return;
        img.animate([
          { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width}, ${a.height / b.height})`, transformOrigin: '0 0', opacity: .9 },
          { transform: 'none', transformOrigin: '0 0', opacity: 1 }
        ], { duration: 650, easing: 'cubic-bezier(.16,1,.3,1)' });
      };
      img.complete ? go() : img.addEventListener('load', go, { once: true });
    }
  }
  function close() {
    V.classList.remove('is-open'); document.documentElement.style.overflow = '';
    if (lastAmbient) ['--base', '--deep', '--glow', '--ink'].forEach((k, i) => lastAmbient[i] && document.documentElement.style.setProperty(k, lastAmbient[i]));
    returnFocus?.focus?.({ preventScroll: true });
    window.dispatchEvent(new CustomEvent('nj:viewer-closed'));
  }

  window.NJ = { D, byId, inAlbum, src, url, thumbHTML, isPortrait, monthYear, readout, readoutHTML, gear, setAmbient, reduced, viewer: { open, close } };
})();
