"use strict";

/* ============================================================================
   Quantum Yield — Live Dashboard JS (FULL REVISED, UTC-ANCHOR)
   What changed vs your prior version:
   ✅ ALL 4 charts use the SAME unified ms timeline (union of price + hft + idt)
   ✅ Time labels are taken DIRECTLY from datasource epoch -> rendered in UTC (no Pacific conversion)
   ✅ The “latest timestamp” is ALWAYS the right edge when AUTO_FOLLOW is true
   ✅ Delta cursors (LAST.*_ms) are anchored to the LAST ROW timestamp (not a computed max key guess)
   ✅ No-overlap polling preserved
   ============================================================================ */

/* ---------------- DOM helpers ---------------- */
const $ = (id) => document.getElementById(id);

function logLine(tag, msg) {
  const t = new Date().toLocaleTimeString();
  const line = `[${t}] ${tag}: ${msg}`;
  console.log(line);

  const box = $("statusBox");
  if (box) {
    logLine._pollN = (logLine._pollN || 0) + 1;
    const noisy = tag === "POLL" && logLine._pollN % 10 !== 0;
    if (!noisy) {
      if (!box.textContent || box.textContent.trim() === "STATUS —") box.textContent = "STATUS —";
      box.textContent += `\n${line}`;
      box.scrollTop = box.scrollHeight;
    }
  }
}

/* ---------------- Formatting ---------------- */
function fmtNum(x, d = 2) {
  const v = Number(x);
  return Number.isFinite(v) ? v.toFixed(d) : "—";
}
function fmtInt(x) {
  const v = Number(x);
  return Number.isFinite(v) ? String(Math.round(v)) : "—";
}

/* ---------------- URL / fetch ---------------- */
function baseURL() {
  const input = $("liveBase")?.value?.trim();
  if (!input) {
    const isLocal =
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1" ||
      location.hostname.endsWith(".local");
    return isLocal ? "http://localhost:5050" : "https://api.quantumyield.ai";
  }
  let v = input.replace(/\/+$/, "");
  if (location.protocol === "https:" && v.startsWith("http://")) {
    v = "https://" + v.slice("http://".length);
  }
  return v;
}

async function fetchJSON(path, params = {}) {
  const url = new URL(baseURL() + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), { cache: "no-store" });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const ct = res.headers.get("content-type") || "";
    const bodyHint =
      ct.includes("application/json")
        ? txt.slice(0, 500)
        : ct.includes("text/html")
        ? "(HTML error page from upstream / Cloudflare — check tunnel + ingress + hostname)"
        : txt.slice(0, 300);

    const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    err.status = res.status;
    err.body = txt;
    err.bodyHint = bodyHint;
    throw err;
  }

  return res.json();
}

/* ---------------- Time helpers (UTC ONLY) ---------------- */
/**
 * Normalize epoch to milliseconds; auto-detect by magnitude:
 * seconds, milliseconds, microseconds, nanoseconds.
 */
function epochMsFromAny(v) {
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0) return NaN;
  if (x > 1e17) return Math.round(x / 1e6); // ns -> ms
  if (x > 1e14) return Math.round(x / 1e3); // us -> ms
  if (x > 1e11) return Math.round(x);       // ms -> ms
  return Math.round(x * 1000);              // s -> ms
}

/** UTC time label HH:MM:SS from ms */
function timeLabelFromMs(ms) {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(11, 19); // UTC
}

/** UTC date-time label YYYY-MM-DD HH:MM:SS from ms */
function dateTimeLabelFromMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/** Default date input as UTC YYYYMMDD (no local tz) */
function ymdUTC(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}
const TODAY_YMD = () => ymdUTC();

/* ---------------- Inputs ---------------- */
function getSymbol() {
  return ($("liveSymbol")?.value || "ES").toUpperCase();
}
function getLiveDate() {
  const v = ($("liveDate")?.value || "").trim().replace(/[^\d]/g, "").slice(0, 8);
  return v || TODAY_YMD();
}

/* Tooltip semantics for imbalance */
const IMBALANCE_HINT = [
  "+1 = all bid size (strong bid dominance)",
  " 0 = balanced",
  "-1 = all ask size (strong ask dominance)",
];

/* ---------------- Behavior toggles ---------------- */
const USE_DELTA = true;
const MAX_ROWS_PER_STREAM = 3000;

/* ---------------- State ---------------- */
const STORE = {
  hft: { rows: [], horizons: [], unit: "", byMs: new Map() },
  idt: { rows: [], horizons: [], unit: "", byMs: new Map() },
  price: { rows: [], byMs: new Map() },
};

// Frontend-controlled "since_ms" markers — ONLY send what you already received.
const LAST = { hft_ms: 0, idt_ms: 0, price_ms: 0 };

const IDX = { value: 0 };
let liveTimer = null;
let playbackTimer = null;
let POLL_MS = 1000;
let pullInFlight = false;

/* Auto-follow newest tick while live until user interacts */
let AUTO_FOLLOW = true;

/* ---------------- Horizon selection state ---------------- */
const HSEL = { hftSelected: [], idtSelected: [] };

function uniqSorted(arr) {
  return Array.from(new Set((arr || []).map(Number).filter(Number.isFinite))).sort((a, b) => a - b);
}

function clampSelectedToAvailable(profile) {
  const avail = uniqSorted(STORE[profile]?.horizons || []);
  if (!avail.length) {
    if (profile === "hft") HSEL.hftSelected = [];
    if (profile === "idt") HSEL.idtSelected = [];
    return;
  }
  const keep = (sel) => uniqSorted(sel).filter((h) => avail.includes(h));
  if (profile === "hft") HSEL.hftSelected = keep(HSEL.hftSelected);
  if (profile === "idt") HSEL.idtSelected = keep(HSEL.idtSelected);
}

function labelForH(profile, h) {
  if (profile === "hft") return `${h}ms`;
  return `${Math.round(h / 1000)}s`;
}

/* ---------------- Defaults ---------------- */
const DEFAULT_HFT_MS = 250;
const DEFAULT_IDT_MS = [3600, 1800, 1200].map((s) => s * 1000);
const DEFAULT_VIEW_SPAN = 240; // how many points to show initially (right-anchored)

function closestAvail(avail, target) {
  if (!avail || !avail.length) return null;
  let best = avail[0], bestD = Math.abs(avail[0] - target);
  for (let i = 1; i < avail.length; i++) {
    const d = Math.abs(avail[i] - target);
    if (d < bestD) (best = avail[i]), (bestD = d);
  }
  return best;
}

function ensureDefaultPredSelection() {
  HSEL.hftSelected = uniqSorted(HSEL.hftSelected);
  HSEL.idtSelected = uniqSorted(HSEL.idtSelected);

  const hftAvail = uniqSorted(STORE.hft.horizons);
  const idtAvail = uniqSorted(STORE.idt.horizons);

  if (!HSEL.hftSelected.length && hftAvail.length) {
    const h = closestAvail(hftAvail, DEFAULT_HFT_MS);
    HSEL.hftSelected = h == null ? [] : [h];
  }

  if (!HSEL.idtSelected.length && idtAvail.length) {
    const picked = [];
    for (const t of DEFAULT_IDT_MS) {
      const h = closestAvail(idtAvail, t);
      if (h != null) picked.push(h);
    }
    const out = [];
    const seen = new Set();
    for (const h of picked) if (!seen.has(h)) (seen.add(h), out.push(h));
    HSEL.idtSelected = out;
  }

  clampSelectedToAvailable("hft");
  clampSelectedToAvailable("idt");
}

function updatePredHintText() {
  const el = $("predHint");
  if (!el) return;

  const hft = uniqSorted(HSEL.hftSelected);
  const idt = uniqSorted(HSEL.idtSelected);

  const a = hft.length ? `HFT: ${hft.map((h) => labelForH("hft", h)).join(", ")}` : "HFT: auto";
  const b = idt.length ? `IDT: ${idt.map((h) => labelForH("idt", h)).join(", ")}` : "IDT: auto";
  el.textContent = `${a} · ${b}`;
}

/* ---------------- Modal helpers ---------------- */
function openPredModal() {
  const m = $("predModal");
  if (!m) return logLine("ERR", "predModal not found");
  ensureDefaultPredSelection();
  buildPredModalLists();
  updatePredHintText();
  m.classList.add("open");
  m.setAttribute("aria-hidden", "false");
}

function closePredModal() {
  const m = $("predModal");
  if (!m) return;
  m.classList.remove("open");
  m.setAttribute("aria-hidden", "true");
}

function buildPredModalLists() {
  const boxH = $("predListHFT");
  const boxI = $("predListIDT");
  if (!boxH || !boxI) return;

  clampSelectedToAvailable("hft");
  clampSelectedToAvailable("idt");

  const hAvail = uniqSorted(STORE.hft.horizons);
  const iAvail = uniqSorted(STORE.idt.horizons);

  boxH.innerHTML = "";
  boxI.innerHTML = "";

  const mk = (profile, h) => {
    const wrap = document.createElement("label");
    wrap.className = "chkRow";
    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.dataset.profile = profile;
    inp.dataset.h = String(h);
    const sel = profile === "hft" ? HSEL.hftSelected : HSEL.idtSelected;
    inp.checked = sel.includes(h);

    const span = document.createElement("span");
    span.className = "chkTxt";
    span.textContent = labelForH(profile, h);

    wrap.appendChild(inp);
    wrap.appendChild(span);
    return wrap;
  };

  if (!hAvail.length) {
    const p = document.createElement("div");
    p.className = "muted";
    p.textContent = "No HFT horizons yet (wait for /pred/latest or /pred/delta).";
    boxH.appendChild(p);
  } else for (const h of hAvail) boxH.appendChild(mk("hft", h));

  if (!iAvail.length) {
    const p = document.createElement("div");
    p.className = "muted";
    p.textContent = "No IDT horizons yet (wait for /pred/latest or /pred/delta).";
    boxI.appendChild(p);
  } else for (const h of iAvail) boxI.appendChild(mk("idt", h));

  $("predCountHFT") && ($("predCountHFT").textContent = String(hAvail.length));
  $("predCountIDT") && ($("predCountIDT").textContent = String(iAvail.length));
}

function readModalSelections() {
  const boxH = $("predListHFT");
  const boxI = $("predListIDT");
  if (!boxH || !boxI) return;

  const grab = (box) => {
    const inputs = Array.from(box.querySelectorAll("input[type=checkbox]"));
    return uniqSorted(inputs.filter((i) => i.checked).map((i) => Number(i.dataset.h)));
  };

  HSEL.hftSelected = grab(boxH);
  HSEL.idtSelected = grab(boxI);

  clampSelectedToAvailable("hft");
  clampSelectedToAvailable("idt");
  updatePredHintText();
}

/* ---------------- Views ---------------- */
function makeView() {
  return { i0: 0, i1: 0, dragging: false, dragStartX: 0, dragStartI0: 0, dragStartI1: 0, hoverIdx: -1 };
}
const VIEWS = { price: makeView(), pred: makeView(), micro: makeView(), depth: makeView() };

/* ---------------- Prediction key normalization ---------------- */
function ensureBpsKeys(rows, horizons, unit) {
  const u = String(unit || "").toLowerCase();
  const hasDec = rows.length ? Object.keys(rows[0]).some((k) => /^pred_dec_\d+$/i.test(k)) : false;

  if (u === "dec" || hasDec) {
    for (const r of rows) {
      for (const h of horizons) {
        const vDec = Number(r[`pred_dec_${h}`]);
        if (Number.isFinite(vDec)) r[`pred_bps_${h}`] = vDec * 10000.0;
      }
    }
    return "bps";
  }
  return u || "";
}

/* ---------------- Helpers: "truth" last-ms per stream ---------------- */
function lastMsFromRows(rows) {
  if (!rows || !rows.length) return 0;
  const r = rows[rows.length - 1];
  const ms = epochMsFromAny(r?.epoch_ns ?? r?.epoch_us ?? r?.epoch_ms ?? r?.epoch_s ?? r?.epoch);
  return Number.isFinite(ms) ? ms : 0;
}

function currentKnownLastMs(profile) {
  if (profile === "price") return lastMsFromRows(STORE.price.rows);
  return lastMsFromRows(STORE[profile]?.rows || []);
}

function clampSince(profile, since) {
  const known = currentKnownLastMs(profile);
  const orig = since;

  if (!Number.isFinite(since) || since < 0) since = 0;
  if (known > 0 && since > known) since = known;

  if (orig !== since) {
    logLine("DBG", `clampSince(${profile}): orig=${orig} known=${known} -> ${since}`);
  }
  return since;
}

/* ---------------- Ingest helpers ---------------- */
function rebuildByMs(profile) {
  const rows = STORE[profile]?.rows || [];
  const m = new Map();
  for (const r of rows) {
    const ms = epochMsFromAny(r?.epoch_ns ?? r?.epoch_us ?? r?.epoch_ms ?? r?.epoch_s ?? r?.epoch);
    if (Number.isFinite(ms) && ms > 0) m.set(ms, r);
  }
  STORE[profile].byMs = m;
}

function rebuildPriceByMs() {
  const rows = STORE.price?.rows || [];
  const m = new Map();
  for (const r of rows) {
    const ms = epochMsFromAny(r?.epoch_ns ?? r?.epoch_us ?? r?.epoch_ms ?? r?.epoch_s ?? r?.epoch);
    if (Number.isFinite(ms) && ms > 0) m.set(ms, r);
  }
  STORE.price.byMs = m;
}

function inferHorizonsFromRows(rows) {
  const set = new Set();
  for (let i = 0; i < Math.min(30, rows.length); i++) {
    for (const k of Object.keys(rows[i] || {})) {
      const m =
        k.match(/^pred_(?:bps|dec)_(\d+)$/i) ||
        k.match(/^pred_bps_(\d+)$/i) ||
        k.match(/^pred_dec_(\d+)$/i);
      if (m) set.add(+m[1]);
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

/* Full replace (used for /pred/latest) */
function ingestPred(profile, payload, symbol) {
  const rows = Array.isArray(payload?.rows) ? payload.rows.slice() : [];
  if (!rows.length) {
    STORE[profile] = { rows: [], horizons: [], unit: "", byMs: new Map() };
    logLine("SNAP", `ingestPred(${profile}): empty`);
    return;
  }

  let horizons = Array.isArray(payload.horizons) ? payload.horizons.slice() : [];
  if (!horizons.length) horizons = inferHorizonsFromRows(rows);

  const unit = ensureBpsKeys(rows, horizons, payload.unit);
  STORE[profile].rows = rows;
  STORE[profile].horizons = horizons;
  STORE[profile].unit = unit;

  rebuildByMs(profile);

  // IMPORTANT: cursor follows LAST ROW timestamp
  const lastMs = lastMsFromRows(rows);
  if (lastMs > 0) LAST[`${profile}_ms`] = lastMs;

  $("pillSym") && ($("pillSym").textContent = symbol || "—");
  $("pillRows") &&
    ($("pillRows").textContent = String(Math.max(STORE.hft.rows.length, STORE.idt.rows.length, STORE.price.rows.length)));
  $("pillL12") && ($("pillL12").textContent = "L1");

  clampSelectedToAvailable(profile);
  ensureDefaultPredSelection();
  updatePredHintText();

  logLine(
    "SNAP",
    `pred(${profile}): rows=${rows.length}, horizons=[${horizons.join(", ")}], unit=${unit || "?"} (LAST.${profile}_ms=${LAST[`${profile}_ms`]})`
  );
}

/* Delta merge (used for /pred/delta) */
function ingestPredDelta(profile, payload, symbol) {
  const newRows = Array.isArray(payload?.rows) ? payload.rows : [];
  const payloadMax = Number(payload?.max_epoch_ms);
  const hasPayloadMax = Number.isFinite(payloadMax) && payloadMax > 0;

  if (!newRows.length) {
    if (hasPayloadMax) LAST[`${profile}_ms`] = Math.max(LAST[`${profile}_ms`], payloadMax);
    return 0;
  }

  let horizons = Array.isArray(payload.horizons) ? payload.horizons.slice() : [];
  if (!horizons.length) horizons = inferHorizonsFromRows(newRows);

  const mergedHorizons = uniqSorted([...(STORE[profile].horizons || []), ...(horizons || [])]);
  const unit = ensureBpsKeys(newRows, mergedHorizons, payload.unit || STORE[profile].unit);

  let added = 0;
  let localMax = 0;

  for (const r of newRows) {
    const ms = epochMsFromAny(r?.epoch_ns ?? r?.epoch_us ?? r?.epoch_ms ?? r?.epoch_s ?? r?.epoch);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    STORE[profile].byMs.set(ms, r);
    localMax = Math.max(localMax, ms);
    added++;
  }

  if (added) {
    const keys = Array.from(STORE[profile].byMs.keys()).sort((a, b) => a - b);
    const keep = keys.slice(-MAX_ROWS_PER_STREAM);

    const m2 = new Map();
    const rows2 = [];
    for (const k of keep) {
      const rr = STORE[profile].byMs.get(k);
      if (rr) {
        if (rr.epoch == null) rr.epoch = k;
        rows2.push(rr);
        m2.set(k, rr);
      }
    }
    STORE[profile].rows = rows2;
    STORE[profile].byMs = m2;
    STORE[profile].horizons = mergedHorizons;
    STORE[profile].unit = unit || STORE[profile].unit;

    const lastMs = lastMsFromRows(rows2);
    const newCursor = hasPayloadMax ? payloadMax : Math.max(localMax, lastMs);
    if (newCursor > 0) LAST[`${profile}_ms`] = Math.max(LAST[`${profile}_ms`], newCursor);

    $("pillSym") && ($("pillSym").textContent = symbol || "—");
    $("pillRows") &&
      ($("pillRows").textContent = String(Math.max(STORE.hft.rows.length, STORE.idt.rows.length, STORE.price.rows.length)));
    $("pillL12") && ($("pillL12").textContent = "L1");

    clampSelectedToAvailable(profile);
    ensureDefaultPredSelection();
    updatePredHintText();
  } else {
    if (hasPayloadMax) LAST[`${profile}_ms`] = Math.max(LAST[`${profile}_ms`], payloadMax);
  }

  return added;
}

/* Snapshot full replace (used for /snapshot) */
function ingestSnapshot(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  STORE.price.rows = rows;
  rebuildPriceByMs();

  // IMPORTANT: cursor follows LAST ROW timestamp
  const lastMs = lastMsFromRows(rows);
  if (lastMs > 0) LAST.price_ms = lastMs;

  logLine("SNAP", `snapshot: rows=${rows.length} (LAST.price_ms=${LAST.price_ms})`);
}

/* Snapshot delta merge (used for /snapshot/delta) */
function ingestSnapshotDelta(payload) {
  const newRows = Array.isArray(payload?.rows) ? payload.rows : [];
  const payloadMax = Number(payload?.max_epoch_ms);
  const hasPayloadMax = Number.isFinite(payloadMax) && payloadMax > 0;

  if (!newRows.length) {
    if (hasPayloadMax) LAST.price_ms = Math.max(LAST.price_ms, payloadMax);
    return 0;
  }

  let added = 0;
  let localMax = 0;

  for (const r of newRows) {
    const ms = epochMsFromAny(r?.epoch_ns ?? r?.epoch_us ?? r?.epoch_ms ?? r?.epoch_s ?? r?.epoch);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    STORE.price.byMs.set(ms, r);
    localMax = Math.max(localMax, ms);
    added++;
  }

  if (added) {
    const keys = Array.from(STORE.price.byMs.keys()).sort((a, b) => a - b);
    const keep = keys.slice(-MAX_ROWS_PER_STREAM);

    const m2 = new Map();
    const rows2 = [];
    for (const k of keep) {
      const rr = STORE.price.byMs.get(k);
      if (rr) {
        if (rr.epoch == null) rr.epoch = k;
        rows2.push(rr);
        m2.set(k, rr);
      }
    }
    STORE.price.rows = rows2;
    STORE.price.byMs = m2;

    const lastMs = lastMsFromRows(rows2);
    const newCursor = hasPayloadMax ? payloadMax : Math.max(localMax, lastMs);
    if (newCursor > 0) LAST.price_ms = Math.max(LAST.price_ms, newCursor);
  } else {
    if (hasPayloadMax) LAST.price_ms = Math.max(LAST.price_ms, payloadMax);
  }

  return added;
}

/* ---------------- API calls ---------------- */
async function fetchPredLatest(symbol, profile, n = 2000) {
  const data = await fetchJSON("/pred/latest", { symbol, profile, n });
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const horizons = Array.isArray(data.horizons) && data.horizons.length ? data.horizons : inferHorizonsFromRows(rows);
  return { rows, horizons, unit: data.unit || "" };
}

async function fetchSnapshot(symbol, seconds = 120) {
  const s = Math.max(1, Math.min(120, Number(seconds) || 120));
  return fetchJSON("/snapshot", { symbol, seconds: s, profile: "hft" });
}

async function fetchPredDelta(symbol, profile, since_ms) {
  return fetchJSON("/pred/delta", { symbol, profile, since_ms: Math.max(0, Number(since_ms) || 0) });
}
async function fetchSnapshotDelta(symbol, since_ms) {
  return fetchJSON("/snapshot/delta", { symbol, since_ms: Math.max(0, Number(since_ms) || 0) });
}

/* ---------------- Unified timeline (single source of truth for x-axis) ---------------- */
function buildTimelineIndex() {
  const msSet = new Set();
  for (const ms of STORE.price.byMs.keys()) msSet.add(ms);
  for (const ms of STORE.hft.byMs.keys()) msSet.add(ms);
  for (const ms of STORE.idt.byMs.keys()) msSet.add(ms);
  const msArr = Array.from(msSet).sort((a, b) => a - b);
  return { N: msArr.length, msArr };
}

function rowAt(profile, ms) {
  if (profile === "price") return STORE.price.byMs.get(ms) || null;
  return STORE[profile]?.byMs?.get(ms) || null;
}

/* ---------------- L1 helpers ---------------- */
function getBidAsk(row) {
  const b = Number(row?.bid_px1 ?? row?.bid_px_00 ?? row?.best_bid ?? row?.bid);
  const a = Number(row?.ask_px1 ?? row?.ask_px_00 ?? row?.best_ask ?? row?.ask);
  return { b, a };
}

function midFromRow(row) {
  const m = Number(row?.mid ?? row?.mid_px ?? row?.mid_price);
  if (Number.isFinite(m)) return m;
  const { b, a } = getBidAsk(row);
  if (Number.isFinite(b) && Number.isFinite(a)) return 0.5 * (b + a);
  return NaN;
}

function microFromRow(row) {
  const mp = Number(row?.microprice);
  if (Number.isFinite(mp)) return mp;
  const { b, a } = getBidAsk(row);
  const bs = Number(row?.bid_sz1);
  const as = Number(row?.ask_sz1);
  if (Number.isFinite(b) && Number.isFinite(a) && Number.isFinite(bs) && Number.isFinite(as) && bs + as > 0) {
    return (b * as + a * bs) / (bs + as);
  }
  return NaN;
}

/* ---------------- Slider + playback ---------------- */
function setupSlider() {
  const s = $("timeSlider");
  if (!s) return;

  const { N } = buildTimelineIndex();
  const mx = Math.max(0, N - 1);
  s.max = String(mx);
  s.disabled = mx === 0;

  if (IDX.value > mx) IDX.value = mx;
  s.value = String(IDX.value);

  updateTimeLabel();
}

function updateTimeLabel() {
  const el = $("timeLabel");
  if (!el) return;

  const { N, msArr } = buildTimelineIndex();
  const idx = Math.max(0, Math.min(IDX.value, Math.max(0, N - 1)));
  const ms = msArr[idx];
  const ts = Number.isFinite(ms) ? dateTimeLabelFromMs(ms) : "—";
  el.textContent = `t = ${N ? idx + 1 : 0} / ${N}  ·  ${ts} UTC`;
}

function stopPlayback() {
  if (playbackTimer) clearInterval(playbackTimer);
  playbackTimer = null;
  if ($("playBtn")) $("playBtn").textContent = "Play";
  logLine("PLAY", "stop");
}

function startPlayback() {
  stopPlayback();
  AUTO_FOLLOW = false;
  const speed = Number($("speedSel")?.value || "1") || 1;
  if ($("playBtn")) $("playBtn").textContent = "Pause";

  playbackTimer = setInterval(() => {
    const { N } = buildTimelineIndex();
    if (!N) return;
    IDX.value = Math.min(N - 1, IDX.value + Math.max(1, speed));
    $("timeSlider") && ($("timeSlider").value = String(IDX.value));
    renderAll(false);
    if (IDX.value >= N - 1) stopPlayback();
  }, 200);

  logLine("PLAY", `start speed=${speed}x`);
}

function togglePlayback() {
  playbackTimer ? stopPlayback() : startPlayback();
}

/* ---------------- View helpers ---------------- */
function snapViewToRight(view, N, span = DEFAULT_VIEW_SPAN) {
  if (!N) return;
  const i1 = N - 1;
  const i0 = Math.max(0, i1 - Math.max(20, span));
  view.i0 = i0;
  view.i1 = i1;
}

function ensureViewsInitialized(forceRight = false) {
  const { N } = buildTimelineIndex();
  if (!N) return;

  const init = (view) => {
    const uninit = view.i1 <= view.i0 || view.i1 <= 0;
    if (uninit || forceRight) {
      snapViewToRight(view, N, DEFAULT_VIEW_SPAN);
    } else {
      view.i0 = Math.max(0, Math.min(view.i0, N - 2));
      view.i1 = Math.max(view.i0 + 1, Math.min(view.i1, N - 1));
    }
  };

  init(VIEWS.price);
  init(VIEWS.pred);
  init(VIEWS.micro);
  init(VIEWS.depth);
}

function clampView(view, n, spanMin = 20) {
  const maxI = Math.max(0, n - 1);
  view.i0 = Math.max(0, Math.min(view.i0, Math.max(0, maxI - spanMin)));
  view.i1 = Math.max(Math.min(view.i1, maxI), view.i0 + Math.min(spanMin, maxI - view.i0));
  if (view.i1 > maxI) view.i1 = maxI;
  if (view.i0 < 0) view.i0 = 0;
  if (view.i1 <= view.i0) {
    view.i0 = 0;
    view.i1 = maxI;
  }
}

/* ---------------- Drawing utils ---------------- */
function fitCanvas(canvas) {
  const W = canvas.clientWidth || 300;
  const H = canvas.clientHeight || 150;
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  return { W, H };
}

function drawGrid(ctx, W, H, pad, nx = 6, ny = 5) {
  ctx.save();
  ctx.strokeStyle = "rgba(173,186,204,0.12)";
  ctx.lineWidth = 1;
  for (let k = 0; k <= nx; k++) {
    const x = pad.l + (k / nx) * (W - pad.l - pad.r);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, H - pad.b);
    ctx.stroke();
  }
  for (let k = 0; k <= ny; k++) {
    const y = pad.t + (k / ny) * (H - pad.t - pad.b);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawAxes(ctx, W, H, pad) {
  const AX = "rgba(173,186,204,0.65)";
  ctx.save();
  ctx.strokeStyle = AX;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, H - pad.b);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(pad.l, H - pad.b);
  ctx.lineTo(W - pad.r, H - pad.b);
  ctx.stroke();
  ctx.restore();
}

function drawTicksY(ctx, pad, W, H, minV, maxV, fmtFn) {
  const y0 = pad.t, y1 = H - pad.b;
  const AX = "rgba(173,186,204,0.65)";
  const LAB = "rgba(159,182,212,0.9)";
  ctx.save();
  ctx.strokeStyle = AX;
  ctx.fillStyle = LAB;
  ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let t = 0; t <= 5; t++) {
    const frac = t / 5;
    const y = y1 - frac * (y1 - y0);
    const v = minV + frac * (maxV - minV);
    ctx.beginPath();
    ctx.moveTo(pad.l - 4, y);
    ctx.lineTo(pad.l, y);
    ctx.stroke();
    ctx.fillText(fmtFn ? fmtFn(v) : fmtNum(v, 2), 6, y);
  }
  ctx.restore();
}

function drawTicksXTime(ctx, pad, W, H, msArr, i0, i1) {
  const LAB = "rgba(159,182,212,0.9)";
  ctx.save();
  ctx.fillStyle = LAB;
  ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const step = Math.max(1, Math.floor((i1 - i0) / 6));
  const x0 = pad.l, x1 = W - pad.r;
  const y = H - pad.b + 4;
  for (let i = i0; i <= i1; i += step) {
    const x = x0 + ((i - i0) / Math.max(1, i1 - i0)) * (x1 - x0);
    const ms = msArr[i];
    const lab = Number.isFinite(ms) ? timeLabelFromMs(ms) : "";
    ctx.fillText(lab, x, y);
  }
  ctx.restore();
}

function drawLegend(ctx, items, x, y) {
  ctx.save();
  ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  let yy = y;
  for (const it of items) {
    ctx.strokeStyle = it.strokeStyle;
    ctx.lineWidth = 2;
    ctx.setLineDash(it.dash || []);
    ctx.beginPath();
    ctx.moveTo(x, yy + 6);
    ctx.lineTo(x + 18, yy + 6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(159,182,212,0.95)";
    ctx.fillText(it.label, x + 24, yy);
    yy += 16;
  }
  ctx.restore();
}

function drawLine(ctx, xs, ys, strokeStyle, dash = null, width = 1.5) {
  ctx.save();
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = width;
  ctx.setLineDash(dash || []);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  let started = false;
  ctx.beginPath();
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      started = false;
      continue;
    }
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawHover(ctx, pad, W, H, xs, hoverK, lines, extraText = []) {
  if (!xs || hoverK < 0 || hoverK >= xs.length) return;

  const x = xs[hoverK];
  const y0 = pad.t, y1 = H - pad.b;

  ctx.save();
  ctx.strokeStyle = "rgba(173,186,204,0.55)";
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, y1);
  ctx.stroke();

  const boxPad = 8;
  const lineH = 14;

  const widest = Math.max(
    ...lines.map((l) => (l.label.length + l.valueStr.length + 3) * 7),
    ...(extraText || []).map((t) => t.length * 7),
    140
  );
  const textW = Math.min(460, widest);

  let bx = x + 10;
  if (bx + textW + boxPad * 2 > W - 6) bx = x - (textW + boxPad * 2 + 10);
  bx = Math.max(6, bx);
  const by = pad.t + 8;
  const boxH = boxPad * 2 + lineH * (lines.length + (extraText?.length || 0));

  ctx.fillStyle = "rgba(10,14,20,0.82)";
  ctx.strokeStyle = "rgba(173,186,204,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, textW + boxPad * 2, boxH, 8);
  else ctx.rect(bx, by, textW + boxPad * 2, boxH);
  ctx.fill();
  ctx.stroke();

  ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";

  let yy = by + boxPad;
  for (const L of lines) {
    ctx.strokeStyle = L.colorStroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx + boxPad, yy + 7);
    ctx.lineTo(bx + boxPad + 16, yy + 7);
    ctx.stroke();

    ctx.fillStyle = "rgba(214,222,235,0.95)";
    ctx.fillText(`${L.label}: ${L.valueStr}`, bx + boxPad + 22, yy);
    yy += lineH;
  }

  if (extraText && extraText.length) {
    ctx.fillStyle = "rgba(159,182,212,0.8)";
    for (const t of extraText) {
      ctx.fillText(t, bx + boxPad, yy);
      yy += lineH;
    }
  }

  ctx.restore();
}

/* ===================== Q1: Price ===================== */
function renderPrice(view) {
  const c = $("qPrice");
  if (!c) return;
  const ctx = c.getContext("2d");
  const { W, H } = fitCanvas(c);
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 56, r: 12, t: 12, b: 28 };
  const { N, msArr } = buildTimelineIndex();

  if (!N) {
    ctx.fillStyle = "rgba(159,182,212,0.8)";
    ctx.font = "12px ui-monospace, Menlo, Consolas, monospace";
    ctx.fillText("No data", pad.l, pad.t + 14);
    return;
  }

  clampView(view, N, 20);
  const i0 = Math.max(0, Math.min(view.i0, N - 1));
  const i1 = Math.max(0, Math.min(view.i1, N - 1));

  drawGrid(ctx, W, H, pad);
  drawAxes(ctx, W, H, pad);

  const span = Math.max(1, i1 - i0);
  const mids = new Array(span + 1);
  const micros = new Array(span + 1);

  let lastMid = NaN, lastMp = NaN;

  for (let k = 0; k <= span; k++) {
    const ms = msArr[i0 + k];
    const rP = rowAt("price", ms);
    const m = midFromRow(rP);
    const mp = microFromRow(rP);

    if (Number.isFinite(m)) lastMid = m;
    if (Number.isFinite(mp)) lastMp = mp;

    mids[k] = Number.isFinite(m) ? m : lastMid;
    micros[k] = Number.isFinite(mp) ? mp : lastMp;
  }

  let min = +Infinity, max = -Infinity;
  for (const v of mids) if (Number.isFinite(v)) (min = Math.min(min, v), (max = Math.max(max, v)));
  const hasMicro = micros.some(Number.isFinite);
  if (hasMicro) for (const v of micros) if (Number.isFinite(v)) (min = Math.min(min, v), (max = Math.max(max, v)));

  if (!Number.isFinite(min) || min === max) {
    min = 0; max = 1;
  }

  const x0 = pad.l, x1 = W - pad.r;
  const y0 = pad.t, y1 = H - pad.b;

  const xs = new Array(span + 1);
  const yMid = new Array(span + 1);
  const yMp = new Array(span + 1);

  for (let k = 0; k <= span; k++) {
    xs[k] = x0 + (k / span) * (x1 - x0);
    const vMid = mids[k];
    const vMp = micros[k];
    yMid[k] = Number.isFinite(vMid) ? y1 - ((vMid - min) / (max - min)) * (y1 - y0) : NaN;
    yMp[k] = hasMicro && Number.isFinite(vMp) ? y1 - ((vMp - min) / (max - min)) * (y1 - y0) : NaN;
  }

  drawTicksY(ctx, pad, W, H, min, max, (v) => (Math.abs(v) >= 1000 ? fmtInt(v) : fmtNum(v, 2)));
  drawTicksXTime(ctx, pad, W, H, msArr, i0, i1);

  const strokeMid = "rgba(159,197,255,0.95)";
  const strokeMp = "rgba(52,211,153,0.95)";
  drawLine(ctx, xs, yMid, strokeMid, null, 1.6);
  if (hasMicro) drawLine(ctx, xs, yMp, strokeMp, [6, 4], 1.4);

  const legend = [{ label: "mid (snapshot)", strokeStyle: strokeMid, dash: null }];
  if (hasMicro) legend.push({ label: "microprice (snapshot)", strokeStyle: strokeMp, dash: [6, 4] });
  drawLegend(ctx, legend, pad.l + 8, pad.t + 4);

  const hoverK = view.hoverIdx >= i0 && view.hoverIdx <= i1 ? view.hoverIdx - i0 : -1;
  if (hoverK >= 0) {
    drawHover(ctx, pad, W, H, xs, hoverK, [
      { label: "mid", valueStr: fmtNum(mids[hoverK], 2), colorStroke: strokeMid },
      { label: "micro", valueStr: hasMicro ? fmtNum(micros[hoverK], 2) : "—", colorStroke: strokeMp },
    ]);
  }
}

/* ===================== Q2: Predictions ===================== */
function renderPred(view) {
  const c = $("qPred");
  if (!c) return;
  const ctx = c.getContext("2d");
  const { W, H } = fitCanvas(c);
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 56, r: 12, t: 12, b: 28 };
  const { N, msArr } = buildTimelineIndex();
  if (!N) {
    ctx.fillStyle = "rgba(159,182,212,0.8)";
    ctx.font = "12px ui-monospace, Menlo, Consolas, monospace";
    ctx.fillText("No predictions", pad.l, pad.t + 14);
    return;
  }

  ensureDefaultPredSelection();

  clampView(view, N, 20);
  const i0 = Math.max(0, Math.min(view.i0, N - 1));
  const i1 = Math.max(0, Math.min(view.i1, N - 1));

  drawGrid(ctx, W, H, pad);
  drawAxes(ctx, W, H, pad);

  const showHFT = $("showHFT")?.checked ?? true;
  const showIDT = $("showIDT")?.checked ?? true;

  const hftSel = uniqSorted(HSEL.hftSelected);
  const idtSel = uniqSorted(HSEL.idtSelected);

  const HFT_COLS = [
    "rgba(245,158,11,0.95)",
    "rgba(239,68,68,0.95)",
    "rgba(168,85,247,0.95)",
    "rgba(34,197,94,0.95)",
    "rgba(251,191,36,0.95)",
  ];
  const IDT_COLS = [
    "rgba(125,211,252,0.95)",
    "rgba(59,130,246,0.95)",
    "rgba(16,185,129,0.95)",
    "rgba(99,102,241,0.95)",
    "rgba(14,165,233,0.95)",
  ];

  const selLines = [];

  if (showHFT) {
    let k = 0;
    for (const h of hftSel) {
      const col = HFT_COLS[k++ % HFT_COLS.length];
      selLines.push({
        label: `Buy/Sell bias (HFT ${h}ms)`,
        dash: null,
        stroke: col,
        getVal: (ms) => Number(rowAt("hft", ms)?.[`pred_bps_${h}`]),
      });
    }
  }

  if (showIDT) {
    let k = 0;
    for (const h of idtSel) {
      const col = IDT_COLS[k++ % IDT_COLS.length];
      selLines.push({
        label: `Buy/Sell bias (IDT ${Math.round(h / 1000)}s)`,
        dash: [6, 4],
        stroke: col,
        getVal: (ms) => Number(rowAt("idt", ms)?.[`pred_bps_${h}`]),
      });
    }
  }

  let min = +Infinity, max = -Infinity;
  for (const L of selLines) {
    for (let i = i0; i <= i1; i++) {
      const v = L.getVal(msArr[i]);
      if (!Number.isFinite(v)) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (!Number.isFinite(min) || min === max) {
    min = -1; max = 1;
  }

  drawTicksY(ctx, pad, W, H, min, max, (v) => fmtNum(v, 2));
  drawTicksXTime(ctx, pad, W, H, msArr, i0, i1);

  const x0 = pad.l, x1 = W - pad.r;
  const y0 = pad.t, y1 = H - pad.b;
  const span = Math.max(1, i1 - i0);

  const xs = new Array(span + 1);
  for (let k = 0; k <= span; k++) xs[k] = x0 + (k / span) * (x1 - x0);

  for (const L of selLines) {
    const ys = new Array(span + 1);
    for (let k = 0; k <= span; k++) {
      const ms = msArr[i0 + k];
      const v = L.getVal(ms);
      ys[k] = Number.isFinite(v) ? y1 - ((v - min) / (max - min)) * (y1 - y0) : NaN;
    }
    drawLine(ctx, xs, ys, L.stroke, L.dash, 1.6);
  }

  drawLegend(
    ctx,
    selLines.map((L) => ({ label: L.label, strokeStyle: L.stroke, dash: L.dash })),
    pad.l + 8,
    pad.t + 4
  );

  const hoverIdx = view.hoverIdx;
  const hoverK = hoverIdx >= i0 && hoverIdx <= i1 ? hoverIdx - i0 : -1;
  if (hoverK >= 0) {
    const ms = msArr[hoverIdx];
    const lines = selLines.map((L) => {
      const v = L.getVal(ms);
      return { label: L.label, valueStr: Number.isFinite(v) ? fmtNum(v, 2) : "—", colorStroke: L.stroke };
    });
    drawHover(ctx, pad, W, H, xs, hoverK, lines);
  }
}

/* ===================== Q3: Micro (micro-mid) ===================== */
function renderMicro(view) {
  const c = $("qMicro");
  if (!c) return;
  const ctx = c.getContext("2d");
  const { W, H } = fitCanvas(c);
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 56, r: 12, t: 12, b: 28 };
  const { N, msArr } = buildTimelineIndex();
  if (!N) return;

  clampView(view, N, 20);
  const i0 = Math.max(0, Math.min(view.i0, N - 1));
  const i1 = Math.max(0, Math.min(view.i1, N - 1));

  drawGrid(ctx, W, H, pad);
  drawAxes(ctx, W, H, pad);

  const span = Math.max(1, i1 - i0);
  const vals = new Array(span + 1);

  let last = NaN;
  for (let k = 0; k <= span; k++) {
    const ms = msArr[i0 + k];
    const rP = rowAt("price", ms);
    const m = midFromRow(rP);
    const mp = microFromRow(rP);
    const v = Number.isFinite(m) && Number.isFinite(mp) ? mp - m : NaN;
    if (Number.isFinite(v)) last = v;
    vals[k] = Number.isFinite(v) ? v : last;
  }

  let min = +Infinity, max = -Infinity;
  for (const v of vals) if (Number.isFinite(v)) (min = Math.min(min, v), (max = Math.max(max, v)));
  if (!Number.isFinite(min) || min === max) {
    min = -0.01; max = 0.01;
  }

  drawTicksY(ctx, pad, W, H, min, max, (v) => fmtNum(v, 6));
  drawTicksXTime(ctx, pad, W, H, msArr, i0, i1);

  const x0 = pad.l, x1 = W - pad.r;
  const y0 = pad.t, y1 = H - pad.b;

  const xs = new Array(span + 1);
  const ys = new Array(span + 1);
  for (let k = 0; k <= span; k++) {
    xs[k] = x0 + (k / span) * (x1 - x0);
    const v = vals[k];
    ys[k] = Number.isFinite(v) ? y1 - ((v - min) / (max - min)) * (y1 - y0) : NaN;
  }

  const col = "rgba(52,211,153,0.95)";
  drawLine(ctx, xs, ys, col, null, 1.6);

  const hoverIdx = view.hoverIdx;
  const hoverK = hoverIdx >= i0 && hoverIdx <= i1 ? hoverIdx - i0 : -1;
  if (hoverK >= 0) {
    drawHover(ctx, pad, W, H, xs, hoverK, [
      { label: "micro-mid", valueStr: Number.isFinite(vals[hoverK]) ? fmtNum(vals[hoverK], 6) : "—", colorStroke: col },
    ]);
  }
}

/* ===================== Q4: Snapshot + Microstructure ===================== */
/* --- bar helpers + depth chart (same logic, but time labels are UTC) --- */

function drawMiniBar(ctx, x, y, w, h, label, val, vmin, vmax, posCol, negCol, labelBelowGap = 6) {
  ctx.save();
  ctx.fillStyle = "rgba(173,186,204,0.18)";
  ctx.fillRect(x, y, w, h);

  if (Number.isFinite(val) && Number.isFinite(vmin) && Number.isFinite(vmax) && vmax > vmin) {
    const t = (val - vmin) / (vmax - vmin);
    const clamped = Math.max(0, Math.min(1, t));
    const fillW = Math.max(0, clamped * w);
    let col = posCol;
    if (vmin < 0 && vmax > 0) col = val >= 0 ? posCol : negCol;
    ctx.fillStyle = col;
    ctx.fillRect(x, y, fillW, h);
  }

  ctx.strokeStyle = "rgba(173,186,204,0.25)";
  ctx.strokeRect(x, y, w, h);

  ctx.fillStyle = "rgba(159,182,212,0.85)";
  ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(label, x, y + h + labelBelowGap);

  ctx.fillStyle = "rgba(214,222,235,0.9)";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(Number.isFinite(val) ? fmtNum(val, 6) : "—", x + w + 92, y + h / 2);
  ctx.restore();
}

function drawMiniBarSigned(ctx, x, y, w, h, label, val, vmin, vmax, posCol, negCol, labelBelowGap = 6) {
  ctx.save();
  ctx.fillStyle = "rgba(173,186,204,0.18)";
  ctx.fillRect(x, y, w, h);

  const crossesZero = Number.isFinite(vmin) && Number.isFinite(vmax) && vmin < 0 && vmax > 0;
  const xZero = crossesZero ? x + ((0 - vmin) / (vmax - vmin)) * w : x;

  if (crossesZero) {
    ctx.strokeStyle = "rgba(173,186,204,0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xZero, y - 2);
    ctx.lineTo(xZero, y + h + 2);
    ctx.stroke();
  }

  if (Number.isFinite(val) && Number.isFinite(vmin) && Number.isFinite(vmax) && vmax > vmin) {
    const clamped = Math.max(vmin, Math.min(vmax, val));

    if (crossesZero) {
      if (clamped >= 0) {
        const xVal = x + ((clamped - vmin) / (vmax - vmin)) * w;
        const ww = Math.max(0, xVal - xZero);
        ctx.fillStyle = posCol;
        ctx.fillRect(xZero, y, ww, h);
      } else {
        const xVal = x + ((clamped - vmin) / (vmax - vmin)) * w;
        const ww = Math.max(0, xZero - xVal);
        ctx.fillStyle = negCol;
        ctx.fillRect(xVal, y, ww, h);
      }
    } else {
      const t = (clamped - vmin) / (vmax - vmin);
      const fillW = Math.max(0, Math.min(1, t)) * w;
      ctx.fillStyle = clamped >= 0 ? posCol : negCol;
      ctx.fillRect(x, y, fillW, h);
    }
  }

  ctx.strokeStyle = "rgba(173,186,204,0.25)";
  ctx.strokeRect(x, y, w, h);

  ctx.fillStyle = "rgba(159,182,212,0.85)";
  ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(label, x, y + h + labelBelowGap);

  ctx.fillStyle = "rgba(214,222,235,0.9)";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(Number.isFinite(val) ? fmtNum(val, 6) : "—", x + w + 92, y + h / 2);

  ctx.restore();
}

function drawLeftAxisTicks(ctx, xAxis, y0, y1, minV, maxV, fmtFn, title) {
  ctx.save();
  ctx.strokeStyle = "rgba(173,186,204,0.65)";
  ctx.fillStyle = "rgba(159,182,212,0.9)";
  ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(title, xAxis - 46, y0 - 18);

  ctx.textBaseline = "middle";
  for (let t = 0; t <= 5; t++) {
    const frac = t / 5;
    const y = y1 - frac * (y1 - y0);
    const v = minV + frac * (maxV - minV);
    ctx.beginPath();
    ctx.moveTo(xAxis - 4, y);
    ctx.lineTo(xAxis, y);
    ctx.stroke();
    ctx.fillText(fmtFn(v), 6, y);
  }
  ctx.restore();
}

function drawRightAxisTicks(ctx, xAxis, y0, y1, minV, maxV, fmtFn, title) {
  ctx.save();
  ctx.strokeStyle = "rgba(173,186,204,0.65)";
  ctx.fillStyle = "rgba(159,182,212,0.9)";
  ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(title, xAxis + 46, y0 - 18);

  ctx.textBaseline = "middle";
  for (let t = 0; t <= 5; t++) {
    const frac = t / 5;
    const y = y1 - frac * (y1 - y0);
    const v = minV + frac * (maxV - minV);
    ctx.beginPath();
    ctx.moveTo(xAxis, y);
    ctx.lineTo(xAxis + 4, y);
    ctx.stroke();
    ctx.fillText(fmtFn(v), xAxis + 50, y);
  }
  ctx.restore();
}

function drawBottomTimeTicks(ctx, x0, x1, y, msArr, i0, i1) {
  ctx.save();
  ctx.fillStyle = "rgba(159,182,212,0.9)";
  ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const step = Math.max(1, Math.floor((i1 - i0) / 6));
  for (let i = i0; i <= i1; i += step) {
    const frac = (i - i0) / Math.max(1, i1 - i0);
    const x = x0 + frac * (x1 - x0);
    const ms = msArr[i];
    const lab = Number.isFinite(ms) ? timeLabelFromMs(ms) : "";
    ctx.fillText(lab, x, y);
  }
  ctx.restore();
}

function splitBySign(vals, mapToY, positive = true) {
  return (vals || []).map((v) => {
    if (!Number.isFinite(v)) return NaN;
    if (positive ? v >= 0 : v < 0) return mapToY(v);
    return NaN;
  });
}

function renderDepth(view) {
  const c = $("qDepth");
  if (!c) return;
  const ctx = c.getContext("2d");
  const { W, H } = fitCanvas(c);
  ctx.clearRect(0, 0, W, H);

  const { N, msArr } = buildTimelineIndex();
  if (!N) return;

  clampView(view, N, 20);
  const i0 = view.i0;
  const i1 = view.i1;

  const idx = Math.max(0, Math.min(IDX.value, N - 1));

  const num = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : NaN;
  };

  function getBidAskPxAny(r) {
    if (!r) return { b: NaN, a: NaN };
    const b = num(r.bid_px1 ?? r.bid_px ?? r.best_bid_px ?? r.bid ?? r.bb_px ?? r.bid_px_00);
    const a = num(r.ask_px1 ?? r.ask_px ?? r.best_ask_px ?? r.ask ?? r.ba_px ?? r.ask_px_00);
    return { b, a };
  }

  function getBidAskSzAny(r) {
    if (!r) return { bs: NaN, as: NaN };
    const bs = num(r.bid_sz1 ?? r.bid_sz ?? r.best_bid_sz ?? r.bid_size ?? r.bb_sz ?? r.bid_sz_00 ?? r.depth_bid);
    const as = num(r.ask_sz1 ?? r.ask_sz ?? r.best_ask_sz ?? r.ask_size ?? r.ba_sz ?? r.ask_sz_00 ?? r.depth_ask);
    return { bs, as };
  }

  function spreadFromRow(r) {
    const { b, a } = getBidAskPxAny(r);
    if (Number.isFinite(b) && Number.isFinite(a)) return a - b;
    const mid = midFromRow(r);
    const mp = microFromRow(r);
    if (Number.isFinite(mid) && Number.isFinite(mp)) return 2 * Math.abs(mp - mid);
    return NaN;
  }

  function imbalanceFromRow(r) {
    const { bs, as } = getBidAskSzAny(r);
    const d = bs + as || 0;
    if (d > 0) return (bs - as) / d;

    const mid = midFromRow(r);
    const mp = microFromRow(r);
    const sp = spreadFromRow(r);
    const eps = 1e-9;
    if (Number.isFinite(mid) && Number.isFinite(mp) && Number.isFinite(sp) && sp > eps) {
      const z = (mp - mid) / sp;
      return Math.max(-1, Math.min(1, z));
    }
    return NaN;
  }

  function findNearestRowWithAnySignal(centerIdx, maxLook = 800) {
    const r0 = rowAt("price", msArr[centerIdx]);
    if (Number.isFinite(spreadFromRow(r0)) || Number.isFinite(imbalanceFromRow(r0))) return r0;

    for (let d = 1; d <= maxLook; d++) {
      const j1 = centerIdx - d;
      const j2 = centerIdx + d;

      if (j1 >= 0) {
        const r1 = rowAt("price", msArr[j1]);
        if (Number.isFinite(spreadFromRow(r1)) || Number.isFinite(imbalanceFromRow(r1))) return r1;
      }
      if (j2 < N) {
        const r2 = rowAt("price", msArr[j2]);
        if (Number.isFinite(spreadFromRow(r2)) || Number.isFinite(imbalanceFromRow(r2))) return r2;
      }
    }
    return r0;
  }

  const r = findNearestRowWithAnySignal(idx, 800);

  const TEXT_TOP = 10;
  const TEXT_LINE = 16;
  const BAR_H = 8;
  const LABEL_GAP = 6;
  const BAR_GAP = 14;
  const GAP_BEFORE_CHART = 26;

  ctx.fillStyle = "rgba(214,222,235,0.95)";
  ctx.font = "12px ui-monospace, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";

  let y = TEXT_TOP;
  ctx.fillText("L1 Microstructure Snapshot", 12, y);
  y += TEXT_LINE;

  const msSnap = epochMsFromAny(r?.epoch_ns ?? r?.epoch_ms ?? r?.epoch_us ?? r?.epoch_s ?? r?.epoch) || msArr[idx];
  const tsSnap = Number.isFinite(msSnap) ? dateTimeLabelFromMs(msSnap) : "—";
  ctx.fillStyle = "rgba(159,182,212,0.8)";
  ctx.fillText(`${tsSnap} UTC`, 12, y);
  y += TEXT_LINE;

  const { b: bpx, a: apx } = getBidAskPxAny(r);
  const { bs: bsz, as: asz } = getBidAskSzAny(r);
  ctx.fillStyle = "rgba(214,222,235,0.95)";
  ctx.fillText(
    `bid1: ${Number.isFinite(bpx) ? fmtNum(bpx, 2) : "—"} x ${Number.isFinite(bsz) ? fmtInt(bsz) : "—"}   ` +
      `ask1: ${Number.isFinite(apx) ? fmtNum(apx, 2) : "—"} x ${Number.isFinite(asz) ? fmtInt(asz) : "—"}`,
    12,
    y
  );
  y += TEXT_LINE;

  const mid = midFromRow(r);
  const mp = microFromRow(r);
  ctx.fillText(
    `mid: ${Number.isFinite(mid) ? fmtNum(mid, 2) : "—"}   micro: ${Number.isFinite(mp) ? fmtNum(mp, 2) : "—"}`,
    12,
    y
  );
  y += TEXT_LINE + 10;

  const barX = 12;
  const barW = Math.min(420, W - 24);

  const imbSnap = imbalanceFromRow(r);
  const sprSnap = spreadFromRow(r);

  const ROW_H = BAR_H + LABEL_GAP + BAR_GAP;
  const BAR_Y0 = y;

  drawMiniBarSigned(ctx, barX, BAR_Y0, barW, BAR_H, "imbalance", imbSnap, -1, 1, "rgba(52,211,153,0.9)", "rgba(248,113,113,0.9)", LABEL_GAP);

  drawMiniBar(
    ctx,
    barX,
    BAR_Y0 + ROW_H,
    barW,
    BAR_H,
    "spread",
    sprSnap,
    0,
    Math.max(0.25, Number.isFinite(sprSnap) ? sprSnap * 2 : 0.5),
    "rgba(245,158,11,0.9)",
    "rgba(245,158,11,0.9)",
    LABEL_GAP
  );

  const chartTop = BAR_Y0 + ROW_H * 2 + GAP_BEFORE_CHART;
  const chartBottom = H - 28;

  const pad = { l: 56, r: 56, t: chartTop, b: 28 };
  const x0 = pad.l;
  const x1 = W - pad.r;
  const y0 = pad.t;
  const y1 = chartBottom;

  drawGrid(ctx, W, H, pad, 6, 4);
  drawAxes(ctx, W, H, pad);

  const span = Math.max(1, i1 - i0);
  const xs = new Array(span + 1);
  const sArr = new Array(span + 1);
  const iArr = new Array(span + 1);

  for (let k = 0; k <= span; k++) {
    const rr = rowAt("price", msArr[i0 + k]);
    sArr[k] = spreadFromRow(rr);
    iArr[k] = imbalanceFromRow(rr);
  }

  const sFinite = sArr.filter(Number.isFinite);
  const iFinite = iArr.filter(Number.isFinite);

  if (sFinite.length === 0 && iFinite.length === 0) {
    ctx.save();
    ctx.fillStyle = "rgba(214,222,235,0.85)";
    ctx.font = "12px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No L1 bid/ask or micro-mid signal in this window", (x0 + x1) / 2, (y0 + y1) / 2);
    ctx.restore();
    return;
  }

  let sMin = Math.min(...sFinite);
  let sMax = Math.max(...sFinite);
  if (!Number.isFinite(sMin) || !Number.isFinite(sMax) || sMin === sMax) {
    sMin = 0;
    sMax = 0.5;
  }

  const iMin = -1, iMax = 1;

  for (let k = 0; k <= span; k++) xs[k] = x0 + (k / span) * (x1 - x0);

  const ysS = sArr.map((v) => (Number.isFinite(v) ? y1 - ((v - sMin) / (sMax - sMin)) * (y1 - y0) : NaN));
  const mapI = (v) => y1 - ((v - iMin) / (iMax - iMin)) * (y1 - y0);
  const ysIpos = splitBySign(iArr, mapI, true);
  const ysIneg = splitBySign(iArr, mapI, false);

  drawLeftAxisTicks(ctx, x0, y0, y1, sMin, sMax, (v) => fmtNum(v, 4), "Spread");
  drawRightAxisTicks(ctx, x1, y0, y1, iMin, iMax, (v) => fmtNum(v, 2), "Imbalance");
  drawBottomTimeTicks(ctx, x0, x1, y1 + 6, msArr, i0, i1);

  const spreadCol = "rgba(245,158,11,0.95)";
  const imbPosCol = "rgba(52,211,153,0.95)";
  const imbNegCol = "rgba(248,113,113,0.95)";

  drawLine(ctx, xs, ysS, spreadCol, null, 1.8);
  drawLine(ctx, xs, ysIneg, imbNegCol, [6, 4], 1.8);
  drawLine(ctx, xs, ysIpos, imbPosCol, [6, 4], 1.8);

  drawLegend(
    ctx,
    [
      { label: "spread", strokeStyle: spreadCol, dash: null },
      { label: "imbalance (≥0)", strokeStyle: imbPosCol, dash: [6, 4] },
      { label: "imbalance (<0)", strokeStyle: imbNegCol, dash: [6, 4] },
    ],
    pad.l + 8,
    pad.t + 4
  );

  const hoverIdx = view.hoverIdx;
  const hoverK = hoverIdx >= i0 && hoverIdx <= i1 ? hoverIdx - i0 : -1;
  if (hoverK >= 0) {
    drawHover(
      ctx,
      pad,
      W,
      H,
      xs,
      hoverK,
      [
        { label: "spread", valueStr: Number.isFinite(sArr[hoverK]) ? fmtNum(sArr[hoverK], 4) : "—", colorStroke: spreadCol },
        {
          label: "imbalance",
          valueStr: Number.isFinite(iArr[hoverK]) ? fmtNum(iArr[hoverK], 3) : "—",
          colorStroke: Number(iArr[hoverK]) >= 0 ? imbPosCol : imbNegCol,
        },
      ],
      IMBALANCE_HINT
    );
  }
}

/* ---------------- Master render ---------------- */
function renderAll(forceRight = false) {
  ensureViewsInitialized(forceRight);
  setupSlider();
  updateTimeLabel();
  $("pillDate") && ($("pillDate").textContent = getLiveDate());

  renderPrice(VIEWS.price);
  renderPred(VIEWS.pred);
  renderMicro(VIEWS.micro);
  renderDepth(VIEWS.depth);
}

/* ---------------- Live control status pill ---------------- */
function setConnStatus(state, msg) {
  if (state === true) state = "live";
  else if (state === false || state == null) state = "offline";

  const el = $("connStatus");
  if (!el) return;

  el.classList.remove("status-pill", "live", "stop", "connecting");
  el.classList.add("status-pill");

  const txt = el.querySelector(".txt");

  if (state === "live") {
    el.classList.add("live");
    if (txt) txt.textContent = msg || "Live";
  } else if (state === "connecting") {
    el.classList.add("connecting");
    if (txt) txt.textContent = msg || "Connecting…";
  } else {
    el.classList.add("stop");
    if (txt) txt.textContent = msg || "Offline";
  }
}

/* ---------------- Poll logic (NO OVERLAP) ---------------- */
function resetPolling() {
  const raw = $("refreshMs")?.value ?? "1000";
  const v = parseInt(raw, 10);
  POLL_MS = Math.max(250, isNaN(v) ? 1000 : v);
  logLine("POLL", `resetPolling cadence=${POLL_MS}ms`);
}

/** Right-anchor newest timestamp (ALL charts share the same timeline msArr) */
function followRightIfAllowed() {
  const { N } = buildTimelineIndex();
  if (!N) return;
  if (AUTO_FOLLOW) {
    IDX.value = N - 1;
    renderAll(true);
  } else {
    renderAll(false);
  }
}

async function bootstrapFullOnce(symbol) {
  const n = 2000;

  try {
    ingestPred("hft", await fetchPredLatest(symbol, "hft", n), symbol);
  } catch (e) {
    logLine("ERR", `HFT /pred/latest failed: ${e.message}${e.bodyHint ? " · " + e.bodyHint : ""}`);
  }

  try {
    ingestPred("idt", await fetchPredLatest(symbol, "idt", n), symbol);
  } catch (e) {
    logLine("ERR", `IDT /pred/latest failed: ${e.message}${e.bodyHint ? " · " + e.bodyHint : ""}`);
  }

  try {
    const seconds = Number($("snapSeconds")?.value || "120") || 120;
    ingestSnapshot(await fetchSnapshot(symbol, seconds));
  } catch (e) {
    logLine("ERR", `/snapshot failed: ${e.message}${e.bodyHint ? " · " + e.bodyHint : ""}`);
  }

  followRightIfAllowed();
}

async function pollOnceDelta() {
  const symbol = getSymbol();

  // clamp “since” so we never query the future
  const sinceH = clampSince("hft", LAST.hft_ms);
  const sinceI = clampSince("idt", LAST.idt_ms);
  const sinceP = clampSince("price", LAST.price_ms);

  const before = { hft_ms: LAST.hft_ms, idt_ms: LAST.idt_ms, price_ms: LAST.price_ms };

  logLine("POLL", `delta poll: sym=${symbol} since(hft,idt,px)=${sinceH},${sinceI},${sinceP}`);
  setConnStatus("connecting", "Connecting…");

  let ok = false;
  let addedAny = false;

  try {
    const d = await fetchPredDelta(symbol, "hft", sinceH);
    const added = ingestPredDelta("hft", d, symbol);
    if (added) addedAny = true;
    ok = true;
  } catch (e) {
    logLine("ERR", `HFT /pred/delta failed: ${e.message}${e.bodyHint ? " · " + e.bodyHint : ""}`);
  }

  try {
    const d = await fetchPredDelta(symbol, "idt", sinceI);
    const added = ingestPredDelta("idt", d, symbol);
    if (added) addedAny = true;
    ok = true;
  } catch (e) {
    logLine("ERR", `IDT /pred/delta failed: ${e.message}${e.bodyHint ? " · " + e.bodyHint : ""}`);
  }

  try {
    const d = await fetchSnapshotDelta(symbol, sinceP);
    const added = ingestSnapshotDelta(d);
    if (added) addedAny = true;
    ok = true;
  } catch (e) {
    logLine("ERR", `/snapshot/delta failed: ${e.message}${e.bodyHint ? " · " + e.bodyHint : ""}`);
  }

  setConnStatus(ok ? "live" : "offline", ok ? "Live" : "Offline");

  const after = { hft_ms: LAST.hft_ms, idt_ms: LAST.idt_ms, price_ms: LAST.price_ms };
  logLine(
    "POLL",
    `cursor: BEFORE(hft,idt,px)=${before.hft_ms},${before.idt_ms},${before.price_ms}  AFTER=${after.hft_ms},${after.idt_ms},${after.price_ms}`
  );

  if (addedAny) followRightIfAllowed();
}

async function pollOnceFull() {
  const symbol = getSymbol();
  const n = 2000;
  logLine("POLL", `full pollOnce: sym=${symbol}`);

  setConnStatus("connecting", "Connecting…");
  let ok = false;

  try {
    ingestPred("hft", await fetchPredLatest(symbol, "hft", n), symbol);
    ok = true;
  } catch (e) {
    logLine("ERR", `HFT /pred/latest failed: ${e.message}${e.bodyHint ? " · " + e.bodyHint : ""}`);
  }

  try {
    ingestPred("idt", await fetchPredLatest(symbol, "idt", n), symbol);
    ok = true;
  } catch (e) {
    logLine("ERR", `IDT /pred/latest failed: ${e.message}${e.bodyHint ? " · " + e.bodyHint : ""}`);
  }

  try {
    const seconds = Number($("snapSeconds")?.value || "120") || 120;
    ingestSnapshot(await fetchSnapshot(symbol, seconds));
    ok = true;
  } catch (e) {
    logLine("ERR", `/snapshot failed: ${e.message}${e.bodyHint ? " · " + e.bodyHint : ""}`);
  }

  setConnStatus(ok ? "live" : "offline", ok ? "Live" : "Offline");
  followRightIfAllowed();
}

/* Self-scheduled poll loop: NO OVERLAP EVER */
async function pollLoop() {
  if (!liveTimer) return;
  if (pullInFlight) return;

  pullInFlight = true;
  try {
    if (USE_DELTA) await pollOnceDelta();
    else await pollOnceFull();
  } catch (e) {
    logLine("ERR", e.message);
  } finally {
    pullInFlight = false;
    if (liveTimer) liveTimer = setTimeout(pollLoop, POLL_MS);
  }
}

/* ---------------- Live start/stop ---------------- */
function startLive() {
  if (liveTimer) return;
  stopPlayback();

  AUTO_FOLLOW = true;
  resetPolling();
  setConnStatus("live");

  $("connectLive") && ($("connectLive").disabled = true);
  $("stopLive") && ($("stopLive").disabled = false);

  pullInFlight = false;
  liveTimer = setTimeout(() => {}, 0);

  const symbol = getSymbol();
  logLine("LIVE", `start (USE_DELTA=${USE_DELTA}) -> bootstrap then loop`);
  bootstrapFullOnce(symbol).finally(() => {
    if (!liveTimer) return;
    liveTimer = setTimeout(pollLoop, 0);
  });
}

function stopLive() {
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = null;
  pullInFlight = false;

  setConnStatus(false);

  $("stopLive") && ($("stopLive").disabled = true);
  $("connectLive") && ($("connectLive").disabled = false);

  logLine("LIVE", "stopped");
}

/* ---------------- Canvas interactions (independent + hover) ---------------- */
function attachCanvasViewInteractions(canvasId, view, redraw, padL = 56, padR = 12, invertWheel = false) {
  const canvas = $(canvasId);
  if (!canvas) return;

  let lastWheelAt = 0;

  function setHoverFromEvent(e) {
    const { N } = buildTimelineIndex();
    if (!N) {
      view.hoverIdx = -1;
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const W = canvas.clientWidth || 1;
    const x0 = padL, x1 = W - padR;

    const frac = (x - x0) / Math.max(1, x1 - x0);
    const clamped = Math.max(0, Math.min(1, frac));
    const idx = Math.round(view.i0 + clamped * (view.i1 - view.i0));
    view.hoverIdx = Math.max(0, Math.min(idx, N - 1));
  }

  canvas.addEventListener(
    "wheel",
    (e) => {
      AUTO_FOLLOW = false;
      const now = performance.now();
      if (now - lastWheelAt < 10) return;
      lastWheelAt = now;

      const { N } = buildTimelineIndex();
      if (!N) return;
      ensureViewsInitialized();

      setHoverFromEvent(e);

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;

      const x0 = padL, x1 = canvas.clientWidth - padR;
      const frac = (mouseX - x0) / Math.max(1, x1 - x0);
      const focusIdx = Math.round(view.i0 + frac * (view.i1 - view.i0));

      const zoomIn = invertWheel ? e.deltaY > 0 : e.deltaY < 0;
      const factor = zoomIn ? 0.85 : 1.15;

      const spanMin = 20;
      const curSpan = Math.max(spanMin, view.i1 - view.i0);
      const newSpan = Math.max(spanMin, Math.round(curSpan * factor));

      const localFrac = (focusIdx - view.i0) / Math.max(1, view.i1 - view.i0);
      let i0n = Math.round(focusIdx - localFrac * newSpan);
      let i1n = i0n + newSpan;

      view.i0 = i0n;
      view.i1 = i1n;

      clampView(view, N, spanMin);
      e.preventDefault();
      redraw();
    },
    { passive: false }
  );

  canvas.addEventListener("pointerdown", (e) => {
    AUTO_FOLLOW = false;
    const { N } = buildTimelineIndex();
    if (!N) return;
    ensureViewsInitialized();

    view.dragging = true;
    view.dragStartX = e.clientX;
    view.dragStartI0 = view.i0;
    view.dragStartI1 = view.i1;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!view.dragging) {
      setHoverFromEvent(e);
      redraw();
      return;
    }

    const { N } = buildTimelineIndex();
    if (!N) return;

    const W = canvas.clientWidth || 1;
    const span = view.dragStartI1 - view.dragStartI0;
    const dxPx = e.clientX - view.dragStartX;
    const deltaIdx = Math.round((-dxPx * span) / Math.max(1, W));

    view.i0 = view.dragStartI0 + deltaIdx;
    view.i1 = view.dragStartI1 + deltaIdx;

    clampView(view, N, 20);
    redraw();
  });

  canvas.addEventListener("pointerup", (e) => {
    view.dragging = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}
  });

  canvas.addEventListener("pointerleave", () => {
    view.hoverIdx = -1;
    redraw();
  });

  canvas.addEventListener("pointercancel", () => {
    view.dragging = false;
    view.hoverIdx = -1;
    redraw();
  });
}

/* ---------------- Mode wiring ---------------- */
function setMode(mode) {
  const live = mode === "live";
  $("liveHdr")?.classList.toggle("hide", !live);
  $("liveInputs")?.classList.toggle("hide", !live);
  $("csvHdr")?.classList.toggle("hide", live);
  $("csvInputs")?.classList.toggle("hide", live);

  if ($("refreshMs")) $("refreshMs").disabled = !live;
  $("applyRefresh")?.classList.toggle("dim", !live);

  if (live) {
    logLine("INIT", "setMode: live");
    startLive();
  } else {
    stopLive();
    setConnStatus(false);
    const pill = $("connStatus");
    pill?.querySelector(".txt") && (pill.querySelector(".txt").textContent = "Offline");
    logLine("INIT", "setMode: offline");
  }
}

function hardResetForNewSymbol() {
  stopLive();

  STORE.hft = { rows: [], horizons: [], unit: "", byMs: new Map() };
  STORE.idt = { rows: [], horizons: [], unit: "", byMs: new Map() };
  STORE.price = { rows: [], byMs: new Map() };

  LAST.hft_ms = 0;
  LAST.idt_ms = 0;
  LAST.price_ms = 0;

  IDX.value = 0;
  for (const k of Object.keys(VIEWS)) VIEWS[k] = makeView();

  AUTO_FOLLOW = true;
  renderAll(true);
  startLive();
}

/* ---------------- Controls wiring ---------------- */
(function controls() {
  logLine("INIT", "controls() begin");

  if ($("liveBase") && !$("liveBase").value) {
    const isLocal =
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1" ||
      location.hostname.endsWith(".local");
    $("liveBase").value = isLocal ? "http://localhost:5050" : "https://api.quantumyield.ai";
  }

  if ($("liveDate") && !$("liveDate").value) {
    $("liveDate").value = TODAY_YMD();
    logLine("INIT", `liveDate defaulted to ${$("liveDate").value} (UTC)`);
  }
  $("liveDate")?.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/[^\d]/g, "").slice(0, 8);
  });

  $("modeSeg")?.addEventListener("change", () => {
    const mode = document.querySelector('input[name="mode"]:checked')?.value || "offline";
    setMode(mode);
  });

  $("applyRefresh")?.addEventListener("click", () => {
    resetPolling();
    if (liveTimer) {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(pollLoop, 0);
      logLine("POLL", "loop rescheduled with new cadence");
    }
  });

  $("connectLive")?.addEventListener("click", () => {
    resetPolling();
    startLive();
  });

  $("stopLive")?.addEventListener("click", () => stopLive());

  $("timeSlider")?.addEventListener("input", () => {
    AUTO_FOLLOW = false;
    IDX.value = +$("timeSlider").value;
    renderAll(false);
  });

  $("playBtn")?.addEventListener("click", () => togglePlayback());

  $("showHFT")?.addEventListener("change", () => renderAll(false));
  $("showIDT")?.addEventListener("change", () => renderAll(false));

  $("liveSymbol")?.addEventListener("change", () => {
    $("pillSym") && ($("pillSym").textContent = getSymbol());
    hardResetForNewSymbol();
  });

  attachCanvasViewInteractions("qPrice", VIEWS.price, () => renderPrice(VIEWS.price), 56, 12);
  attachCanvasViewInteractions("qPred", VIEWS.pred, () => renderPred(VIEWS.pred), 56, 12);
  attachCanvasViewInteractions("qMicro", VIEWS.micro, () => renderMicro(VIEWS.micro), 56, 12);
  attachCanvasViewInteractions("qDepth", VIEWS.depth, () => renderDepth(VIEWS.depth), 56, 56, false);

  $("predCfgBtn")?.addEventListener("click", () => openPredModal());
  $("predModal")?.addEventListener("click", (e) => {
    if (e.target && e.target.id === "predModal") closePredModal();
  });
  $("predModalClose")?.addEventListener("click", () => closePredModal());

  $("predModalReset")?.addEventListener("click", () => {
    HSEL.hftSelected = [];
    HSEL.idtSelected = [];
    ensureDefaultPredSelection();
    buildPredModalLists();
    updatePredHintText();
    renderAll(false);
  });

  $("predModalApply")?.addEventListener("click", () => {
    readModalSelections();
    closePredModal();
    renderAll(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePredModal();
  });

  updatePredHintText();

  const initialMode = document.querySelector('input[name="mode"]:checked')?.value || "offline";
  setMode(initialMode);

  logLine("INIT", "controls() end");
})();

/* ---------------- Boot ---------------- */
(function init() {
  logLine("INIT", "boot init() begin");
  setConnStatus("offline");
  ensureViewsInitialized(true);
  setupSlider();
  renderAll(true);
  logLine("INIT", "boot init() end");
})();