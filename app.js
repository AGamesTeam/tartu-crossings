/* Tartu Crossing Survey: field app for timing traffic lights and measuring medians.
   Data: data/stops.json (from OSM), data/loops.json (pre-routed area loops).
   Storage: localStorage key "tcs.v1" on this device; export/import JSON to move it. */
(() => {
"use strict";

// ---------- constants ----------
const KEY = "tcs.v1";
const ARRIVE_M = 25;
const SCOOTERS = [
  // id, name, nominal V, Ah, typical Wh/km while riding a city survey (stop-and-go)
  { id: "g30", name: "Segway Ninebot Max G30 / G30P", v: 36, ah: 15.3, whkm: 13 },
  { id: "g2", name: "Segway Ninebot Max G2", v: 36, ah: 15.3, whkm: 13 },
  { id: "f40", name: "Segway Ninebot F40 / F2", v: 36, ah: 10.2, whkm: 13 },
  { id: "e2", name: "Segway Ninebot E2 / E2 Plus", v: 36, ah: 7.0, whkm: 12 },
  { id: "xpro2", name: "Xiaomi Mi Pro 2", v: 36, ah: 12.8, whkm: 14 },
  { id: "x4pro", name: "Xiaomi Electric Scooter 4 Pro", v: 36, ah: 12.4, whkm: 14 },
  { id: "x4", name: "Xiaomi Electric Scooter 4", v: 36, ah: 7.65, whkm: 13 },
  { id: "x4ultra", name: "Xiaomi Electric Scooter 4 Ultra", v: 48, ah: 15.3, whkm: 18 },
  { id: "kugoo", name: "Kugoo G2 Pro", v: 48, ah: 15, whkm: 20 },
  { id: "mantis", name: "Kaabo Mantis 10 (48 V 18.2 Ah)", v: 48, ah: 18.2, whkm: 24 },
  { id: "custom", name: "Other / custom…", v: 36, ah: 10, whkm: 14 },
];
// resting voltage per Li-ion cell -> state of charge (rough, NMC packs)
const OCV = [[3.30, 0], [3.50, .07], [3.62, .18], [3.68, .28], [3.73, .38], [3.79, .50],
             [3.85, .60], [3.92, .70], [4.00, .80], [4.10, .90], [4.20, 1]];
const LEGS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW", "Both halves", "Bike lane light"];
const EV = {
  green: { name: "Green", c: "var(--sig-green)" },
  flash: { name: "Flashing green", c: "var(--sig-flash)" },
  yellow: { name: "Yellow", c: "var(--sig-yellow)" },
  red: { name: "Red", c: "var(--sig-red)" },
  press: { name: "Pressed button", c: "var(--ink)" },
};
const KIND = { signal: "Traffic light crossing", island: "Median, no lights", plain: "No lights", junction: "Junction lights" };

// ---------- state ----------
const blank = () => ({
  settings: { scooter: "g30", cV: 36, cAh: 10, cWh: 14, voltage: null, trailerLen: 3.0, margin: 20, showPlain: true, onlyUnlogged: true },
  logs: {}, drafts: {}, ride: null,
});
let S = load();
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = JSON.parse(raw); const b = blank(); return { ...b, ...s, settings: { ...b.settings, ...s.settings } }; }
  } catch (e) { /* private mode or corrupt */ }
  return blank();
}
let saveT = 0;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast("Couldn't save on this phone (storage full or blocked)"); } }, 150);
}

let STOPS = [], BYID = {}, LOOPS = [];
let me = null;           // {lat, lon, acc}
let map, layers = {}, meMarker = null, accCircle = null;

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function dist(a, b) {
  const lat = (a[0] + b[0]) / 2 * Math.PI / 180;
  const dx = (b[1] - a[1]) * Math.PI / 180 * Math.cos(lat) * 6371000;
  const dy = (b[0] - a[0]) * Math.PI / 180 * 6371000;
  return Math.hypot(dx, dy);
}
function bearing(a, b) {
  const f1 = a[0] * Math.PI / 180, f2 = b[0] * Math.PI / 180, dl = (b[1] - a[1]) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const fmtM = (m) => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
const fmtS = (ms) => ms == null ? "–" : `${(ms / 1000).toFixed(1)} s`;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
const pos = (s) => [s.lat, s.lon];

// ---------- fit + outcome ----------
function fitOf(medianCm) {
  if (medianCm == null || medianCm === "") return null;
  const len = S.settings.trailerLen * 100, need = len + Number(S.settings.margin || 0);
  if (medianCm >= need) return "ok";
  if (medianCm >= len) return "tight";
  return "bad";
}
/** ok | tight | bad | split (must stop, no median measured) | logged | todo | skipped */
function outcome(id) {
  const L = S.logs[id];
  if (!L) return "todo";
  if (L.status === "skipped" && !L.oneGo && L.medianCm == null && !(L.timings || []).length) return "skipped";
  if (L.oneGo === "yes" || L.oneGo === "na") return "ok";
  const f = fitOf(L.medianCm);
  if (L.oneGo === "no") return f || "split";
  return f || "logged";
}
const OUT_COLOR = { ok: "--ok", tight: "--tight", bad: "--bad", split: "--tight", logged: "--accent", todo: "--todo", skipped: "--todo" };
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ---------- battery ----------
function scooter() {
  const sc = SCOOTERS.find((x) => x.id === S.settings.scooter) || SCOOTERS[0];
  if (sc.id !== "custom") return sc;
  return { ...sc, v: +S.settings.cV || 36, ah: +S.settings.cAh || 10, whkm: +S.settings.cWh || 14 };
}
function battery() {
  const sc = scooter();
  const cells = Math.round(sc.v / 3.6);
  const wh = sc.v * sc.ah;
  const V = Number(S.settings.voltage);
  if (!V) return { sc, cells, wh, soc: null, km: null };
  const vc = V / cells;
  let soc;
  if (vc <= OCV[0][0]) soc = 0;
  else if (vc >= OCV[OCV.length - 1][0]) soc = 1;
  else for (let i = 1; i < OCV.length; i++) if (vc <= OCV[i][0]) {
    const [v0, s0] = OCV[i - 1], [v1, s1] = OCV[i]; soc = s0 + (s1 - s0) * (vc - v0) / (v1 - v0); break;
  }
  const reserve = 0.12; // keep ~12 % so you're not pushing home
  const usable = Math.max(0, soc - reserve) * wh;
  return { sc, cells, wh, soc, vc, km: usable / sc.whkm };
}
function batteryText(short) {
  const b = battery();
  if (b.soc == null) return `Enter the battery voltage in <b>Setup</b> to get a range estimate for ${esc(b.sc.name)}.`;
  const pct = Math.round(b.soc * 100);
  const warn = b.vc > 4.25 || b.vc < 3.2 ? " <span class='badge bad'>check voltage / model</span>" : "";
  if (short) return `Battery about <b>${pct}%</b> · range left about <b>${b.km.toFixed(1)} km</b> (12% kept in reserve)${warn}`;
  return `${esc(b.sc.name)}: ${b.sc.v} V ${b.sc.ah} Ah ≈ ${Math.round(b.wh)} Wh, ${b.cells} cells in series.<br>
    ${(+S.settings.voltage).toFixed(1)} V = ${b.vc.toFixed(2)} V per cell ≈ <b>${pct}%</b> charge.<br>
    At ${b.sc.whkm} Wh/km you have about <b>${b.km.toFixed(1)} km</b> before the 12% reserve.${warn}`;
}

// ---------- map ----------
function initMap() {
  map = L.map("map", { zoomControl: false, preferCanvas: true, attributionControl: true }).setView([58.378, 26.725], 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap contributors",
  }).addTo(map);
  layers.plain = L.layerGroup().addTo(map);
  layers.survey = L.layerGroup().addTo(map);
  layers.ride = L.layerGroup().addTo(map);
  layers.route = L.layerGroup().addTo(map);
  map.on("click", onMapClick);
}

let stopMarkers = {};
function drawStops() {
  layers.plain.clearLayers(); layers.survey.clearLayers(); stopMarkers = {};
  const colors = {}; for (const k in OUT_COLOR) colors[k] = cssVar(OUT_COLOR[k]);
  const plainC = cssVar("--plain");
  for (const s of STOPS) {
    if (s.kind === "plain") {
      if (!S.settings.showPlain) continue;
      const m = L.circleMarker(pos(s), { radius: 3, weight: 0, fillColor: plainC, fillOpacity: .9 });
      m.on("click", (e) => { L.DomEvent.stop(e); openPopup(s); });
      m.addTo(layers.plain); continue;
    }
    const o = outcome(s.id);
    const m = L.circleMarker(pos(s), {
      radius: s.likelySplit ? 7 : 6, weight: 2, color: "#fff",
      fillColor: colors[o], fillOpacity: o === "todo" ? .75 : 1,
      dashArray: s.kind === "island" ? "3 2" : null,
    });
    m.on("click", (e) => { L.DomEvent.stop(e); openPopup(s); });
    m.addTo(layers.survey); stopMarkers[s.id] = m;
  }
}
function openPopup(s) {
  if (activeTab === "route") return onMapClick({ latlng: L.latLng(s.lat, s.lon) });
  const L0 = S.logs[s.id], o = outcome(s.id);
  const html = `<div style="display:grid;gap:6px;min-width:200px">
    <b>${esc(s.label)}</b>
    <span>${KIND[s.kind]}${s.likelySplit ? " · <b>looks two-step</b>" : ""}</span>
    ${s.hint.length ? `<span class="muted small">${esc(s.hint.join(", "))}</span>` : ""}
    ${L0 ? `<span>${outcomeText(o, L0)}</span>` : ""}
    <button class="btn primary" data-log="${s.id}">${L0 ? "Edit log" : "Log this crossing"}</button>
  </div>`;
  const p = L.popup({ offset: [0, -4] }).setLatLng(pos(s)).setContent(html).openOn(map);
  setTimeout(() => { const b = p.getElement()?.querySelector("[data-log]"); if (b) b.onclick = () => { map.closePopup(); openLog(s.id); }; });
}
function outcomeText(o, L0) {
  const m = L0?.medianCm != null ? ` (median ${L0.medianCm} cm)` : "";
  return ({ ok: "Fits / no stop in the middle", tight: "Tight fit" + m, bad: "Median too short" + m, split: "Two-step, median not measured",
            logged: "Logged", skipped: "Skipped", todo: "Not logged" })[o];
}

// ---------- GPS ----------
function startGps() {
  if (!("geolocation" in navigator)) { toast("This browser has no GPS access"); return; }
  navigator.geolocation.watchPosition((p) => {
    me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
    const ll = [me.lat, me.lon];
    if (!meMarker) {
      meMarker = L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [18, 18] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      accCircle = L.circle(ll, { radius: me.acc, weight: 0, fillColor: "#2a7cf7", fillOpacity: .08, interactive: false }).addTo(map);
    } else { meMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(me.acc); }
    if (follow) map.panTo(ll, { animate: true });
    updateRide(); if (activeTab === "plan") renderPlan(true);
  }, (err) => {
    toast(err.code === 1 ? "Location is blocked. Allow it for this site to see yourself on the map." : "Waiting for GPS…");
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}
let follow = false;

// ---------- tabs + sheet ----------
let activeTab = "plan";
function setTab(t) {
  activeTab = t;
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  $$(".pane").forEach((p) => (p.hidden = p.dataset.pane !== t));
  $("#sheet").classList.remove("mini");
  ({ plan: renderPlan, results: renderResults, route: renderRoute, settings: renderSettings })[t]();
}

// ---------- PLAN ----------
function loopInfo(lp) {
  const ids = lp.stops;
  const left = ids.filter((id) => !S.logs[id]).length;
  let near = null;
  if (me) near = Math.min(...ids.map((id) => dist([me.lat, me.lon], pos(BYID[id]))));
  const km = lp.m / 1000 + (near != null ? 2 * near * 1.3 / 1000 : 0);
  return { left, total: ids.length, km, near };
}
function renderPlan(quiet) {
  $("#batteryLine").innerHTML = batteryText(true);
  const b = battery();
  const rows = LOOPS.map((lp) => ({ lp, i: loopInfo(lp) }));
  rows.sort((a, b2) => (a.i.left === 0) - (b2.i.left === 0) || (a.i.near ?? 0) - (b2.i.near ?? 0) || b2.i.left - a.i.left);
  const ul = $("#loopList");
  if (quiet && ul.children.length && document.activeElement?.closest("#loopList")) return;
  ul.innerHTML = rows.map(({ lp, i }) => {
    let badge = "";
    if (i.left === 0) badge = `<span class="badge done">all logged</span>`;
    else if (b.km != null) badge = i.km <= b.km ? `<span class="badge ok">fits battery</span>` : i.km <= b.km * 1.15 ? `<span class="badge warn">just about</span>` : `<span class="badge bad">too far</span>`;
    return `<li class="loop">
      <span class="name">${esc(lp.area)}${badge}</span>
      <span class="facts">${i.left}/${i.total} crossings left · loop ${(lp.m / 1000).toFixed(1)} km${i.near != null ? ` · ${fmtM(i.near)} away · ~${i.km.toFixed(1)} km total` : ""}</span>
      <button class="btn primary go" data-area="${esc(lp.area)}">${S.ride?.area === lp.area ? "Resume" : "Start"}</button>
    </li>`;
  }).join("");
  $$("#loopList [data-area]").forEach((btn) => (btn.onclick = () => startRide(btn.dataset.area)));
  drawLoopPreview();
}
function drawLoopPreview() {
  if (S.ride) return;
  layers.ride.clearLayers();
  const c = cssVar("--accent");
  for (const lp of LOOPS) for (const lg of lp.legs) L.polyline(lg.line, { color: c, weight: 2, opacity: .35, interactive: false }).addTo(layers.ride);
}

// ---------- RIDE ----------
function startRide(area) {
  const lp = LOOPS.find((l) => l.area === area);
  if (S.ride?.area === area) { showRide(); return; }
  let ids = lp.stops.slice();
  // rotate so the loop starts at the stop nearest to you
  let start = 0;
  if (me) { let best = Infinity; ids.forEach((id, k) => { const d = dist([me.lat, me.lon], pos(BYID[id])); if (d < best) { best = d; start = k; } }); }
  const order = ids.slice(start).concat(ids.slice(0, start));
  S.ride = { area, order, visited: [], started: Date.now() };
  save(); showRide(); toast(`Ride started: ${area}`);
}
function rideTargets() {
  const r = S.ride; if (!r) return [];
  // skip stops already visited this ride; optionally also ones logged before this ride began
  return r.order.filter((id) => !r.visited.includes(id) && !(S.settings.onlyUnlogged && S.logs[id] && (S.logs[id].updated || 0) < r.started));
}
function nextTarget() { return rideTargets()[0] || null; }
function showRide() {
  $("#ride").hidden = false; $("#sheet").classList.add("mini"); follow = true;
  drawRide(); updateRide();
  const t = nextTarget(); if (t) map.setView(pos(BYID[t]), 16);
}
function legPath(area, fromId, toId) {
  // concatenate pre-routed legs walking the loop from fromId to toId
  const lp = LOOPS.find((l) => l.area === area); const n = lp.stops.length;
  let i = lp.stops.indexOf(fromId); const j = lp.stops.indexOf(toId); const out = [];
  if (i < 0 || j < 0) return out;
  let guard = 0;
  while (i !== j && guard++ < n) { out.push(...lp.legs[i].line); i = (i + 1) % n; }
  return out;
}
function drawRide() {
  layers.ride.clearLayers();
  const r = S.ride; if (!r) return;
  const lp = LOOPS.find((l) => l.area === r.area);
  const accent = cssVar("--accent");
  for (const lg of lp.legs) L.polyline(lg.line, { color: accent, weight: 4, opacity: .35, interactive: false }).addTo(layers.ride);
  const targets = rideTargets(); const nxt = targets[0];
  // bold path from the last visited stop (or first in order) to the next target
  if (nxt) {
    const prev = r.visited.length ? r.visited[r.visited.length - 1] : null;
    if (prev && prev !== nxt) L.polyline(legPath(r.area, prev, nxt), { color: accent, weight: 7, opacity: .95, interactive: false }).addTo(layers.ride);
  }
  r.order.forEach((id, k) => {
    const s = BYID[id];
    const st = r.visited.includes(id) ? (S.logs[id]?.status === "skipped" ? "skipped" : "done") : (S.logs[id] && !targets.includes(id) ? "done" : "");
    const icon = L.divIcon({ className: "", html: `<div class="stopnum ${id === nxt ? "next" : st}">${k + 1}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
    L.marker(pos(s), { icon, zIndexOffset: id === nxt ? 900 : 500 }).on("click", () => openPopup(s)).addTo(layers.ride);
  });
}
let arrivedFor = null;
function updateRide() {
  const r = S.ride; if (!r || $("#ride").hidden) return;
  const targets = rideTargets(); const nxt = targets[0];
  const done = r.order.length - targets.length;
  if (!nxt) {
    $("#rideLabel").textContent = `${r.area} done`; $("#rideSub").textContent = `${done}/${r.order.length} crossings`;
    $("#rideArrow").textContent = "✓"; $("#rideArrow").style.transform = ""; $("#rideLog").hidden = true; $("#rideSkip").hidden = true; return;
  }
  $("#rideLog").hidden = false; $("#rideSkip").hidden = false;
  const s = BYID[nxt];
  $("#rideLabel").textContent = s.label;
  let sub = `${done + 1}/${r.order.length} · ${KIND[s.kind]}${s.likelySplit ? " · two-step?" : ""}`;
  if (me) {
    const d = dist([me.lat, me.lon], pos(s));
    sub = `${fmtM(d)} · ${sub}`;
    $("#rideArrow").textContent = "↑"; $("#rideArrow").style.transform = `rotate(${bearing([me.lat, me.lon], pos(s))}deg)`;
    if (d < ARRIVE_M && arrivedFor !== nxt) {
      arrivedFor = nxt; toast("You're at the crossing. Tap Log."); try { navigator.vibrate?.([120, 60, 120]); } catch (e) {}
    }
  } else { $("#rideArrow").textContent = "•"; }
  $("#rideSub").textContent = sub;
}
function advanceRide(id) {
  const r = S.ride; if (!r) return;
  if (!r.visited.includes(id)) r.visited.push(id);
  save(); drawRide(); updateRide();
  const nxt = nextTarget(); if (nxt) map.panTo(pos(BYID[nxt]));
}
function endRide() {
  S.ride = null; save(); $("#ride").hidden = true; follow = false; layers.ride.clearLayers(); setTab("plan");
}

// ---------- LOG SHEET ----------
let logId = null, curLeg = null, clockT = 0;
function draft() { return (S.drafts[logId] ||= { leg: null, events: [] }); }
function openLog(id) {
  logId = id; const s = BYID[id];
  const L0 = S.logs[id] || {};
  $("#logTitle").textContent = s.label;
  $("#logMeta").innerHTML = [
    `<span class="chip">${KIND[s.kind]}</span>`,
    s.likelySplit ? `<span class="chip warn">looks two-step</span>` : "",
    s.island === "yes" ? `<span class="chip">median mapped</span>` : "",
    `<span class="chip">${esc(s.area)}</span>`,
  ].join("");
  curLeg = draft().leg;
  $("#legPick").innerHTML = LEGS.map((l) => `<button data-v="${l}" class="${l === curLeg ? "on" : ""}">${l}</button>`).join("");
  setPick("#oneGo", L0.oneGo); setPick("#button", L0.button);
  $("#medianCm").value = L0.medianCm ?? ""; $("#note").value = L0.note ?? "";
  const hasLights = s.kind === "signal" || s.kind === "junction";
  const hide = !hasLights && !(L0.timings || []).length && !draft().events.length;
  $("#timingBlock").hidden = hide; $("#showTiming").hidden = !hide;
  renderEvents(); renderSaved(); renderFit();
  $("#log").hidden = false;
  clearInterval(clockT); clockT = setInterval(tickClock, 100);
}
function closeLog() { $("#log").hidden = true; clearInterval(clockT); logId = null; }
function setPick(sel, v) { $$(sel + " button").forEach((b) => b.classList.toggle("on", b.dataset.v === v)); }
function getPick(sel) { return $(sel + " button.on")?.dataset.v ?? null; }
function tickClock() {
  const ev = draft().events; if (!ev.length) { $("#clock").textContent = "Tap when a light changes"; return; }
  const ms = Date.now() - ev[ev.length - 1].at;
  const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
  $("#clock").textContent = `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")} since ${EV[ev[ev.length - 1].t].name.toLowerCase()}`;
}
function summarize(events) {
  const ev = events.slice().sort((a, b) => a.at - b.at);
  const col = ev.filter((e) => e.t !== "press");
  const acc = { green: [], flash: [], yellow: [], red: [] };
  for (let i = 0; i < col.length - 1; i++) acc[col[i].t].push(col[i + 1].at - col[i].at);
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  // cycle: between consecutive starts of the same colour (prefer green)
  let cycle = null;
  for (const t of ["green", "red", "yellow", "flash"]) {
    const st = col.filter((e) => e.t === t).map((e) => e.at);
    if (st.length >= 2) { const d = []; for (let i = 1; i < st.length; i++) d.push(st[i] - st[i - 1]); cycle = avg(d); break; }
  }
  const waits = [];
  ev.forEach((e, i) => { if (e.t === "press") { const g = ev.slice(i + 1).find((x) => x.t === "green"); if (g) waits.push(g.at - e.at); } });
  return { green: avg(acc.green), flash: avg(acc.flash), yellow: avg(acc.yellow), red: avg(acc.red), cycle, wait: avg(waits) };
}
function summaryHtml(sm) {
  return [["Green", sm.green], ["Flashing", sm.flash], ["Yellow", sm.yellow], ["Red", sm.red], ["Full cycle", sm.cycle], ["Button wait", sm.wait]]
    .map(([k, v]) => `<div>${k}<b>${fmtS(v)}</b></div>`).join("");
}
function renderEvents() {
  const ev = draft().events;
  $("#evList").innerHTML = ev.map((e, i) => {
    const d = i ? ` +${((e.at - ev[i - 1].at) / 1000).toFixed(1)} s` : "";
    return `<li><span><i style="background:${EV[e.t].c}"></i>${EV[e.t].name}</span><span>${new Date(e.at).toLocaleTimeString([], { hour12: false })}${d}</span></li>`;
  }).join("");
  $("#evSummary").innerHTML = ev.length > 1 ? summaryHtml(summarize(ev)) : "";
  tickClock();
}
function renderSaved() {
  const T = S.logs[logId]?.timings || [];
  $("#savedTimings").innerHTML = T.map((t, i) => {
    const sm = summarize(t.events);
    return `<li><span><b>${esc(t.leg || "Side ?")}</b> · green ${fmtS(sm.green)}, flash ${fmtS(sm.flash)}, cycle ${fmtS(sm.cycle)}${sm.wait != null ? `, wait ${fmtS(sm.wait)}` : ""}</span><button data-del="${i}" aria-label="Delete timing">Delete</button></li>`;
  }).join("");
  $$("#savedTimings [data-del]").forEach((b) => (b.onclick = () => { S.logs[logId].timings.splice(+b.dataset.del, 1); touch(); renderSaved(); }));
}
function renderFit() {
  const v = $("#medianCm").value; const f = fitOf(v === "" ? null : +v);
  const len = Math.round(S.settings.trailerLen * 100);
  const el = $("#fitLine"); el.className = "fit " + (f || "");
  el.textContent = f == null ? `Your scooter + trailer is ${len} cm. Margin ${S.settings.margin} cm.`
    : f === "ok" ? `Fits: ${+v - len} cm to spare.` : f === "tight" ? `Tight: only ${+v - len} cm to spare.` : `Too short by ${len - +v} cm.`;
}
function logRec() { return (S.logs[logId] ||= { status: "done", timings: [], created: Date.now() }); }
function touch() { logRec().updated = Date.now(); save(); }
function storeFields() {
  const r = logRec();
  r.oneGo = getPick("#oneGo"); r.button = getPick("#button");
  const v = $("#medianCm").value; r.medianCm = v === "" ? null : Math.max(0, Math.round(+v));
  r.note = $("#note").value.trim(); touch();
}
function saveTiming(silent) {
  const d = draft(); if (d.events.length < 2) { if (!silent) toast("Tap at least two light changes first"); return false; }
  logRec().timings.push({ leg: d.leg, events: d.events, savedAt: Date.now() });
  d.events = []; touch(); renderEvents(); renderSaved(); if (!silent) toast("Timing saved"); return true;
}
function finishLog(status) {
  const id = logId;
  if (!id || $("#log").hidden) return; // double tap after the sheet already closed
  if (draft().events.length >= 2) saveTiming(true);
  delete S.drafts[id];
  if (status === "skipped" && !S.logs[id]) S.logs[id] = { status: "skipped", timings: [], created: Date.now(), updated: Date.now() };
  else { storeFields(); S.logs[id].status = status === "skipped" && S.logs[id].status !== "done" ? "skipped" : "done"; }
  save(); closeLog(); drawStops();
  if (S.ride && S.ride.order.includes(id)) advanceRide(id);
  toast(status === "skipped" ? "Skipped" : "Saved");
  renderProgress();
}

// ---------- RESULTS ----------
function renderResults() {
  const surv = STOPS.filter((s) => s.survey);
  const cnt = { ok: 0, tight: 0, bad: 0, split: 0, logged: 0, todo: 0, skipped: 0 };
  surv.forEach((s) => cnt[outcome(s.id)]++);
  const logged = surv.length - cnt.todo - cnt.skipped;
  $("#stats").innerHTML = [[logged, `of ${surv.length} logged`], [cnt.ok, "fine"], [cnt.tight + cnt.split, "tight / unmeasured"], [cnt.bad, "median too short"]]
    .map(([n, t]) => `<div class="stat"><b>${n}</b><span>${t}</span></div>`).join("");
  const ids = Object.keys(S.logs).filter((id) => BYID[id]).sort((a, b) => (S.logs[b].updated || 0) - (S.logs[a].updated || 0));
  $("#logList").innerHTML = ids.length ? ids.map((id) => {
    const s = BYID[id], L0 = S.logs[id], o = outcome(id);
    return `<li><i class="dot ${o === "split" ? "tight" : o === "logged" || o === "skipped" ? "todo" : o}"></i><button data-id="${id}"><span class="t">${esc(s.label)}</span><span class="d">${outcomeText(o, L0)} · ${(L0.timings || []).length} timing(s) · ${new Date(L0.updated || L0.created).toLocaleDateString()}</span></button></li>`;
  }).join("") : `<li class="muted">Nothing logged yet. Start a loop on the Ride tab, or tap any coloured dot on the map.</li>`;
  $$("#logList [data-id]").forEach((b) => (b.onclick = () => { const s = BYID[b.dataset.id]; map.setView(pos(s), 17); openLog(s.id); }));
}
function exportData() {
  return { app: "tartu-crossing-survey", version: 1, exported: new Date().toISOString(), settings: { trailerLen: S.settings.trailerLen, margin: S.settings.margin },
    logs: Object.fromEntries(Object.entries(S.logs).map(([id, L0]) => { const s = BYID[id] || {}; return [id, { ...L0, label: s.label, lat: s.lat, lon: s.lon, kind: s.kind, area: s.area }]; })) };
}
function download(name, text, type) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
function exportCsv() {
  const head = ["osm_id", "area", "label", "kind", "lat", "lon", "looks_two_step", "result", "cross_in_one_go", "median_cm", "push_button", "note", "side", "green_s", "flashing_s", "yellow_s", "red_s", "cycle_s", "button_wait_s", "timed_at"];
  const q = (v) => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const sec = (ms) => ms == null ? "" : (ms / 1000).toFixed(1);
  const rows = [head.join(",")];
  for (const [id, L0] of Object.entries(S.logs)) {
    const s = BYID[id]; if (!s) continue;
    const base = [id, s.area, s.label, s.kind, s.lat, s.lon, s.likelySplit ? "yes" : "no", outcome(id), L0.oneGo, L0.medianCm, L0.button, L0.note];
    const T = L0.timings?.length ? L0.timings : [null];
    for (const t of T) {
      const sm = t ? summarize(t.events) : {};
      rows.push([...base, t?.leg, sec(sm.green), sec(sm.flash), sec(sm.yellow), sec(sm.red), sec(sm.cycle), sec(sm.wait), t ? new Date(t.savedAt).toISOString() : ""].map(q).join(","));
    }
  }
  download(`tartu-crossings-${stamp()}.csv`, rows.join("\n"), "text/csv");
}
function importJson(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const j = JSON.parse(fr.result); if (!j.logs) throw new Error("no logs");
      let n = 0;
      for (const [id, L0] of Object.entries(j.logs)) {
        const mine = S.logs[id];
        if (!mine || (L0.updated || 0) > (mine.updated || 0)) {
          const { label, lat, lon, kind, area, ...rec } = L0; S.logs[id] = rec; n++;
        }
      }
      save(); drawStops(); renderResults(); renderProgress(); toast(`Imported ${n} crossing log(s)`);
    } catch (e) { toast("That file isn't a Tartu Crossing Survey export"); }
  };
  fr.readAsText(file);
}

// ---------- ROUTE (BRouter) ----------
let rA = null, rB = null, rMarkers = [], pickStart = false;
function renderRoute() {
  $("#ptA").textContent = rA ? `${rA.lat.toFixed(5)}, ${rA.lng.toFixed(5)}` : "My location";
  $("#ptB").textContent = rB ? `${rB.lat.toFixed(5)}, ${rB.lng.toFixed(5)}` : "Tap the map";
}
function onMapClick(e) {
  if (activeTab !== "route") return;
  // With GPS: taps set the destination (start = you). "Start here" mode lets a tap set A.
  // Without GPS: first tap is the start, second the destination, a third starts over.
  if (pickStart || (!me && !rA)) { rA = e.latlng; pickStart = false; $("#pickStart").classList.remove("on"); }
  else if (!me && rB) { rA = e.latlng; rB = null; }
  else rB = e.latlng;
  drawRouteMarkers(); renderRoute();
}
function drawRouteMarkers() {
  rMarkers.forEach((m) => m.remove()); rMarkers = [];
  const mk = (ll, t, cls) => L.marker(ll, { icon: L.divIcon({ className: "", html: `<span class="pin ${cls}">${t}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(layers.route);
  if (rA) rMarkers.push(mk(rA, "A", "a")); if (rB) rMarkers.push(mk(rB, "B", "b"));
}
function nogosFor(a, b) {
  const pref = $$("#lightPref input").find((i) => i.checked).value;
  const trailer = $("#trailerSafe").checked, unknownSplit = $("#avoidUnknownSplit").checked;
  // corridor: points within 900 m of the straight A–B line
  const near = (s) => {
    const ax = a[1], ay = a[0], bx = b[1], by = b[0];
    const k = Math.cos(ay * Math.PI / 180);
    const px = (s.lon - ax) * k, py = s.lat - ay, vx = (bx - ax) * k, vy = by - ay;
    const t = Math.max(0, Math.min(1, (px * vx + py * vy) / ((vx * vx + vy * vy) || 1)));
    return Math.hypot(px - vx * t, py - vy * t) * 111320;
  };
  const out = [];
  const add = (s, r, w) => out.push({ d: near(s), v: `${s.lon.toFixed(5)},${s.lat.toFixed(5)},${r}${w ? "," + w : ""}`, hard: !w });
  for (const s of STOPS) {
    if (near(s) > 900) continue;
    const o = outcome(s.id);
    if (trailer && o === "bad") { add(s, 12, 0); continue; }
    if (trailer && unknownSplit && s.likelySplit && (o === "todo" || o === "split")) { add(s, 12, 400); continue; }
    if (pref === "avoid" && (s.kind === "signal" || s.kind === "junction")) add(s, 15, 150);
    if (pref === "favour" && (s.kind === "plain" || s.kind === "island")) add(s, 8, 60);
  }
  // hard blocks first, then the nearest preference points; keep the URL short enough
  out.sort((x, y) => (y.hard - x.hard) || x.d - y.d);
  return { list: out.slice(0, 300).map((x) => x.v), total: out.length, hard: out.filter((x) => x.hard).length };
}
async function findRoute() {
  const A = rA ? [rA.lat, rA.lng] : me ? [me.lat, me.lon] : null;
  const B = rB ? [rB.lat, rB.lng] : null;
  if (!A || !B) { toast(A ? "Tap the map to set the destination" : "Tap the map to set a start, then a destination"); return; }
  const ng = nogosFor(A, B);
  const url = `https://brouter.de/brouter?lonlats=${A[1].toFixed(5)},${A[0].toFixed(5)}|${B[1].toFixed(5)},${B[0].toFixed(5)}&profile=trekking&alternativeidx=0&format=geojson` +
    (ng.list.length ? `&nogos=${ng.list.join("|")}` : "");
  const out = $("#routeOut"); out.hidden = false; out.textContent = "Routing…";
  try {
    const r = await fetch(url); const txt = await r.text();
    if (!r.ok || txt.trim()[0] !== "{") throw new Error(txt.slice(0, 160));
    const j = JSON.parse(txt); const f = j.features[0]; const p = f.properties;
    layers.route.eachLayer((l) => { if (l instanceof L.Polyline) l.remove(); });
    const line = f.geometry.coordinates.map((c) => [c[1], c[0]]);
    L.polyline(line, { color: cssVar("--ink"), weight: 6, opacity: .85 }).addTo(layers.route);
    map.fitBounds(L.latLngBounds(line).pad(.15));
    // count lights + crossings passed (within 12 m of the line)
    const passed = STOPS.filter((s) => line.some((pt, i) => i % 2 === 0 && dist(pt, pos(s)) < 12));
    const lights = passed.filter((s) => s.kind === "signal" || s.kind === "junction").length;
    const bad = passed.filter((s) => outcome(s.id) === "bad").length;
    const unk = passed.filter((s) => s.likelySplit && outcome(s.id) === "todo").length;
    out.innerHTML = `<b>${fmtM(+p["track-length"])}</b> · about ${Math.round(+p["total-time"] / 60)} min by bike<br>
      Passes ${lights} light crossing(s), ${passed.length - lights} without lights.<br>
      ${bad ? `<span class="badge bad">${bad} too-short median(s) on route</span>` : `<span class="badge ok">no known too-short medians</span>`}
      ${unk ? ` <span class="badge warn">${unk} unchecked two-step-looking</span>` : ""}
      ${ng.total > ng.list.length ? `<br><span class="muted small">Used the ${ng.list.length} closest of ${ng.total} avoid points.</span>` : ""}`;
  } catch (e) {
    out.innerHTML = navigator.onLine === false ? "You're offline. Route planning needs internet." :
      ng.hard ? "No route found. A blocked crossing may cut off the destination: try unticking Trailer-safe to compare." : "Routing failed. Try again in a moment.";
  }
}

// ---------- SETTINGS ----------
function renderSettings() {
  const st = S.settings;
  $("#scooter").innerHTML = SCOOTERS.map((s) => `<option value="${s.id}" ${s.id === st.scooter ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  $("#customScooter").hidden = st.scooter !== "custom";
  $("#cV").value = st.cV; $("#cAh").value = st.cAh; $("#cWh").value = st.cWh;
  $("#voltage").value = st.voltage ?? ""; $("#trailerLen").value = st.trailerLen; $("#margin").value = st.margin;
  $("#showPlain").checked = st.showPlain;
  $("#batteryCalc").innerHTML = batteryText(false);
}
function bindSettings() {
  const set = (k, v) => { S.settings[k] = v; save(); $("#batteryCalc").innerHTML = batteryText(false); };
  $("#scooter").onchange = (e) => { set("scooter", e.target.value); $("#customScooter").hidden = e.target.value !== "custom"; };
  for (const k of ["cV", "cAh", "cWh"]) $("#" + k).oninput = (e) => set(k, +e.target.value || null);
  $("#voltage").oninput = (e) => set("voltage", e.target.value === "" ? null : +e.target.value);
  $("#trailerLen").oninput = (e) => { if (+e.target.value > 0) { set("trailerLen", +e.target.value); drawStops(); } };
  $("#margin").oninput = (e) => { set("margin", Math.max(0, +e.target.value || 0)); drawStops(); };
  $("#showPlain").onchange = (e) => { set("showPlain", e.target.checked); drawStops(); };
  $("#wipe").onclick = () => ($("#wipeConfirm").hidden = false);
  $("#wipeNo").onclick = () => ($("#wipeConfirm").hidden = true);
  $("#wipeYes").onclick = () => { S.logs = {}; S.drafts = {}; S.ride = null; save(); $("#wipeConfirm").hidden = true; $("#ride").hidden = true; drawStops(); renderProgress(); toast("All logs deleted"); };
}

function renderProgress() {
  const surv = STOPS.filter((s) => s.survey);
  const n = surv.filter((s) => S.logs[s.id] && S.logs[s.id].status !== "skipped").length;
  $("#progress").textContent = `${n}/${surv.length} crossings logged`;
}

// ---------- wiring ----------
function bind() {
  $$(".tab").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $("#grip").onclick = () => { const sh = $("#sheet"); if (sh.classList.contains("mini")) sh.classList.remove("mini"); else sh.classList.toggle("tall"); };
  $("#locate").onclick = () => { if (me) { map.setView([me.lat, me.lon], 17); follow = !!S.ride; } else toast("No GPS fix yet"); };
  $("#onlyUnlogged").checked = S.settings.onlyUnlogged;
  $("#onlyUnlogged").onchange = (e) => { S.settings.onlyUnlogged = e.target.checked; save(); };
  $("#rideLog").onclick = () => { const t = nextTarget(); if (t) openLog(t); };
  $("#rideSkip").onclick = () => { const t = nextTarget(); if (t) { S.ride.visited.push(t); save(); drawRide(); updateRide(); const n = nextTarget(); if (n) map.panTo(pos(BYID[n])); } };
  $("#rideStop").onclick = endRide;
  map.on("dragstart", () => (follow = false));

  $("#logClose").onclick = () => { if (!logId) return; if (S.logs[logId]) storeFields(); save(); closeLog(); drawStops(); };
  $("#legPick").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; curLeg = b.dataset.v; draft().leg = curLeg; save(); setPick("#legPick", curLeg); };
  $$(".phase").forEach((b) => (b.onclick = () => {
    draft().events.push({ t: b.dataset.ev, at: Date.now() }); save(); renderEvents();
    try { navigator.vibrate?.(30); } catch (e) {}
  }));
  $("#showTiming").onclick = () => { $("#timingBlock").hidden = false; $("#showTiming").hidden = true; };
  $("#evUndo").onclick =() => { draft().events.pop(); save(); renderEvents(); };
  $("#evSave").onclick = () => saveTiming(false);
  for (const sel of ["#oneGo", "#button"]) $(sel).onclick = (e) => { const b = e.target.closest("button"); if (!b) return; const on = b.classList.contains("on"); setPick(sel, on ? null : b.dataset.v); };
  $("#medianCm").oninput = renderFit;
  $("#logDone").onclick = () => finishLog("done");
  $("#logSkip").onclick = () => finishLog("skipped");

  $("#exportJson").onclick = () => download(`tartu-crossings-${stamp()}.json`, JSON.stringify(exportData(), null, 1), "application/json");
  $("#exportCsv").onclick = exportCsv;
  $("#importJson").onchange = (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ""; };

  $("#routeGo").onclick = findRoute;
  $("#pickStart").onclick = () => { pickStart = !pickStart; $("#pickStart").classList.toggle("on", pickStart); if (pickStart) toast("Tap the map where the route should start"); };
  $("#routeClear").onclick = () => { rA = rB = null; layers.route.clearLayers(); rMarkers = []; $("#routeOut").hidden = true; renderRoute(); };
  bindSettings();

  // keep the screen on while riding, where the browser allows it
  let wl = null;
  const wake = async () => { try { if (S.ride && document.visibilityState === "visible" && "wakeLock" in navigator) wl = await navigator.wakeLock.request("screen"); } catch (e) {} };
  document.addEventListener("visibilitychange", wake); document.addEventListener("click", wake, { once: true });
}

async function boot() {
  initMap();
  try {
    const [st, lp] = await Promise.all([fetch("data/stops.json").then((r) => r.json()), fetch("data/loops.json").then((r) => r.json())]);
    STOPS = st; LOOPS = lp; BYID = Object.fromEntries(STOPS.map((s) => [s.id, s]));
    for (const k of Object.keys(S.logs)) if (!BYID[k]) delete S.logs[k];
    for (const k of Object.keys(S.drafts)) if (!BYID[k]) delete S.drafts[k];
  } catch (e) { toast("Couldn't load crossing data. Open the app from its web address, not as a file.", 8000); return; }
  fetch("data/meta.json").then((r) => r.json()).then((m) => ($("#dataDate").textContent = m.imported)).catch(() => {});
  bind(); drawStops(); renderProgress(); setTab("plan");
  if (S.ride) showRide();
  startGps();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
}
boot();
})();
