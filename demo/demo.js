/* Live demo: a moving fleet, clustered incrementally, in the browser. */
(function () {
  const cv = document.getElementById('nc-canvas');
  if (!cv) return;
  const ctx = cv.getContext('2d', { alpha: false });
  const el = (id) => document.getElementById(id);

  const METRO = [[-46.633, -23.550, 1.0], [-46.83, -23.68, 0.34], [-46.47, -23.47, 0.30],
                 [-46.55, -23.72, 0.26], [-46.73, -23.43, 0.22], [-46.39, -23.66, 0.18],
                 [-46.90, -23.50, 0.14], [-46.60, -23.30, 0.16], [-46.25, -23.55, 0.12]];
  let seed = 987654321;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());

  let index = null, lng = null, lat = null, head = null, speed = null, n = 0, cursor = 0;
  const MAXZOOM = 16, RADIUS = 44;

  function spawn(i) {
    const tot = METRO.reduce((a, m) => a + m[2], 0);
    let r = rnd() * tot, k = 0;
    while (k < METRO.length - 1 && (r -= METRO[k][2]) > 0) k++;
    const w = METRO[k][2];
    lng[i] = METRO[k][0] + gauss() * (0.012 + 0.05 * Math.sqrt(w));
    lat[i] = METRO[k][1] + gauss() * (0.010 + 0.04 * Math.sqrt(w));
    head[i] = rnd() * 6.283;
    speed[i] = 6 + rnd() * 26;                     // metres per report
  }

  function build(count) {
    n = count;
    lng = new Float64Array(n); lat = new Float64Array(n);
    head = new Float64Array(n); speed = new Float64Array(n);
    index = new NetCluster({ radius: RADIUS, maxZoom: MAXZOOM, hysteresis: 0.25 });
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { spawn(i); index.insert(i, lng[i], lat[i]); }
    stat('nc-build', (performance.now() - t0).toFixed(0) + ' ms');
    cursor = 0;
  }

  // ---- viewport ----
  const view = { lng: -46.633, lat: -23.550, z: 11 };
  const worldPx = () => 512 * Math.pow(2, view.z);
  function projN(lo, la) {
    const x = (lo + 180) / 360;
    const s = Math.sin(la * Math.PI / 180);
    return [x, 0.5 - 0.25 * Math.log((1 + s) / (1 - s)) / Math.PI];
  }
  function unprojN(x, y) {
    return [x * 360 - 180, 360 * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) / Math.PI - 90];
  }
  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function bbox() {
    const [cx, cy] = projN(view.lng, view.lat);
    const w = worldPx();
    const a = unprojN(cx - W / 2 / w, cy - H / 2 / w);
    const b = unprojN(cx + W / 2 / w, cy + H / 2 / w);
    return [a[0], b[1], b[0], a[1]];
  }

  // ---- motion ----
  const M_DEG = 111320;
  function moveOne(i) {
    head[i] += (rnd() - 0.5) * 0.5;
    if (rnd() < 0.012) head[i] = rnd() * 6.283;
    const c = Math.max(0.2, Math.cos(lat[i] * Math.PI / 180));
    lng[i] += Math.cos(head[i]) * speed[i] / (M_DEG * c);
    lat[i] += Math.sin(head[i]) * speed[i] / M_DEG;
    if (Math.abs(lng[i] + 46.63) > 0.9 || Math.abs(lat[i] + 23.55) > 0.7) head[i] += Math.PI;
    index.moveTo(i, lng[i], lat[i]);
  }

  // ---- drawing ----
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function draw(clusters) {
    const [cx, cy] = projN(view.lng, view.lat);
    const w = worldPx();
    ctx.fillStyle = css('--demo-bg'); ctx.fillRect(0, 0, W, H);
    // faint tile seams, to make the zoom scale legible
    ctx.strokeStyle = css('--demo-grid'); ctx.lineWidth = 1;
    const tile = 512 * Math.pow(2, view.z - Math.max(0, Math.round(view.z) - 3)) / Math.pow(2, view.z) * Math.pow(2, view.z);
    const tpx = w / Math.pow(2, Math.max(0, Math.round(view.z) - 3));
    const ox = ((cx * w - W / 2) % tpx + tpx) % tpx, oy = ((cy * w - H / 2) % tpx + tpx) % tpx;
    ctx.beginPath();
    for (let x = -ox; x < W; x += tpx) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H); }
    for (let y = -oy; y < H; y += tpx) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5); }
    ctx.stroke();

    const dot = css('--demo-dot'), fill = css('--demo-cluster'), edge = css('--demo-edge'), label = css('--demo-label');
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let big = 0;
    for (const c of clusters) {
      const [px, py] = projN(c.geometry.coordinates[0], c.geometry.coordinates[1]);
      const sx = (px - cx) * w + W / 2, sy = (py - cy) * w + H / 2;
      if (sx < -40 || sx > W + 40 || sy < -40 || sy > H + 40) continue;
      const k = c.properties.point_count || 1;
      if (k === 1) {
        ctx.fillStyle = dot;
        ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
        continue;
      }
      big++;
      const r = 7 + 9 * Math.log10(k);
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, 6.2832);
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = edge; ctx.lineWidth = 1.25; ctx.stroke();
      if (r > 11) {
        ctx.fillStyle = label;
        ctx.font = '600 ' + Math.min(13, Math.round(r * 0.82)) + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(c.properties.point_count_abbreviated, sx, sy + 0.5);
      }
    }
    return big;
  }

  // fixed-grid clustering of the same devices, brute force, for visual contrast
  function gridClusters(bb) {
    const z = Math.round(view.z);
    const cell = RADIUS / (512 * Math.pow(2, z));
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      if (lng[i] < bb[0] || lng[i] > bb[2] || lat[i] < bb[1] || lat[i] > bb[3]) continue;
      const [x, y] = projN(lng[i], lat[i]);
      const k = Math.floor(x / cell) + ':' + Math.floor(y / cell);
      let b = buckets.get(k); if (!b) buckets.set(k, b = [0, 0, 0]);
      b[0]++; b[1] += x; b[2] += y;
    }
    const out = [];
    for (const b of buckets.values()) {
      out.push({ geometry: { coordinates: unprojN(b[1] / b[0], b[2] / b[0]) },
                 properties: { point_count: b[0] > 1 ? b[0] : undefined,
                               point_count_abbreviated: b[0] >= 1000 ? Math.round(b[0] / 100) / 10 + 'k' : String(b[0]) } });
    }
    return out;
  }

  // ---- loop ----
  let running = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let acc = 0, accMoves = 0, accFrames = 0, lastReport = performance.now();
  function stat(id, v) { const e = el(id); if (e) e.textContent = v; }

  function frame() {
    const budget = Math.min(n, +el('nc-rate').value);
    const t0 = performance.now();
    if (running) for (let k = 0; k < budget; k++) { moveOne(cursor); cursor = (cursor + 1) % n; }
    const t1 = performance.now();
    const bb = bbox();
    const z = Math.round(view.z);
    const useGrid = el('nc-mode').value === 'grid';
    const cl = useGrid ? gridClusters(bb) : index.getClusters(bb, z);
    const t2 = performance.now();
    const shown = draw(cl);
    const t3 = performance.now();

    acc += t1 - t0; accMoves += running ? budget : 0; accFrames++;
    if (t3 - lastReport > 400) {
      stat('nc-moves', accMoves ? Math.round(accMoves / ((t3 - lastReport) / 1000)).toLocaleString('pt-BR') : '0');
      stat('nc-us', accMoves ? (acc * 1000 / accMoves).toFixed(2) : '-');
      stat('nc-query', ((t2 - t1)).toFixed(2));
      stat('nc-frame', ((t3 - lastReport) / accFrames).toFixed(1));
      acc = 0; accMoves = 0; accFrames = 0; lastReport = t3;
    }
    stat('nc-drawn', cl.length.toLocaleString('pt-BR'));
    stat('nc-markers', shown.toLocaleString('pt-BR'));
    requestAnimationFrame(frame);
  }

  // ---- controls ----
  el('nc-zoom').addEventListener('input', (e) => { view.z = +e.target.value; stat('nc-zoomv', 'z ' + Math.round(view.z)); });
  el('nc-count').addEventListener('change', (e) => { build(+e.target.value); });
  el('nc-play').addEventListener('click', (e) => {
    running = !running;
    e.target.textContent = running ? 'Pausar' : 'Retomar';
    e.target.setAttribute('aria-pressed', String(!running));
  });
  let drag = null;
  cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, lng: view.lng, lat: view.lat }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const w = worldPx();
    const [cx0, cy0] = projN(drag.lng, drag.lat);
    const p = unprojN(cx0 - (e.clientX - drag.x) / w, cy0 - (e.clientY - drag.y) / w);
    view.lng = p[0]; view.lat = Math.max(-84, Math.min(84, p[1]));
  });
  cv.addEventListener('pointerup', () => { drag = null; });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.z = Math.max(6, Math.min(MAXZOOM, view.z - Math.sign(e.deltaY) * 0.5));
    el('nc-zoom').value = view.z; stat('nc-zoomv', 'z ' + Math.round(view.z));
  }, { passive: false });
  window.addEventListener('resize', resize);

  resize();
  build(+el('nc-count').value);
  stat('nc-zoomv', 'z ' + Math.round(view.z));
  el('nc-play').textContent = running ? 'Pausar' : 'Retomar';
  requestAnimationFrame(frame);
})();
