const $ = (s) => document.querySelector(s);

const state = {
  running: false,
  freeze: false,
  cinema: false,
  hold: false,
  holdDecay: true,
  logF: true,
  aWeight: false,
  theme: "phosphor",
  fftSize: 8192,
  avg: 2,
  spanMin: 20,
  spanMax: 20000,
  dbMin: -140,
  dbMax: 0,
  paletteOpen: false,
  palIndex: 0,
  palFilter: "",
  markers: [],
  harmonics: false,
  ghost: false,
  ghostBuf: [],
  lastPeaks: [],
};

let audio, analyser, src, genNode, freq, freqSmooth, holdArr, canvas, ctx, wf, wfCtx, wfImg;
let sampleRate = 48000;

const themes = {
  phosphor: { line: "#3dff8a", fill: "#3dff8a22", map: iron },
  magma: { line: "#7ecbff", fill: "#7ecbff22", map: magma },
  iron: { line: "#ffb020", fill: "#ffb02022", map: iron },
  ice: { line: "#b8f3ff", fill: "#b8f3ff22", map: ice },
};

function iron(t) {
  t = Math.max(0, Math.min(1, t));
  const r = Math.min(255, t * 400);
  const g = Math.max(0, (t - 0.35) * 360);
  const b = Math.max(0, (t - 0.7) * 400);
  return [r, g * 0.45, b * 0.15];
}
function magma(t) {
  t = Math.max(0, Math.min(1, t));
  return [20 + t * 220, t * t * 80, 40 + t * 160];
}
function ice(t) {
  t = Math.max(0, Math.min(1, t));
  return [t * 40, 40 + t * 160, 80 + t * 175];
}

function aWeightDb(f) {
  const f2 = f * f;
  const ra =
    (12194 ** 2 * f2 * f2) /
    ((f2 + 20.6 ** 2) *
      Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) *
      (f2 + 12194 ** 2));
  return 20 * Math.log10(ra) + 2.0;
}

function hzToX(hz, w) {
  const min = state.spanMin, max = state.spanMax;
  if (state.logF) {
    const t = (Math.log(Math.max(hz, min)) - Math.log(min)) / (Math.log(max) - Math.log(min));
    return t * w;
  }
  return ((hz - min) / (max - min)) * w;
}
function xToHz(x, w) {
  const min = state.spanMin, max = state.spanMax;
  const t = x / w;
  if (state.logF) return Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min)));
  return min + t * (max - min);
}

function binToHz(i) {
  return (i * sampleRate) / analyser.fftSize;
}

function interpPeak(mags, i) {
  const a = mags[i - 1] || mags[i];
  const b = mags[i];
  const c = mags[i + 1] || mags[i];
  const den = a - 2 * b + c;
  const d = den !== 0 ? (0.5 * (a - c)) / den : 0;
  const bin = i + d;
  const mag = b - 0.25 * (a - c) * d;
  return { bin, mag };
}

function freqToNote(hz) {
  if (hz < 16) return "—";
  const n = 69 + 12 * Math.log2(hz / 440);
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const nearest = Math.round(n);
  const cents = Math.round((n - nearest) * 100);
  const name = names[((nearest % 12) + 12) % 12];
  const oct = Math.floor(nearest / 12) - 1;
  const sign = cents >= 0 ? `+${cents}` : `${cents}`;
  return `${name}${oct} ${sign}¢`;
}

const COMMANDS = [
  { id: "hunt", name: "Hunt Peak", key: "P", run: huntPeak },
  { id: "top6", name: "Hunt Top 6", key: "6", run: huntTop6 },
  { id: "harm", name: "Harmonic Ladder", key: "L", run: () => (state.harmonics = !state.harmonics) },
  { id: "ghost", name: "Ghost Last 8s", key: "G", run: () => (state.ghost = !state.ghost) },
  { id: "freeze", name: "Freeze Phosphor", key: "Space", run: () => (state.freeze = !state.freeze) },
  { id: "hold", name: "Max Hold Forever", key: "H", run: toggleHold },
  { id: "clear", name: "Clear Holds", key: "C", run: clearHolds },
  { id: "cinema", name: "Cinema", key: "F", run: toggleCinema },
  { id: "log", name: "Log F", key: "O", run: () => (state.logF = !state.logF) },
  { id: "aweight", name: "A-Weight", key: "A", run: () => (state.aWeight = !state.aWeight) },
  { id: "themeP", name: "Theme Phosphor", key: "", run: () => (state.theme = "phosphor") },
  { id: "themeM", name: "Theme Magma", key: "", run: () => (state.theme = "magma") },
  { id: "themeI", name: "Theme Iron", key: "", run: () => (state.theme = "iron") },
  { id: "sine", name: "Generator Sine 1k", key: "", run: () => startGen("sine", 1000) },
  { id: "pink", name: "Generator Pink", key: "", run: () => startGen("pink") },
  { id: "stopg", name: "Generator Off", key: "", run: stopGen },
];

function toggleHold() {
  state.hold = !state.hold;
  if (state.hold && freq) holdArr = new Float32Array(freq.length).fill(-200);
}
function clearHolds() {
  if (holdArr) holdArr.fill(-200);
  state.markers = [];
  state.lastPeaks = [];
}
function toggleCinema() {
  state.cinema = !state.cinema;
  document.body.classList.toggle("cinema", state.cinema);
}

function huntPeak() {
  if (!freqSmooth) return;
  let best = 1, bestV = -1e9;
  for (let i = 2; i < freqSmooth.length - 2; i++) {
    const hz = binToHz(i);
    if (hz < state.spanMin || hz > state.spanMax) continue;
    if (freqSmooth[i] > bestV) {
      bestV = freqSmooth[i];
      best = i;
    }
  }
  const p = interpPeak(freqSmooth, best);
  const hz = (p.bin * sampleRate) / analyser.fftSize;
  state.markers = [{ hz, db: p.mag }];
  updateHud(hz, p.mag);
}

function huntTop6() {
  if (!freqSmooth) return;
  const cand = [];
  for (let i = 3; i < freqSmooth.length - 3; i++) {
    const hz = binToHz(i);
    if (hz < state.spanMin || hz > state.spanMax) continue;
    if (freqSmooth[i] > freqSmooth[i - 1] && freqSmooth[i] > freqSmooth[i + 1]) {
      cand.push({ i, v: freqSmooth[i] });
    }
  }
  cand.sort((a, b) => b.v - a.v);
  const out = [];
  for (const c of cand) {
    const hz = binToHz(c.i);
    if (out.some((o) => Math.abs(Math.log2(o.hz / hz)) < 0.04)) continue;
    const p = interpPeak(freqSmooth, c.i);
    out.push({ hz: (p.bin * sampleRate) / analyser.fftSize, db: p.mag });
    if (out.length >= 6) break;
  }
  state.markers = out;
  if (out[0]) updateHud(out[0].hz, out[0].db);
}

function updateHud(hz, db) {
  $("#hud .db").textContent = `${db.toFixed(1)} dB`;
  $("#hud .sub").textContent = `${hz.toFixed(1)} Hz  ·  ${freqToNote(hz)}`;
}

async function startAudio() {
  audio = new AudioContext({ sampleRate: 48000 });
  sampleRate = audio.sampleRate;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  src = audio.createMediaStreamSource(stream);
  analyser = audio.createAnalyser();
  analyser.fftSize = state.fftSize;
  analyser.smoothingTimeConstant = 0;
  src.connect(analyser);
  freq = new Float32Array(analyser.frequencyBinCount);
  freqSmooth = new Float32Array(analyser.frequencyBinCount);
  holdArr = new Float32Array(analyser.frequencyBinCount).fill(-200);
  $("#gate").style.display = "none";
  state.running = true;
  loop();
}

function startGen(kind, f0 = 1000) {
  if (!audio) return;
  stopGen();
  if (kind === "sine") {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = f0;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(audio.destination);
    g.connect(analyser);
    o.start();
    genNode = { stop() { o.stop(); } };
  } else {
    const buf = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    const n = audio.createBufferSource();
    n.buffer = buf;
    n.loop = true;
    const g = audio.createGain();
    g.gain.value = 0.15;
    n.connect(g);
    g.connect(audio.destination);
    g.connect(analyser);
    n.start();
    genNode = n;
  }
}
function stopGen() {
  try { genNode && genNode.stop(); } catch {}
  genNode = null;
}

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  for (const c of [canvas, wf]) {
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, r.width * dpr);
    c.height = Math.max(1, r.height * dpr);
  }
  splitCanvases();
}

function splitCanvases() {
  const h = canvas.height;
  canvas.dataset.specH = Math.floor(h * 0.42);
}

function loop() {
  requestAnimationFrame(loop);
  if (!analyser) return;
  if (!state.freeze) {
    analyser.getFloatFrequencyData(freq);
    const a = 1 / Math.max(1, state.avg);
    for (let i = 0; i < freq.length; i++) {
      let v = freq[i];
      if (state.aWeight) v += aWeightDb(binToHz(i));
      freqSmooth[i] = freqSmooth[i] * (1 - a) + v * a;
      if (state.hold) {
        if (freqSmooth[i] > holdArr[i]) holdArr[i] = freqSmooth[i];
        else if (state.holdDecay) holdArr[i] -= 0.015;
      }
    }
    if (state.ghost) {
      state.ghostBuf.push(Float32Array.from(freqSmooth));
      if (state.ghostBuf.length > 90) state.ghostBuf.shift();
    }
  }
  draw();
  $("#meta").textContent =
    `FFT ${analyser.fftSize}   ${state.logF ? "Log-F" : "Lin-F"}   ${state.aWeight ? "A-w" : "Z"}   ${state.theme}   ${sampleRate} Hz`;
}

function draw() {
  const theme = themes[state.theme];
  const w = canvas.width, h = canvas.height;
  const specH = Math.floor(h * 0.42);
  const wfH = h - specH;
  ctx.fillStyle = "#050608";
  ctx.fillRect(0, 0, w, h);

  drawGrid(ctx, w, specH);
  if (state.ghost && state.ghostBuf.length) {
    ctx.globalAlpha = 0.15;
    drawTrace(ctx, state.ghostBuf[0], w, specH, "#889");
    ctx.globalAlpha = 1;
  }
  if (state.hold) drawTrace(ctx, holdArr, w, specH, "#ffffff55", true);
  drawTrace(ctx, freqSmooth, w, specH, theme.line);
  drawMarkers(ctx, w, specH);
  drawWaterfall(w, specH, wfH, theme);
}

function drawGrid(g, w, h) {
  g.strokeStyle = "#1a2030";
  g.lineWidth = 1;
  g.font = `${Math.max(10, canvas.width / 140)}px sans-serif`;
  g.fillStyle = "#6d7688";
  const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  for (const hz of ticks) {
    if (hz < state.spanMin || hz > state.spanMax) continue;
    const x = hzToX(hz, w);
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
    const label = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
    g.fillText(label, x + 4, h - 6);
  }
  for (let db = 0; db >= -140; db -= 20) {
    const y = ((state.dbMax - db) / (state.dbMax - state.dbMin)) * h;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
    g.fillText(`${db}`, 6, y - 3);
  }
}

function drawTrace(g, arr, w, h, color, dashed) {
  if (!arr) return;
  g.beginPath();
  g.strokeStyle = color;
  g.lineWidth = Math.max(1.5, w / 900);
  if (dashed) g.setLineDash([6, 6]);
  let started = false;
  const step = Math.max(1, Math.floor(arr.length / (w * 2)));
  for (let i = 1; i < arr.length; i += step) {
    const hz = binToHz(i);
    if (hz < state.spanMin || hz > state.spanMax) continue;
    const x = hzToX(hz, w);
    const db = arr[i];
    const y = ((state.dbMax - db) / (state.dbMax - state.dbMin)) * h;
    if (!started) {
      g.moveTo(x, y);
      started = true;
    } else g.lineTo(x, y);
  }
  g.stroke();
  g.setLineDash([]);
}

function drawMarkers(g, w, h) {
  g.font = `${Math.max(12, w / 90)}px sans-serif`;
  for (const m of state.markers) {
    const x = hzToX(m.hz, w);
    const y = ((state.dbMax - m.db) / (state.dbMax - state.dbMin)) * h;
    g.fillStyle = "#ffb020";
    g.beginPath();
    g.arc(x, y, 4, 0, Math.PI * 2);
    g.fill();
    g.fillText(`${m.hz.toFixed(1)} Hz  ${m.db.toFixed(1)} dB  ${freqToNote(m.hz)}`, x + 8, Math.max(16, y - 8));
    if (state.harmonics) {
      g.strokeStyle = "#ffb02066";
      for (let k = 2; k <= 8; k++) {
        const hx = hzToX(m.hz * k, w);
        if (hx > w) break;
        g.beginPath();
        g.moveTo(hx, 0);
        g.lineTo(hx, h);
        g.stroke();
        g.fillStyle = "#ffb02088";
        g.fillText(`${k}×`, hx + 3, 14);
      }
    }
  }
}

let wfRow = 0;
function drawWaterfall(w, specH, wfH, theme) {
  if (!freqSmooth) return;
  if (!wfImg || wfImg.width !== w || wfImg.height !== wfH) {
    wfImg = ctx.createImageData(w, wfH);
  }
  // scroll down: move rows
  wfImg.data.copyWithin(w * 4, 0);
  const row = wfImg.data;
  const map = theme.map;
  for (let x = 0; x < w; x++) {
    const hz = xToHz(x, w);
    const bin = (hz / sampleRate) * analyser.fftSize;
    const i = Math.min(freqSmooth.length - 2, Math.max(1, bin));
    const f = i - Math.floor(i);
    const db = freqSmooth[Math.floor(i)] * (1 - f) + freqSmooth[Math.ceil(i)] * f;
    const t = (db - state.dbMin) / (state.dbMax - state.dbMin);
    const [r, g, b] = map(t);
    const o = x * 4;
    row[o] = r;
    row[o + 1] = g;
    row[o + 2] = b;
    row[o + 3] = 255;
  }
  ctx.putImageData(wfImg, 0, specH);
}

function filteredCmds() {
  const q = state.palFilter.toLowerCase();
  return COMMANDS.filter((c) => c.name.toLowerCase().includes(q));
}

function renderPalette() {
  const box = $("#palette");
  if (!state.paletteOpen) {
    box.classList.remove("open");
    return;
  }
  box.classList.add("open");
  const list = filteredCmds();
  state.palIndex = Math.max(0, Math.min(state.palIndex, list.length - 1));
  $("#pal-list").innerHTML = list
    .map(
      (c, i) =>
        `<div class="item ${i === state.palIndex ? "sel" : ""}" data-i="${i}">${c.name}${
          c.key ? `<kbd>${c.key}</kbd>` : ""
        }</div>`
    )
    .join("");
  $("#pal-list").querySelectorAll(".item").forEach((el) => {
    el.onclick = () => {
      list[+el.dataset.i].run();
      closePalette();
    };
  });
  $("#pal-input").focus();
}

function openPalette() {
  state.paletteOpen = true;
  state.palFilter = "";
  state.palIndex = 0;
  $("#pal-input").value = "";
  renderPalette();
}
function closePalette() {
  state.paletteOpen = false;
  renderPalette();
}

function bind() {
  canvas = $("#spec");
  ctx = canvas.getContext("2d");
  addEventListener("resize", resize);
  resize();
  $("#start").onclick = () => startAudio().catch((e) => alert(e.message));
  $("#open-pal").onclick = () => openPalette();
  document.querySelectorAll("[data-cmd]").forEach((b) => {
    b.onclick = () => {
      const c = COMMANDS.find((x) => x.id === b.dataset.cmd);
      if (c) c.run();
      syncButtons();
    };
  });
  $("#pal-input").addEventListener("input", (e) => {
    state.palFilter = e.target.value;
    state.palIndex = 0;
    renderPalette();
  });
  addEventListener("keydown", (e) => {
    if (state.paletteOpen) {
      if (e.key === "Escape") closePalette();
      if (e.key === "ArrowDown") {
        state.palIndex++;
        renderPalette();
        e.preventDefault();
      }
      if (e.key === "ArrowUp") {
        state.palIndex--;
        renderPalette();
        e.preventDefault();
      }
      if (e.key === "Enter") {
        const list = filteredCmds();
        if (list[state.palIndex]) list[state.palIndex].run();
        closePalette();
        e.preventDefault();
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      openPalette();
      e.preventDefault();
    }
    if (e.key === "/") {
      openPalette();
      e.preventDefault();
    }
    if (e.code === "Space") {
      state.freeze = !state.freeze;
      e.preventDefault();
    }
    if (e.key.toLowerCase() === "h") toggleHold();
    if (e.key.toLowerCase() === "c") clearHolds();
    if (e.key.toLowerCase() === "p") huntPeak();
    if (e.key === "6") huntTop6();
    if (e.key.toLowerCase() === "f") toggleCinema();
    if (e.key.toLowerCase() === "g") state.ghost = !state.ghost;
    if (e.key.toLowerCase() === "l") state.harmonics = !state.harmonics;
    if (e.key.toLowerCase() === "o") state.logF = !state.logF;
    if (e.key.toLowerCase() === "a") state.aWeight = !state.aWeight;
    syncButtons();
  });
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * canvas.width;
    const hz = xToHz(x, canvas.width);
    if (!freqSmooth) return;
    const bin = Math.round((hz / sampleRate) * analyser.fftSize);
    const p = interpPeak(freqSmooth, Math.max(1, Math.min(freqSmooth.length - 2, bin)));
    const phz = (p.bin * sampleRate) / analyser.fftSize;
    state.markers = [{ hz: phz, db: p.mag }];
    updateHud(phz, p.mag);
  });
  let lastY = null;
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.shiftKey) {
        const span = state.dbMax - state.dbMin;
        state.dbMin += e.deltaY > 0 ? -4 : 4;
        state.dbMax = state.dbMin + span;
      } else {
        const c = Math.sqrt(state.spanMin * state.spanMax);
        const f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
        state.spanMin = Math.max(10, c / (c / state.spanMin) * f);
        // zoom around center
        const ratio = state.spanMax / state.spanMin;
        state.spanMin = Math.max(10, c / Math.sqrt(ratio * (e.deltaY > 0 ? 1.25 : 0.8)));
        state.spanMax = Math.min(sampleRate / 2, state.spanMin * (e.deltaY > 0 ? ratio * 1.15 : ratio / 1.15));
        if (state.spanMin >= state.spanMax - 10) {
          state.spanMin = 20;
          state.spanMax = 20000;
        }
      }
    },
    { passive: false }
  );
}

function syncButtons() {
  document.querySelectorAll("[data-cmd]").forEach((b) => {
    const on =
      (b.dataset.cmd === "hold" && state.hold) ||
      (b.dataset.cmd === "freeze" && state.freeze) ||
      (b.dataset.cmd === "cinema" && state.cinema) ||
      (b.dataset.cmd === "ghost" && state.ghost) ||
      (b.dataset.cmd === "harm" && state.harmonics);
    b.classList.toggle("active", !!on);
  });
}

addEventListener("DOMContentLoaded", bind);
