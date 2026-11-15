/* 상권 기입 지도 v2 — 카카오맵 + Supabase PWA
   데이터: 지역(regions) / 라인(lines) / 매장(stores) + 매장 관찰(store_obs) / 매물(listings) / 메모 핀(pins) / 음성 기록(voice_log) */
(() => {
"use strict";
const CFG = window.APP_CONFIG || {};
const SLOTS = [["wl","평일 점심"],["wd","평일 저녁"],["sl","주말 점심"],["sd","주말 저녁"]];
const COL = {"많음":"#D6452B","보통":"#F0A43A","적음":"#7E98B3","":"#9AA3AE"};
const TAGS = ["직장인","가족·유모차","어르신","커플","주민","퇴근 통행","목적 방문","임대문의 많음","응달·북향","야장","배달 많음","웨이팅","주말 휴무 많음"];
const LST_STATUS = ["검토중","임장 완료","보류","탈락","협의중","계약"];
const OPEN = ["영업","준비중","휴무"];
const TABLES = ["regions","lines","stores","store_obs","listings","pins","voice_log","feedback"];
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const slotName = k => (SLOTS.find(s => s[0] === k) || [0,"전체"])[1];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "x" + Date.now() + Math.random().toString(16).slice(2));
const now = () => new Date().toISOString();
const hhmm = d => { d = d ? new Date(d) : new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
const md = d => { d = new Date(d); return (d.getMonth() + 1) + "/" + d.getDate() + "(" + "일월화수목금토"[d.getDay()] + ")"; };
function slotOf(d) { d = d ? new Date(d) : new Date(); const we = d.getDay() === 0 || d.getDay() === 6; const eve = d.getHours() >= 16; return we ? (eve ? "sd" : "sl") : (eve ? "wd" : "wl"); }
const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : null; };
const won = v => v == null || v === "" ? "—" : (v >= 10000 ? (v / 10000).toFixed(v % 10000 ? 1 : 0).replace(/\.0$/, "") + "억" : Number(v).toLocaleString("ko-KR") + "만");

const DB = {}; TABLES.forEach(t => DB[t] = {});
let slot = localStorage.getItem("slot") || slotOf();
let region = localStorage.getItem("region") || "";
let layers = JSON.parse(localStorage.getItem("layers") || '{"line":true,"store":true,"listing":true,"pin":true}');
let mode = "sel", sel = null, draft = [], view = "home", searchRes = [], showZones = localStorage.getItem("zones") !== "0";
let dName = "", dZone = "", addKind = "";
const inRegion = r => !region || r.region_id === region;
const list = t => Object.values(DB[t]).filter(inRegion);

/* ---------------- toast / hint ---------------- */
let toastT;
function toast(t, ms = 2200) { const el = $("#toast"); el.textContent = t; el.style.display = "block"; clearTimeout(toastT); toastT = setTimeout(() => el.style.display = "none", ms); }
function hint(t) { const h = $("#hint"); h.textContent = t || ""; h.style.display = t ? "block" : "none"; }

/* ---------------- storage ---------------- */
const LSKEY = "sangkwon-map-v2";
const Store = {
  kind: "local", sb: null, user: null, pending: {}, timers: {}, busy: {},
  async init() {
    if (CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase) {
      this.kind = "supa";
      this.sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
      const { data } = await this.sb.auth.getSession();
      this.user = data.session?.user || null;
      this.sb.auth.onAuthStateChange((_e, s) => { const was = !!this.user; this.user = s?.user || null; if (!was && this.user) { this.load(); view = "home"; panel(); } });
      if (this.user) await this.load(); else { view = "login"; panel(); }
    } else { this.kind = "local"; this.loadLocal(); }
  },
  loadLocal() {
    try { const j = JSON.parse(localStorage.getItem(LSKEY) || "{}"); TABLES.forEach(t => DB[t] = j[t] || {}); } catch (e) {}
    afterLoad();
  },
  saveLocal() { try { const o = {}; TABLES.forEach(t => o[t] = DB[t]); localStorage.setItem(LSKEY, JSON.stringify(o)); } catch (e) { toast("이 기기 저장 공간이 가득 찼어요. 사진을 줄이거나 클라우드 저장을 켜 주세요", 5000); } },
  async load() {
    const res = await Promise.all(TABLES.map(t => this.sb.from(t).select("*")));
    const bad = res.find(r => r.error); if (bad) { toast("불러오기 실패: " + bad.error.message, 5000); return; }
    TABLES.forEach((t, i) => { DB[t] = {}; res[i].data.forEach(r => DB[t][r.id] = r); });
    afterLoad();
    if (!this.ch) {
      let ch = this.sb.channel("rt");
      TABLES.forEach(t => ch = ch.on("postgres_changes", { event: "*", schema: "public", table: t }, p => this.remote(t, p)));
      this.ch = ch.subscribe();
    }
  },
  remote(t, p) {
    if (p.eventType === "DELETE") delete DB[t][p.old.id];
    else { const r = p.new; if (this.pending[t + r.id]) return; DB[t][r.id] = r; }
    renderAll(true);
  },
  save(t, id, ms = 500) {
    const r = DB[t][id]; if (!r) return;
    r.updated_at = now();
    if (this.kind === "local") { clearTimeout(this.timers.local); this.timers.local = setTimeout(() => this.saveLocal(), ms ? 300 : 0); return; }
    const key = t + id; this.pending[key] = true;
    clearTimeout(this.timers[key]); this.timers[key] = setTimeout(() => this.flush(t, id), ms);
  },
  async flush(t, id) {
    const key = t + id;
    if (this.busy[key]) { this.busy[key] = "again"; return; }
    this.busy[key] = true;
    const row = DB[t][id];
    if (row) { const { error } = await this.sb.from(t).upsert(row); if (error) toast("저장 실패: " + error.message, 5000); }
    const again = this.busy[key] === "again"; delete this.busy[key];
    if (again) return this.flush(t, id);
    setTimeout(() => delete this.pending[key], 1500);
  },
  async remove(t, id) {
    delete DB[t][id];
    if (this.kind === "local") { this.saveLocal(); return; }
    const { error } = await this.sb.from(t).delete().eq("id", id);
    if (error) toast("삭제 실패: " + error.message, 4000);
  },
  async uploadPhoto(blob) {
    if (this.kind === "local") return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    const path = `${new Date().toISOString().slice(0, 10)}/${uid()}.jpg`;
    const { error } = await this.sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg" });
    if (error) throw error;
    return this.sb.storage.from("photos").getPublicUrl(path).data.publicUrl;
  }
};
function put(t, row, ms = 0) { if (!row.id) row.id = uid(); if (!row.created_at) row.created_at = now(); if (t !== "regions" && !row.region_id) row.region_id = region; DB[t][row.id] = row; Store.save(t, row.id, ms); return row; }
function afterLoad() {
  if (!Object.keys(DB.regions).length) {
    const c = CFG.CENTER || { lat: 37.5603, lng: 126.8325 };
    const r = put("regions", { name: "마곡·발산", center: c, level: CFG.LEVEL || 4, zones: window.ZONES || [] });
    // 지역 없이 저장된 기존 라인·핀은 첫 지역으로
    ["lines","pins","stores","listings","store_obs"].forEach(t => Object.values(DB[t]).forEach(x => { if (!x.region_id) { x.region_id = r.id; Store.save(t, x.id, 0); } }));
  }
  if (!DB.regions[region]) region = Object.values(DB.regions).sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""))[0].id;
  setRegion(region, true);
}

/* ---------------- map ---------------- */
let map = null, ov = [], draftOv = [], zoneOv = [], ignoreMapClick = 0;
const K = () => window.kakao.maps;
function loadKakao() {
  return new Promise((res, rej) => {
    if (!CFG.KAKAO_JS_KEY) return rej(new Error("no key"));
    const s = document.createElement("script");
    s.src = "https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&libraries=services&appkey=" + encodeURIComponent(CFG.KAKAO_JS_KEY);
    s.onload = () => window.kakao.maps.load(res); s.onerror = () => rej(new Error("load fail"));
    document.head.appendChild(s);
  });
}
const LL = (lat, lon) => new (K().LatLng)(lat, lon);
function initMap() {
  const c = CFG.CENTER || { lat: 37.5603, lng: 126.8325 };
  map = new (K().Map)($("#map"), { center: LL(c.lat, c.lng), level: CFG.LEVEL || 4 });
  map.addControl(new (K().ZoomControl)(), K().ControlPosition.BOTTOMLEFT);
  K().event.addListener(map, "click", e => {
    if (Date.now() < ignoreMapClick) return;
    ignoreMapClick = Date.now() + 150;
    const p = e.latLng; onMapClick(p.getLat(), p.getLng());
  });
  K().event.addListener(map, "dragstart", () => { if (follow) { follow = false; $("#fLoc").classList.remove("on"); } });
  K().event.addListener(map, "zoom_changed", () => renderMap());
}
function drawZones() {
  zoneOv.forEach(o => o.setMap(null)); zoneOv = [];
  const R = DB.regions[region]; const Z = R && R.zones;
  if (!map || !showZones || !Z || !Z.length) return;
  for (const z of Z) {
    const pg = new (K().Polygon)({ path: z.pts.map(p => LL(p[0], p[1])), strokeWeight: 1, strokeColor: "#8c9bb5", strokeOpacity: .7, strokeStyle: "shortdash", fillColor: z.name.endsWith("북") ? "#dfe6f3" : "#eef1f6", fillOpacity: .3, zIndex: 0 });
    pg.setMap(map); K().event.addListener(pg, "click", clickShape(null)); zoneOv.push(pg);
    const lat = z.pts.reduce((a, p) => a + p[0], 0) / z.pts.length, lon = z.pts.reduce((a, p) => a + p[1], 0) / z.pts.length;
    const el = document.createElement("div"); el.className = "zl"; el.textContent = z.name;
    const co = new (K().CustomOverlay)({ position: LL(lat, lon), content: el, zIndex: 1 }); co.setMap(map); zoneOv.push(co);
  }
}
function clickShape(fn) {
  return e => {
    if (Date.now() < ignoreMapClick) return;
    ignoreMapClick = Date.now() + 350;
    if (mode !== "sel" && e && e.latLng) { onMapClick(e.latLng.getLat(), e.latLng.getLng()); return; }
    if (fn) fn(); else if (e && e.latLng) onMapClick(e.latLng.getLat(), e.latLng.getLng());
  };
}
function overlay(lat, lng, el, z, yAnchor) {
  const co = new (K().CustomOverlay)({ position: LL(lat, lng), content: el, zIndex: z, clickable: true, ...(yAnchor != null ? { yAnchor } : {}) });
  co.setMap(map); ov.push(co); return co;
}
function tapEl(el, fn) { el.onclick = e => { e.stopPropagation(); if (mode === "sel" || mode === "voice") { ignoreMapClick = Date.now() + 350; fn(); } }; }
const isSel = (t, id) => sel && sel.type === t && sel.id === id;
function renderMap() {
  if (!map) return;
  ov.forEach(o => o.setMap(null)); ov = [];
  const zoomedOut = map.getLevel() >= 5;
  if (layers.line) for (const L of sortedLines()) {
    const pts = (L.pts || []).filter(p => p && p.lat && p.lon); if (!pts.length) continue;
    const id = L.id, r = (L.ratings || {})[slot] || "", c = COL[r] ?? COL[""], on = isSel("line", id);
    const pick = clickShape(() => select("line", id));
    let anchor;
    if (L.kind === "node") {
      anchor = pts[0];
      const ci = new (K().Circle)({ center: LL(anchor.lat, anchor.lon), radius: L.r_m || 35, strokeWeight: on ? 4 : 2, strokeColor: on ? "#3b2a8f" : "#fff", strokeOpacity: 1, fillColor: c, fillOpacity: r ? .75 : .3, zIndex: 3 });
      ci.setMap(map); K().event.addListener(ci, "click", pick); ov.push(ci);
    } else {
      const path = pts.map(p => LL(p.lat, p.lon));
      if (on) { const h = new (K().Polyline)({ path, strokeWeight: 16, strokeColor: "#3b2a8f", strokeOpacity: .35, zIndex: 2 }); h.setMap(map); ov.push(h); }
      const pl = new (K().Polyline)({ path, strokeWeight: 9, strokeColor: c, strokeOpacity: r ? .95 : .7, strokeStyle: r ? "solid" : "shortdash", zIndex: 3 });
      pl.setMap(map); K().event.addListener(pl, "click", pick); ov.push(pl);
      const m = Math.floor((pts.length - 1) / 2), n = Math.ceil((pts.length - 1) / 2);
      anchor = { lat: (pts[m].lat + pts[n].lat) / 2, lon: (pts[m].lon + pts[n].lon) / 2 };
    }
    const el = document.createElement("div"); el.className = "badge" + (on ? " sel" : ""); el.textContent = L.no ?? "•"; tapEl(el, () => select("line", id));
    overlay(anchor.lat, anchor.lon, el, on ? 9 : 5);
  }
  if (layers.store) for (const S of list("stores")) {
    const o = latestObs(S.id, slot), st = obsState(o), on = isSel("store", S.id);
    const el = document.createElement("div"); el.className = "stm" + (on ? " sel" : "");
    el.innerHTML = `<i style="background:${st.c}">${st.icon}</i>${zoomedOut && !on ? "" : `<span>${esc(S.name.slice(0, 10))}</span>`}`;
    tapEl(el, () => select("store", S.id)); overlay(S.lat, S.lng, el, on ? 11 : 7, .5);
  }
  if (layers.listing) for (const P of list("listings")) {
    const on = isSel("listing", P.id), dim = P.status === "탈락";
    const el = document.createElement("div"); el.className = "lsm" + (on ? " sel" : "") + (dim ? " dim" : "");
    el.innerHTML = `<div class="b">${esc(P.rent ? "월 " + won(num(P.rent)) : (P.title || "매물").slice(0, 8))}</div><div class="t"></div>`;
    tapEl(el, () => select("listing", P.id)); overlay(P.lat, P.lng, el, on ? 12 : 8, 1);
  }
  if (layers.pin) for (const p of list("pins")) {
    if (p.slot !== "all" && p.slot !== slot) continue;
    const on = isSel("pin", p.id);
    const el = document.createElement("div"); el.className = "pinm" + (on ? " sel" : ""); el.style.color = "#0f766e";
    el.innerHTML = `<div class="b"><span style="color:${on ? "#fff" : "#0f766e"}">${esc((p.title || "메모").slice(0, 12))}</span></div><div class="t"></div>`;
    tapEl(el, () => select("pin", p.id)); overlay(p.lat, p.lng, el, on ? 10 : 6, 1);
  }
}
function renderDraft() {
  if (!map) return;
  draftOv.forEach(o => o.setMap(null)); draftOv = [];
  if (!draft.length) return;
  const path = draft.map(p => LL(p.lat, p.lon));
  if (draft.length > 1) { const pl = new (K().Polyline)({ path, strokeWeight: 7, strokeColor: "#3b2a8f", strokeOpacity: .9, strokeStyle: "dash", zIndex: 8 }); pl.setMap(map); draftOv.push(pl); }
  for (const q of path) { const el = document.createElement("div"); el.className = "vtx"; const co = new (K().CustomOverlay)({ position: q, content: el, zIndex: 9 }); co.setMap(map); draftOv.push(co); }
}
function renderAll(fromRemote) { renderMap(); renderDraft(); if (!fromRemote || !isEditing()) panel(); }
function isEditing() { const a = document.activeElement; return a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.tagName === "SELECT") && $("#panel").contains(a); }
function panTo(lat, lon, level) { if (!map) return; if (level) map.setLevel(level); map.panTo(LL(lat, lon)); }

/* ---------------- 내 위치 (계속 표시) ---------------- */
let me = null, meOv = null, accOv = null, watchId = null, follow = false;
function startWatch() {
  if (!navigator.geolocation || watchId != null) return;
  watchId = navigator.geolocation.watchPosition(p => {
    me = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
    drawMe(); if (follow) panTo(me.lat, me.lng);
  }, err => { if (err.code === 1) { toast("위치 권한이 꺼져 있어요. 브라우저 설정에서 허용해 주세요", 4000); stopWatch(); } }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  localStorage.setItem("watch", "1");
}
function stopWatch() { if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; follow = false; $("#fLoc").classList.remove("on"); localStorage.setItem("watch", "0"); }
function drawMe() {
  if (!map || !me) return;
  if (!meOv) { const el = document.createElement("div"); el.className = "me"; meOv = new (K().CustomOverlay)({ position: LL(me.lat, me.lng), content: el, zIndex: 30 }); meOv.setMap(map); }
  else meOv.setPosition(LL(me.lat, me.lng));
  if (!accOv) { accOv = new (K().Circle)({ center: LL(me.lat, me.lng), radius: me.acc, strokeWeight: 0, fillColor: "#1a73e8", fillOpacity: .08, zIndex: 1 }); accOv.setMap(map); }
  else { accOv.setPosition(LL(me.lat, me.lng)); accOv.setRadius(Math.min(me.acc, 200)); }
}

/* ---------------- geometry ---------------- */
function meters(a, b) { const R = 6371000, toR = Math.PI / 180, dLat = (b.lat - a.lat) * toR, dLon = ((b.lon ?? b.lng) - (a.lon ?? a.lng)) * toR; const x = dLon * Math.cos((a.lat + b.lat) / 2 * toR); return Math.sqrt(x * x + dLat * dLat) * R; }
function distToLine(p, L) {
  const pts = (L.pts || []); if (!pts.length) return 1e9;
  if (pts.length === 1) return Math.max(0, meters(p, pts[0]) - (L.r_m || 35));
  let best = 1e9; const toR = Math.PI / 180, k = Math.cos(p.lat * toR) * 111320, kl = 110540;
  for (let i = 1; i < pts.length; i++) {
    const ax = (pts[i - 1].lon - p.lng) * k, ay = (pts[i - 1].lat - p.lat) * kl, bx = (pts[i].lon - p.lng) * k, by = (pts[i].lat - p.lat) * kl;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy; best = Math.min(best, Math.sqrt(x * x + y * y));
  }
  return best;
}
function nearestLine(p, maxM = 70) { let b = null, bd = maxM; for (const L of list("lines")) { const d = distToLine(p, L); if (d < bd) { bd = d; b = L; } } return b; }

/* ---------------- interactions ---------------- */
function onMapClick(lat, lon) {
  lat = +lat.toFixed(6); lon = +lon.toFixed(6);
  if (mode === "line") { draft.push({ lat, lon }); renderDraft(); panel(); return; }
  if (mode === "add") { addAt(addKind, lat, lon); return; }
  if (sel) { sel = null; view = "home"; renderAll(); }
}
function addAt(kind, lat, lng, place) {
  setMode("sel");
  if (kind === "store") { const S = put("stores", { name: place ? place.place_name : "", category: place ? (place.category_name || "").split(" > ").slice(-1)[0] : "", lat, lng, place: place || null, line_id: (nearestLine({ lat, lng }, 40) || {}).id || null, memo: "", tags: [], photos: [] }); select("store", S.id); focusSoon("#sName", !place); }
  else if (kind === "listing") { const P = put("listings", { title: place ? place.place_name : "", address: place ? (place.road_address_name || place.address_name || "") : "", lat, lng, status: "검토중", source: "", floor: "1층", photos: [], memo: "", line_id: (nearestLine({ lat, lng }, 40) || {}).id || null }); select("listing", P.id); if (!P.address) fillAddress(P); focusSoon("#xTitle", !place); }
  else { const p = put("pins", { title: place ? place.place_name : "", text: "", slot: "all", lat, lng, place: place || null, photos: [] }); select("pin", p.id); focusSoon("#pTitle", !place); }
}
function focusSoon(s, yes) { if (yes) setTimeout(() => { const i = $(s); if (i) i.focus(); }, 80); }
function fillAddress(P) {
  if (!map || !K().services) return;
  new (K().services.Geocoder)().coord2Address(P.lng, P.lat, (r, st) => { if (st === K().services.Status.OK && r[0]) { P.address = (r[0].road_address || r[0].address || {}).address_name || ""; Store.save("listings", P.id, 0); if (isSel("listing", P.id) && !isEditing()) panel(); } });
}
function select(type, id) { sel = { type, id }; view = type; renderAll(); sheetSize("mid"); }
function setSlot(k) { slot = k; localStorage.setItem("slot", k); document.querySelectorAll("#slots button").forEach(b => b.classList.toggle("on", b.dataset.s === k)); renderAll(); }
function setRegion(id, first) {
  region = id; localStorage.setItem("region", id);
  const R = DB.regions[id]; $("#regionBtn").textContent = (R ? R.name : "지역") + " ▾";
  sel = null; if (!first) view = "home";
  drawZones(); if (R && R.center && map) panTo(R.center.lat, R.center.lng, R.level || 4);
  renderAll();
}
function setMode(m, k) {
  mode = m; addKind = k || ""; draft = []; dName = ""; dZone = "";
  $("#fLine").classList.toggle("on", m === "line"); $("#fAdd").classList.toggle("on", m === "add");
  hint(m === "line" ? "라인을 따라 지도를 차례로 눌러 점을 찍으세요. 점 1개면 사거리·몰 같은 지점이 돼요."
     : m === "add" ? ({ store: "매장 위치를 지도에서 누르세요. 위쪽 검색으로 상호를 찾아 추가해도 돼요.", listing: "매물 위치를 지도에서 누르세요.", pin: "메모를 남길 위치를 지도에서 누르세요." }[k]) : "");
  if (m === "line") { sel = null; view = "draw"; sheetSize("mid"); }
  else if (view === "draw" || view === "add") view = "home";
  renderAll();
}
$("#slots").innerHTML = SLOTS.map(([k, t]) => `<button data-s="${k}" class="${k === slot ? "on" : ""}">${t}</button>`).join("");
$("#slots").onclick = e => { const b = e.target.closest("button"); if (b) setSlot(b.dataset.s); };
$("#fLine").onclick = () => setMode(mode === "line" ? "sel" : "line");
$("#fAdd").onclick = () => { if (mode === "add") return setMode("sel"); sel = null; view = "add"; sheetSize("mid"); panel(); };
$("#fTable").onclick = () => { sel = null; view = view === "table" ? "home" : "table"; sheetSize("max"); renderAll(); };
$("#fMenu").onclick = () => { sel = null; view = view === "menu" ? "home" : "menu"; sheetSize("mid"); renderAll(); };
$("#fVoice").onclick = () => { sel = null; view = "voice"; sheetSize("max"); panel(); if (SR) setTimeout(() => { const b = $("#vMic"); if (b && !rec) b.click(); }, 120); };
$("#regionBtn").onclick = () => { sel = null; view = "regions"; sheetSize("mid"); panel(); };
$("#fLoc").onclick = () => {
  if (!navigator.geolocation) return toast("이 기기에서는 위치를 쓸 수 없어요");
  if (watchId == null) { startWatch(); follow = true; $("#fLoc").classList.add("on"); toast("내 위치를 따라가요. 지도를 끌면 멈춰요"); if (me) panTo(me.lat, me.lng, 3); return; }
  follow = !follow; $("#fLoc").classList.toggle("on", follow); if (follow && me) panTo(me.lat, me.lng, Math.min(map ? map.getLevel() : 3, 3));
};
$("#searchForm").onsubmit = e => {
  e.preventDefault(); const q = $("#q").value.trim(); if (!q) return;
  if (!map || !K().services) return toast("지도 키 설정 후 검색할 수 있어요");
  $("#q").blur();
  new (K().services.Places)().keywordSearch(q, (data, status) => {
    searchRes = status === K().services.Status.OK ? data : [];
    sel = null; view = "search"; sheetSize("mid"); panel();
  }, { location: map.getCenter(), radius: 5000, sort: K().services.SortBy.ACCURACY });
};
// 아래 목록 화면 높이: 끌어서 조절, 숨기기/보이기. 'mid'는 마지막으로 끌어 놓은 높이를 기억
const HIDE_H = 30;
let sheetH = +localStorage.getItem("sheetH") || 0, sheetHidden = localStorage.getItem("sheetHidden") === "1";
const vh = () => window.innerHeight;
const clampH = h => Math.max(HIDE_H, Math.min(vh() * 0.9, h));
function applySheet(h, anim = true) {
  const el = $("#sheet"); el.style.transition = anim ? "" : "none";
  document.documentElement.style.setProperty("--sheet", h + "px");
  const hid = h <= HIDE_H + 4; el.classList.toggle("hid", hid); document.body.classList.toggle("sheethid", hid);
  document.body.classList.toggle("sheetmax", h >= vh() * 0.8);
  $("#fSheet").textContent = hid ? "▴" : "▾"; $("#fSheet").title = hid ? "목록 보이기" : "목록 숨기기";
  if (map && window.innerWidth >= 900) setTimeout(() => map.relayout && map.relayout(), 220);
}
function sheetSize(s) {
  if (window.innerWidth >= 900) { if (s !== "min" && sheetHidden) toggleSheet(false); return; }
  if (s === "max") return applySheet(Math.round(vh() * 0.86));
  if (s === "min") return applySheet(HIDE_H);
  if (sheetHidden && !s.force) { sheetHidden = false; localStorage.setItem("sheetHidden", "0"); }
  applySheet(clampH(sheetH || Math.round(vh() * 0.42)));
}
function toggleSheet(hide) {
  sheetHidden = hide == null ? !sheetHidden : hide; localStorage.setItem("sheetHidden", sheetHidden ? "1" : "0");
  document.body.classList.toggle("panelhid", sheetHidden && window.innerWidth >= 900);
  if (window.innerWidth >= 900) { $("#fSheet").textContent = sheetHidden ? "◂" : "▸"; $("#fSheet").title = sheetHidden ? "목록 보이기" : "목록 숨기기"; setTimeout(() => map && map.relayout && map.relayout(), 50); return; }
  sheetHidden ? applySheet(HIDE_H) : applySheet(clampH(sheetH || Math.round(vh() * 0.42)));
}
$("#fSheet").onclick = () => toggleSheet();
(() => {
  const g = $("#grab"); let y0 = 0, h0 = 0, moved = false, drag = false;
  g.addEventListener("pointerdown", e => { drag = true; moved = false; y0 = e.clientY; h0 = $("#sheet").getBoundingClientRect().height; g.setPointerCapture(e.pointerId); });
  g.addEventListener("pointermove", e => { if (!drag) return; const dy = y0 - e.clientY; if (Math.abs(dy) > 4) moved = true; if (moved) applySheet(clampH(h0 + dy), false); });
  const end = e => {
    if (!drag) return; drag = false;
    if (!moved) return toggleSheet();          // 손잡이 탭 = 숨기기/보이기
    const h = $("#sheet").getBoundingClientRect().height;
    if (h < 90) { sheetHidden = true; localStorage.setItem("sheetHidden", "1"); return applySheet(HIDE_H); }
    sheetHidden = false; localStorage.setItem("sheetHidden", "0");
    sheetH = Math.round(h); localStorage.setItem("sheetH", sheetH); applySheet(sheetH);
  };
  g.addEventListener("pointerup", end); g.addEventListener("pointercancel", end);
})();
document.addEventListener("keydown", e => { if (e.key === "Escape") { if (mode !== "sel") setMode("sel"); else { sel = null; view = "home"; renderAll(); } } });

/* ---------------- 매장 관찰 ---------------- */
function obsOf(storeId) { return Object.values(DB.store_obs).filter(o => o.store_id === storeId).sort((a, b) => (b.at || "").localeCompare(a.at || "")); }
function latestObs(storeId, k) { return obsOf(storeId).find(o => !k || o.slot === k) || null; }
function obsText(o) {
  if (!o) return "기록 없음";
  const a = [];
  if (o.open && o.open !== "영업") a.push(o.open);
  if (o.is_full) a.push("만석"); else if (o.pct != null && o.pct !== "") a.push(o.pct + "%");
  if (o.wait) a.push("웨이팅 " + o.wait + "팀"); else if (o.teams) a.push(o.teams + "팀");
  if (!a.length && o.open === "영업") a.push("영업");
  return a.join(" · ") || (o.note ? "메모" : "—");
}
function obsState(o) {
  if (!o) return { c: "#ffffff", icon: "", t: "기록 없음" };
  if (o.open === "휴무") return { c: "#2b2f36", icon: "×", t: "휴무" };
  if (o.open === "준비중") return { c: "#b9bec6", icon: "…", t: "준비중" };
  const p = o.is_full ? 100 : (o.pct != null && o.pct !== "" ? +o.pct : null);
  if (o.wait || (p != null && p >= 90)) return { c: COL["많음"], icon: o.wait ? "W" : "", t: obsText(o) };
  if (p != null && p >= 40) return { c: COL["보통"], icon: "", t: obsText(o) };
  if (p != null) return { c: COL["적음"], icon: "", t: obsText(o) };
  return { c: "#4b5563", icon: "", t: obsText(o) };
}
function addObs(storeId, data) {
  const at = data.at || now();
  return put("store_obs", { store_id: storeId, region_id: DB.stores[storeId]?.region_id || region, at, slot: data.slot || slotOf(at), open: data.open ?? "영업", pct: data.pct ?? null, is_full: !!(data.is_full || data.full), wait: data.wait || null, teams: data.teams || null, note: data.note || "" });
}

/* ---------------- 음성 ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recBtn = null;
function startRec(btn, onText) {
  if (rec) { rec.stop(); return; }
  rec = new SR(); rec.lang = "ko-KR"; rec.interimResults = true; rec.continuous = true; recBtn = btn; btn.classList.add("live");
  let committed = "";
  rec.onresult = ev => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) { const t = ev.results[i][0].transcript; if (ev.results[i].isFinal) { committed += (committed ? " " : "") + t.trim(); onText(committed, true); committed = ""; } else interim += t; }
    const live = $("#vLive"); if (live) live.textContent = interim;
  };
  rec.onend = () => { btn.classList.remove("live"); rec = null; recBtn = null; const live = $("#vLive"); if (live) live.textContent = ""; };
  rec.onerror = e => { if (e.error === "not-allowed") toast("마이크 권한을 허용해 주세요", 4000); else if (e.error !== "no-speech" && e.error !== "aborted") toast("음성 인식이 끊겼어요. 다시 눌러 주세요"); };
  try { rec.start(); } catch (e) { btn.classList.remove("live"); rec = null; }
}
function mic(btn, ta) {
  if (!SR) { btn.style.display = "none"; return; }
  btn.onclick = () => startRec(btn, t => { ta.value = (ta.value ? ta.value.trimEnd() + " " : "") + t; ta.dispatchEvent(new Event("input")); });
}
// 받아쓰기에서 자주 틀리는 말
const FIX = [[/저금/g, "적음"], [/만음/g, "많음"], [/마늠/g, "많음"], [/저근/g, "적음"], [/웨이 팅/g, "웨이팅"], [/만 석/g, "만석"], [/퍼센트|프로(?![가-힣])/g, "%"]];
function normalize(t) { for (const [a, b] of FIX) t = t.replace(a, b); return t; }
const squash = s => String(s || "").replace(/[\s·,()~\/\-]/g, "").toLowerCase();
function lineKeys(L) { return String(L.name || "").replace(/[()·,~\/]/g, " ").split(/\s+/).filter(w => w.length >= 2 && !/^(라인|앞|뒤|면|쪽|측|북측|남측|사이|방향|내부|안쪽|이면|건너|맞은편|대로변|\d+로|\d+)$/.test(w)); }
function ratingIn(s) {
  if (/(많음|많아|많고|많은|만석|붐비|북적|바글|가장 많)/.test(s) && !/(많지 않|안 많)/.test(s)) return "많음";
  if (/(보통|중간|절반|그럭저럭|적당)/.test(s)) return "보통";
  if (/(적음|적어|적고|적은|없음|거의 없|한산|썰렁|텅|휑|초토화|박살|많지 않|안 많)/.test(s)) return "적음";
  return "";
}
function storeObsIn(s) {
  const o = {}; let hit = false;
  if (/(휴무|문\s*닫|닫혀|닫았|안\s*열|영업\s*안|쉬는)/.test(s)) { o.open = "휴무"; hit = true; }
  else if (/(오픈\s*준비|준비\s*중|오픈 전)/.test(s)) { o.open = "준비중"; hit = true; }
  if (/만석/.test(s)) { o.is_full = true; o.pct = 100; hit = true; }
  let m = s.match(/웨이팅\s*(\d+)\s*팀/) || s.match(/(\d+)\s*팀\s*(정도\s*)?(웨이팅|대기)/); if (m) { o.wait = +m[1]; hit = true; } else if (/웨이팅|대기/.test(s)) { o.wait = o.wait || 1; hit = true; }
  m = s.match(/(\d{1,3})\s*%/); if (m) { o.pct = Math.min(100, +m[1]); hit = true; }
  else if (/절반/.test(s)) { o.pct = 50; hit = true; } else if (/(한산|비어|손님\s*없)/.test(s)) { o.pct = 10; hit = true; }
  m = s.match(/(\d+)\s*팀(?!\s*(정도\s*)?(웨이팅|대기))/); if (m && !o.wait) { o.teams = +m[1]; hit = true; }
  if (hit && !o.open) o.open = "영업";
  return hit ? o : null;
}
function splitSpeech(text) {
  return text.split(/(?<=[.!?。])\s+|\n+|\s*(?:그리고|그다음|다음으로|그 다음에|또\s)\s*/).map(s => s.trim()).filter(s => s.length > 1);
}
function parseVoice(text, defSlot) {
  text = normalize(text);
  const lines = list("lines"), stores = list("stores"), out = [];
  const near = me && Date.now() - me.t < 120000 ? nearestLine(me) : null;
  for (const seg of splitSpeech(text)) {
    const sq = squash(seg);
    if (/^(개선\s*요청|개선|앱|어플|요청)/.test(seg)) { out.push({ type: "feedback", note: seg.replace(/^(개선\s*요청|요청)\s*[:,]?\s*/, ""), slot: defSlot, on: true }); continue; }
    // 1) 매장 이름이 나오면 매장 관찰
    const S = stores.filter(S => storeKeys(S).some(k => sq.includes(k))).sort((a, b) => b.name.length - a.name.length)[0];
    const so = storeObsIn(seg);
    if (S) { out.push({ type: "store", id: S.id, slot: defSlot, obs: so || { open: "영업" }, note: seg, on: true }); continue; }
    // 2) 라인 이름 또는 번호
    let best = null, bs = 0;
    for (const L of lines) {
      let sc = 0; const m = seg.match(/(\d{1,3})\s*번\s*라인/); if (m && +m[1] === +L.no) sc += 5;
      for (const k of lineKeys(L)) if (sq.includes(squash(k))) sc += k.length >= 3 ? 2 : 1;
      if (sc > bs) { bs = sc; best = L; }
    }
    const r = ratingIn(seg);
    if (best && bs >= 2) { out.push({ type: "line", id: best.id, slot: defSlot, rating: r, note: seg, on: true, how: "이름" }); continue; }
    // 3) 매장 혼잡 표현인데 등록 안 된 매장
    if (so && !r) { out.push({ type: "newstore", name: guessName(seg), slot: defSlot, obs: so, note: seg, on: true }); continue; }
    // 4) 이름 없으면 지금 내 위치에서 가장 가까운 라인
    if (near) { out.push({ type: "line", id: near.id, slot: defSlot, rating: r, note: seg, on: true, how: "내 위치" }); continue; }
    out.push({ type: "line", id: "", slot: defSlot, rating: r, note: seg, on: true });
  }
  return out;
}
function storeKeys(S) { const n = String(S.name || ""); return [...new Set([squash(n), squash(n.replace(/\s*\S+점$/, "")), squash(n.split(/\s+/)[0])])].filter(k => k.length >= 2); }
function guessName(seg) { const m = seg.match(/^([가-힣A-Za-z0-9&]{2,12}?)(은|는|이|가|도|에|쪽|매장)?\s/); return m ? m[1] : ""; }
let vText = "", vItems = null, vMsg = "", vSlot = "";
function vApply() {
  const t = hhmm(); let n = 0;
  for (const it of vItems) {
    if (!it.on) continue;
    if (it.type === "line" && it.id && DB.lines[it.id]) {
      const L = DB.lines[it.id]; L.ratings = { ...(L.ratings || {}) }; L.notes = { ...(L.notes || {}) };
      if (it.rating) L.ratings[it.slot] = it.rating;
      if (it.note.trim()) { const prev = (L.notes[it.slot] || "").trim(); L.notes[it.slot] = (prev ? prev + "\n" : "") + t + " " + it.note.trim(); }
      Store.save("lines", L.id, 0); n++;
    } else if (it.type === "store" && it.id) { addObs(it.id, { ...it.obs, slot: it.slot, note: it.note }); n++; }
    else if (it.type === "feedback" && it.note.trim()) { addFeedback(it.note.trim()); n++; }
    else if (it.type === "newstore" && it.name.trim()) {
      const p = me ? { lat: me.lat, lng: me.lng } : (map ? { lat: map.getCenter().getLat(), lng: map.getCenter().getLng() } : null); if (!p) continue;
      const S = put("stores", { name: it.name.trim(), category: "", lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), line_id: (nearestLine(p, 40) || {}).id || null, memo: "위치는 기록 당시 내 위치 (옮겨 주세요)", tags: [], photos: [] });
      addObs(S.id, { ...it.obs, slot: it.slot, note: it.note }); n++;
    }
  }
  put("voice_log", { text: vText, at: now(), slot: vSlot, applied: n, lat: me ? me.lat : null, lng: me ? me.lng : null });
  vMsg = `${n}건 저장했어요.`; vText = ""; vItems = null; renderAll();
}

/* ---------------- 사진 ---------------- */
async function resize(file) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const s = Math.min(1, 1600 / Math.max(img.width, img.height)); const c = document.createElement("canvas");
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return await new Promise(r => c.toBlob(r, "image/jpeg", .8));
}
function photosUI(obj) {
  const ph = obj.photos || [];
  return `<label class="f">사진</label><div class="photos">${ph.map((u, i) => `<div class="ph"><a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt=""></a><button class="x" data-i="${i}">✕</button></div>`).join("")}
    <label class="upl">＋ 사진<input type="file" accept="image/*" id="phIn" hidden multiple></label></div>`;
}
function bindPhotos(obj, t, id) {
  const inp = $("#phIn"); if (!inp) return;
  inp.onchange = async () => {
    for (const f of inp.files) {
      try { toast("사진 올리는 중…", 8000); const url = await Store.uploadPhoto(await resize(f)); obj.photos = [...(obj.photos || []), url]; Store.save(t, id, 0); toast("사진 저장됨"); }
      catch (e) { toast("사진 저장 실패: " + (e.message || e), 4000); }
    }
    panel();
  };
  document.querySelectorAll(".photos .x").forEach(b => b.onclick = () => { obj.photos = obj.photos.filter((_, i) => i !== +b.dataset.i); Store.save(t, id, 0); panel(); });
}

/* ---------------- panels ---------------- */
const chip = r => r ? `<span class="chip" style="background:${COL[r]}">${r}</span>` : `<span class="mut small">—</span>`;
const sortedLines = () => list("lines").sort((a, b) => (a.no || 0) - (b.no || 0));
function nextNo() { let m = 0; for (const L of list("lines")) m = Math.max(m, +L.no || 0); return m + 1; }
const back = (el, label = "목록") => `<button class="btn" id="back">${label}</button>`;
function bindBack() { const b = $("#back"); if (b) b.onclick = () => { sel = null; view = "home"; if ($("#sheet").classList.contains("max")) sheetSize("mid"); renderAll(); }; }
function confirmUI(msg, label) { return `<div class="row" style="margin-top:16px;justify-content:space-between"><span class="mut small">입력하면 자동 저장돼요</span><button class="btn danger" id="del">${label}</button></div><div class="confirm" id="cf">${msg}<div class="row" style="margin-top:6px"><button class="btn danger" id="delY">삭제</button><button class="btn" id="delN">취소</button></div></div>`; }
function bindDel(fn) { $("#del").onclick = () => $("#cf").style.display = "block"; $("#delN").onclick = () => $("#cf").style.display = "none"; $("#delY").onclick = () => { sel = null; view = "home"; fn(); renderAll(); }; }
function panel() {
  const el = $("#panel");
  const V = { feedback: feedbackPanel, setup: setupPanel, login: loginPanel, redraw: redrawPanel, add: addPanel, voice: voicePanel, search: searchPanel, table: tablePanel, menu: menuPanel, regions: regionsPanel };
  if (V[view]) return V[view](el);
  if (view === "draw" || mode === "line") return drawPanel(el);
  if (view === "line" && sel && DB.lines[sel.id]) return linePanel(el, sel.id);
  if (view === "store" && sel && DB.stores[sel.id]) return storePanel(el, sel.id);
  if (view === "listing" && sel && DB.listings[sel.id]) return listingPanel(el, sel.id);
  if (view === "pin" && sel && DB.pins[sel.id]) return pinPanel(el, sel.id);
  return homePanel(el);
}
let homeTab = localStorage.getItem("homeTab") || "line";
function homePanel(el) {
  const L = sortedLines(), S = list("stores"), X = list("listings"), P = list("pins").filter(p => p.slot === "all" || p.slot === slot);
  const tabs = [["line", "라인", L.length], ["store", "매장", S.length], ["listing", "매물", X.length], ["pin", "메모", P.length]];
  let body = "";
  if (homeTab === "line") body = L.map(L => `<div class="it" data-l="${L.id}"><span class="dot">${esc(L.no)}</span><div style="flex:1"><div>${esc(L.name)} ${chip((L.ratings || {})[slot] || "")}</div><div class="mut small">${esc(L.zone || "")}${(L.notes || {})[slot] ? " · " + esc(L.notes[slot].split("\n").slice(-1)[0].slice(0, 70)) : ""}</div></div></div>`).join("") || `<div class="mut">아직 라인이 없어요. 오른쪽 ／ 버튼으로 그려 보세요.</div>`;
  if (homeTab === "store") body = S.sort((a, b) => a.name.localeCompare(b.name, "ko")).map(S => { const o = latestObs(S.id, slot), st = obsState(o); return `<div class="it" data-s="${S.id}"><span class="dot" style="background:${st.c};color:${st.c === "#ffffff" ? "#1d2430" : "#fff"};border:1px solid #ccd">${st.icon || ""}</span><div style="flex:1"><div>${esc(S.name || "(이름 없음)")} <span class="mut small">${esc(S.category || "")}</span></div><div class="mut small">${slotName(slot)}: ${esc(obsText(o))}${o ? " · " + md(o.at) + " " + hhmm(o.at) : ""}</div></div></div>`; }).join("") || `<div class="mut">아직 매장이 없어요. 검색해서 '매장으로 추가'하거나 ＋ 버튼으로 추가하세요.</div>`;
  if (homeTab === "listing") body = X.sort((a, b) => (a.status === "탈락") - (b.status === "탈락")).map(P => `<div class="it" data-x="${P.id}"><span class="dot" style="background:#b42318">₩</span><div style="flex:1"><div>${esc(P.title || P.address || "(매물)")} <span class="tagx">${esc(P.status || "")}</span></div><div class="mut small">보증 ${won(num(P.deposit))} · 월 ${won(num(P.rent))}${num(P.premium) ? " · 권리 " + won(num(P.premium)) : ""}${num(P.area_ex) ? " · 전용 " + num(P.area_ex) + "평" : ""}</div></div></div>`).join("") || `<div class="mut">아직 매물이 없어요. ＋ 버튼 → 매물로 추가하세요.</div>`;
  if (homeTab === "pin") body = P.map(p => `<div class="it" data-p="${p.id}"><span class="dot" style="background:#0f766e">✎</span><div style="flex:1"><div>${esc(p.title || "(제목 없음)")}</div><div class="mut small">${esc((p.text || "").slice(0, 80))}</div></div></div>`).join("") || `<div class="mut small">이 시간대 메모 없음</div>`;
  el.innerHTML = `<div class="htabs">${tabs.map(([k, t, n]) => `<button data-h="${k}" class="${homeTab === k ? "on" : ""}">${t} <b>${n}</b></button>`).join("")}</div>
    <div class="row small mut" style="margin:2px 0 6px;gap:12px">지도에 표시: ${tabs.map(([k, t]) => `<label><input type="checkbox" data-ly="${k}" ${layers[k] ? "checked" : ""}> ${t}</label>`).join("")}</div>
    <div class="list">${body}</div>`;
  el.querySelectorAll("[data-h]").forEach(b => b.onclick = () => { homeTab = b.dataset.h; localStorage.setItem("homeTab", homeTab); panel(); });
  el.querySelectorAll("[data-ly]").forEach(c => c.onchange = () => { layers[c.dataset.ly] = c.checked; localStorage.setItem("layers", JSON.stringify(layers)); renderMap(); });
  el.querySelectorAll("[data-l]").forEach(d => d.onclick = () => { const L = DB.lines[d.dataset.l]; select("line", L.id); const p = L.pts?.[Math.floor((L.pts.length - 1) / 2)]; if (p) panTo(p.lat, p.lon); });
  el.querySelectorAll("[data-s]").forEach(d => d.onclick = () => { const S = DB.stores[d.dataset.s]; select("store", S.id); panTo(S.lat, S.lng); });
  el.querySelectorAll("[data-x]").forEach(d => d.onclick = () => { const P = DB.listings[d.dataset.x]; select("listing", P.id); panTo(P.lat, P.lng); });
  el.querySelectorAll("[data-p]").forEach(d => d.onclick = () => { const p = DB.pins[d.dataset.p]; select("pin", p.id); panTo(p.lat, p.lng); });
}
function zoneNames() { const R = DB.regions[region]; return [...new Set([...((R && R.zones) || []).map(z => z.name), "몰", "영역 밖"])]; }
function addPanel(el) {
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>무엇을 추가할까요?</h2>${back(el, "닫기")}</div>
   <div class="sub">고른 뒤 지도에서 위치를 누르세요. ${me ? "'지금 내 위치에'를 누르면 바로 만들어져요." : ""}</div>
   <div class="list">${[["store", "매장", "상호별 시간대 영업·혼잡 기록"], ["listing", "매물", "보증금·월세·평수·상태 관리"], ["pin", "메모", "현장 특징·사진 메모"]].map(([k, t, d]) => `<div class="it"><div style="flex:1"><b>${t}</b><div class="mut small">${d}</div></div><button class="btn" data-k="${k}">지도에서 위치 고르기</button>${me ? `<button class="btn" data-me="${k}">지금 내 위치에</button>` : ""}</div>`).join("")}</div>
   <div class="mut small" style="margin-top:8px">라인은 오른쪽 ／ 버튼으로 그려요. 매장은 위 검색창에서 상호를 찾아 '매장으로 추가'하면 위치가 정확해요.</div>`;
  bindBack();
  el.querySelectorAll("[data-k]").forEach(b => b.onclick = () => setMode("add", b.dataset.k));
  el.querySelectorAll("[data-me]").forEach(b => b.onclick = () => addAt(b.dataset.me, +me.lat.toFixed(6), +me.lng.toFixed(6)));
}
function drawPanel(el) {
  el.innerHTML = `<h2>새 라인 그리기</h2><div class="sub">점 ${draft.length}개 찍음 · 점 1개면 지점(사거리·몰)으로 저장돼요</div>
   <label class="f">라인 이름</label><input type="text" id="dName" value="${esc(dName)}" placeholder="예: 6로 북측 면 (옥소반 라인)">
   <label class="f">구역</label><input type="text" id="dZone" value="${esc(dZone)}" list="zl"><datalist id="zl">${zoneNames().map(z => `<option value="${esc(z)}">`).join("")}</datalist>
   <div class="row" style="margin-top:14px;flex-wrap:wrap"><button class="btn pri" id="dOk" ${draft.length ? "" : "disabled"}>라인 만들기</button><button class="btn" id="dUndo" ${draft.length ? "" : "disabled"}>마지막 점 취소</button>${me ? `<button class="btn" id="dMe">내 위치를 점으로</button>` : ""}<button class="btn" id="dCancel">그만두기</button></div>`;
  $("#dName").oninput = e => dName = e.target.value; $("#dZone").oninput = e => dZone = e.target.value;
  $("#dUndo").onclick = () => { draft.pop(); renderDraft(); panel(); };
  const dm = $("#dMe"); if (dm) dm.onclick = () => { draft.push({ lat: +me.lat.toFixed(6), lon: +me.lng.toFixed(6) }); renderDraft(); panel(); };
  $("#dCancel").onclick = () => setMode("sel");
  $("#dOk").onclick = () => {
    const one = draft.length === 1;
    const L = put("lines", { no: nextNo(), name: dName.trim() || "새 라인", zone: dZone.trim(), kind: one ? "node" : "line", pts: draft.slice(), r_m: one ? 35 : null, ratings: { wl: "", wd: "", sl: "", sd: "" }, notes: { wl: "", wd: "", sl: "", sd: "" }, tags: [], memo: "", photos: [] });
    setMode("sel"); select("line", L.id);
  };
}
function linePanel(el, id) {
  const L = DB.lines[id]; L.ratings = L.ratings || {}; L.notes = L.notes || {}; L.tags = L.tags || [];
  const stores = list("stores").filter(S => S.line_id === id);
  const lst = list("listings").filter(P => P.line_id === id);
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2><span class="dot" style="margin-right:6px">${esc(L.no)}</span>라인</h2>${back(el)}</div>
   <label class="f">라인 이름</label><input type="text" id="lName" value="${esc(L.name)}">
   <label class="f">구역</label><input type="text" id="lZone" value="${esc(L.zone || "")}" list="zl2"><datalist id="zl2">${zoneNames().map(z => `<option value="${esc(z)}">`).join("")}</datalist>
   <label class="f">${slotName(slot)} 유동인구</label>
   <div class="rate">${["많음","보통","적음",""].map(v => `<button data-v="${v}" class="${(L.ratings[slot] || "") === v ? "on" : ""}">${v || "미기입"}</button>`).join("")}</div>
   <div class="mini">${SLOTS.map(([k, t]) => `<div data-s="${k}" class="${k === slot ? "cur" : ""}" style="background:${L.ratings[k] ? COL[L.ratings[k]] + "33" : "#f1f2f4"}">${t}<br><b>${L.ratings[k] || "—"}</b></div>`).join("")}</div>
   <label class="f">${slotName(slot)} 관찰 메모</label>
   <div class="row"><textarea id="lNote" placeholder="예: 12:05 만석·웨이팅 3팀, 직장인 위주">${esc(L.notes[slot] || "")}</textarea><button class="btn mic" id="m1">🎤</button></div>
   <label class="f">특징 태그</label><div class="tags">${[...new Set([...TAGS, ...L.tags])].map(t => `<span class="tag ${L.tags.includes(t) ? "on" : ""}" data-t="${esc(t)}">${esc(t)}</span>`).join("")}</div>
   <input type="text" id="newTag" placeholder="태그 직접 추가 후 Enter" style="margin-top:6px">
   <label class="f">라인 특징 메모 (시간대 공통)</label>
   <div class="row"><textarea id="lMemo" placeholder="예: 북향, 1층 임대문의 4곳, 버스정류장 앞">${esc(L.memo || "")}</textarea><button class="btn mic" id="m2">🎤</button></div>
   ${stores.length ? `<label class="f">이 라인 매장 ${stores.length}개 (${slotName(slot)})</label><div class="list">${stores.map(S => `<div class="it" data-s="${S.id}"><span class="dot" style="background:${obsState(latestObs(S.id, slot)).c};border:1px solid #ccd"></span><div style="flex:1">${esc(S.name)} <span class="mut small">${esc(obsText(latestObs(S.id, slot)))}</span></div></div>`).join("")}</div>` : ""}
   ${lst.length ? `<label class="f">이 라인 매물 ${lst.length}개</label><div class="list">${lst.map(P => `<div class="it" data-x="${P.id}"><span class="dot" style="background:#b42318">₩</span><div style="flex:1">${esc(P.title || P.address)} <span class="mut small">${won(num(P.deposit))}/${won(num(P.rent))}</span></div></div>`).join("")}</div>` : ""}
   ${photosUI(L)}
   ${L.kind === "line" ? `<div class="row" style="margin-top:12px"><button class="btn" id="reDraw">선 모양 다시 그리기</button></div>` : `<label class="f">지점 크기 (미터)</label><input type="text" id="lR" inputmode="numeric" value="${esc(L.r_m || 35)}">`}
   ${confirmUI("이 라인과 네 시간대 메모를 모두 지울까요?", "라인 삭제")}`;
  bindBack();
  $("#lName").oninput = e => { L.name = e.target.value; Store.save("lines", id); };
  $("#lZone").oninput = e => { L.zone = e.target.value; Store.save("lines", id); };
  el.querySelectorAll(".rate button").forEach(b => b.onclick = () => { L.ratings = { ...L.ratings, [slot]: b.dataset.v }; Store.save("lines", id, 0); renderAll(); });
  el.querySelectorAll(".mini div").forEach(d => d.onclick = () => setSlot(d.dataset.s));
  $("#lNote").oninput = e => { L.notes = { ...L.notes, [slot]: e.target.value }; Store.save("lines", id); };
  $("#lMemo").oninput = e => { L.memo = e.target.value; Store.save("lines", id); };
  el.querySelectorAll(".tag").forEach(t => t.onclick = () => { const v = t.dataset.t; L.tags = L.tags.includes(v) ? L.tags.filter(x => x !== v) : [...L.tags, v]; Store.save("lines", id, 0); panel(); });
  $("#newTag").onkeydown = e => { if (e.key === "Enter" && e.target.value.trim()) { e.preventDefault(); const v = e.target.value.trim(); if (!L.tags.includes(v)) L.tags = [...L.tags, v]; Store.save("lines", id, 0); panel(); } };
  mic($("#m1"), $("#lNote")); mic($("#m2"), $("#lMemo"));
  el.querySelectorAll("[data-s]").forEach(d => { if (d.classList.contains("it")) d.onclick = () => select("store", d.dataset.s); });
  el.querySelectorAll("[data-x]").forEach(d => d.onclick = () => select("listing", d.dataset.x));
  bindPhotos(L, "lines", id);
  const rd = $("#reDraw"); if (rd) rd.onclick = () => { reDrawId = id; mode = "line"; draft = []; view = "redraw"; hint("새 선 모양을 따라 점을 찍고 '모양 저장'을 누르세요."); redrawPanel(el); };
  const lr = $("#lR"); if (lr) lr.oninput = e => { const v = parseInt(e.target.value, 10); if (v > 0) { L.r_m = v; Store.save("lines", id); renderMap(); } };
  bindDel(() => Store.remove("lines", id));
}
let reDrawId = null;
function redrawPanel(el) {
  el.innerHTML = `<h2>선 모양 다시 그리기</h2><div class="sub">점 ${draft.length}개 · 판정과 메모는 그대로 유지돼요</div>
   <div class="row" style="margin-top:10px"><button class="btn pri" id="rOk" ${draft.length > 1 ? "" : "disabled"}>모양 저장</button><button class="btn" id="rUndo">마지막 점 취소</button><button class="btn" id="rCancel">취소</button></div>`;
  $("#rOk").onclick = () => { DB.lines[reDrawId].pts = draft.slice(); Store.save("lines", reDrawId, 0); const id = reDrawId; reDrawId = null; mode = "sel"; draft = []; hint(""); select("line", id); };
  $("#rUndo").onclick = () => { draft.pop(); renderDraft(); redrawPanel(el); };
  $("#rCancel").onclick = () => { const id = reDrawId; reDrawId = null; mode = "sel"; draft = []; hint(""); select("line", id); };
}
let obsDraft = {};
function storePanel(el, id) {
  const S = DB.stores[id]; const obs = obsOf(id);
  const grid = SLOTS.map(([k, t]) => { const o = obs.find(o => o.slot === k); const st = obsState(o); return `<div data-s="${k}" class="${k === slot ? "cur" : ""}" style="background:${o ? st.c + "33" : "#f1f2f4"}">${t}<br><b>${esc(o ? obsText(o) : "—")}</b>${o ? `<br><span class="mut">${md(o.at)} ${hhmm(o.at)}</span>` : ""}</div>`; }).join("");
  const d = obsDraft;
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>매장</h2>${back(el)}</div>
   <label class="f">상호</label><input type="text" id="sName" value="${esc(S.name)}" placeholder="예: 비바나폴리">
   <div class="row" style="gap:8px"><div style="flex:1"><label class="f">업종</label><input type="text" id="sCat" value="${esc(S.category || "")}" placeholder="예: 피자"></div>
   <div style="flex:1"><label class="f">라인</label><select id="sLine"><option value="">(없음)</option>${sortedLines().map(L => `<option value="${L.id}" ${S.line_id === L.id ? "selected" : ""}>${esc(L.no + ". " + L.name)}</option>`).join("")}</select></div></div>
   <label class="f">시간대별 최근 기록</label><div class="mini">${grid}</div>
   <div class="obsbox"><b>지금 기록하기</b> <span class="mut small">${md(now())} ${hhmm()} · ${slotName(slotOf())}</span>
    <div class="rate" style="margin-top:6px">${OPEN.map(v => `<button data-o="${v}" class="${(d.open || "") === v ? "on" : ""}">${v}</button>`).join("")}</div>
    <div class="rate" style="margin-top:6px">${[["10","한산"],["30","30%"],["50","절반"],["80","80%"],["100","만석"]].map(([v, t]) => `<button data-p="${v}" class="${String(d.pct ?? "") === v ? "on" : ""}">${t}</button>`).join("")}</div>
    <div class="row" style="margin-top:6px"><label class="small">웨이팅</label><input type="text" id="oWait" inputmode="numeric" style="width:70px" value="${esc(d.wait || "")}" placeholder="팀"><label class="small">손님</label><input type="text" id="oTeams" inputmode="numeric" style="width:70px" value="${esc(d.teams || "")}" placeholder="팀"></div>
    <div class="row" style="margin-top:6px"><input type="text" id="oNote" value="${esc(d.note || "")}" placeholder="메모 (예: 야장만 비어 있음, 가족 손님)"><button class="btn mic" id="m4">🎤</button></div>
    <button class="btn pri" id="oSave" style="width:100%;margin-top:8px">기록 저장</button></div>
   <label class="f">기록 ${obs.length}건</label>
   <div class="list">${obs.slice(0, 30).map(o => `<div class="it" style="cursor:default"><span class="dot" style="background:${obsState(o).c};border:1px solid #ccd;color:#fff">${obsState(o).icon}</span><div style="flex:1"><div>${md(o.at)} ${hhmm(o.at)} · ${slotName(o.slot)} · <b>${esc(obsText(o))}</b></div>${o.note ? `<div class="mut small">${esc(o.note)}</div>` : ""}</div><button class="btn small" data-od="${o.id}">✕</button></div>`).join("") || `<div class="mut small">아직 기록이 없어요</div>`}</div>
   <label class="f">매장 메모</label><textarea id="sMemo" placeholder="예: 같은 사장님 매장, 화요일 휴무">${esc(S.memo || "")}</textarea>
   ${S.place && S.place.place_url ? `<div class="mut small" style="margin-top:6px"><a href="${esc(S.place.place_url)}" target="_blank" rel="noopener">카카오맵 상세</a> · ${esc(S.place.road_address_name || S.place.address_name || "")}</div>` : ""}
   ${photosUI(S)}
   <div class="row" style="margin-top:10px"><button class="btn" id="sMove">위치 옮기기</button></div>
   ${confirmUI("이 매장과 기록을 모두 지울까요?", "매장 삭제")}`;
  bindBack();
  $("#sName").oninput = e => { S.name = e.target.value; Store.save("stores", id); };
  $("#sName").onchange = () => renderMap();
  $("#sCat").oninput = e => { S.category = e.target.value; Store.save("stores", id); };
  $("#sLine").onchange = e => { S.line_id = e.target.value || null; Store.save("stores", id, 0); };
  $("#sMemo").oninput = e => { S.memo = e.target.value; Store.save("stores", id); };
  el.querySelectorAll(".mini div").forEach(x => x.onclick = () => setSlot(x.dataset.s));
  el.querySelectorAll("[data-o]").forEach(b => b.onclick = () => { d.open = d.open === b.dataset.o ? "" : b.dataset.o; panel(); });
  el.querySelectorAll("[data-p]").forEach(b => b.onclick = () => { d.pct = String(d.pct) === b.dataset.p ? null : +b.dataset.p; if (d.pct != null && !d.open) d.open = "영업"; panel(); });
  $("#oWait").oninput = e => d.wait = parseInt(e.target.value, 10) || null;
  $("#oTeams").oninput = e => d.teams = parseInt(e.target.value, 10) || null;
  $("#oNote").oninput = e => d.note = e.target.value;
  mic($("#m4"), $("#oNote"));
  $("#oSave").onclick = () => {
    if (!d.open && d.pct == null && !d.wait && !d.teams && !(d.note || "").trim()) return toast("영업 여부나 혼잡도를 골라 주세요");
    addObs(id, { open: d.open || "영업", pct: d.pct, is_full: d.pct === 100, wait: d.wait, teams: d.teams, note: (d.note || "").trim() });
    obsDraft = {}; toast("기록했어요"); renderAll();
  };
  el.querySelectorAll("[data-od]").forEach(b => b.onclick = () => { Store.remove("store_obs", b.dataset.od); renderAll(); });
  $("#sMove").onclick = () => { moveId = { t: "stores", id }; hint("새 위치를 지도에서 누르세요."); mode = "move"; };
  bindPhotos(S, "stores", id);
  bindDel(() => { obs.forEach(o => Store.remove("store_obs", o.id)); Store.remove("stores", id); });
}
let moveId = null;
function listingPanel(el, id) {
  const P = DB.listings[id];
  const ex = num(P.area_ex), rent = num(P.rent), mg = num(P.mgmt);
  const perPy = ex && rent ? (rent / ex).toFixed(1) : null;
  const F = (k, label, ph, unit, mode = "decimal") => `<div style="flex:1"><label class="f">${label}${unit ? ` <span class="mut">(${unit})</span>` : ""}</label><input type="text" data-f="${k}" inputmode="${mode}" value="${esc(P[k] ?? "")}" placeholder="${ph}"></div>`;
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>매물</h2>${back(el)}</div>
   <label class="f">이름</label><input type="text" id="xTitle" data-f="title" value="${esc(P.title || "")}" placeholder="예: 이너매스1 코너 (현 이춘명숙성회)">
   <label class="f">주소</label><input type="text" data-f="address" value="${esc(P.address || "")}">
   <label class="f">상태</label><div class="rate wrap">${LST_STATUS.map(s => `<button data-st="${s}" class="${P.status === s ? "on" : ""}">${s}</button>`).join("")}</div>
   <div class="row" style="gap:8px">${F("deposit", "보증금", "10000", "만원")}${F("rent", "월세", "735", "만원")}</div>
   <div class="row" style="gap:8px">${F("premium", "권리금", "3000", "만원")}${F("mgmt", "관리비", "", "만원/월")}</div>
   <div class="row" style="gap:8px">${F("area_ex", "전용", "31", "평")}${F("area_ct", "계약", "69", "평")}</div>
   <div class="row" style="gap:8px">${F("floor", "층", "1층", "", "text")}${F("source", "출처", "네이버부동산·중개사", "", "text")}</div>
   <div class="kv">${perPy ? `전용 평당 월세 <b>${perPy}만</b>` : ""}${rent ? ` · 월 고정비(월세${mg ? "+관리비" : ""}) <b>${won(rent + (mg || 0))}</b>` : ""}</div>
   <label class="f">라인</label><select id="xLine"><option value="">(없음)</option>${sortedLines().map(L => `<option value="${L.id}" ${P.line_id === L.id ? "selected" : ""}>${esc(L.no + ". " + L.name)}</option>`).join("")}</select>
   ${P.line_id && DB.lines[P.line_id] ? `<div class="mini" style="margin-top:6px">${SLOTS.map(([k, t]) => { const r = (DB.lines[P.line_id].ratings || {})[k]; return `<div style="background:${r ? COL[r] + "33" : "#f1f2f4"}">${t}<br><b>${r || "—"}</b></div>`; }).join("")}</div>` : ""}
   <label class="f">메모</label><div class="row"><textarea data-f="memo" placeholder="예: 주차 원활, 공실 리스크, 중개사 연락처">${esc(P.memo || "")}</textarea><button class="btn mic" id="m5">🎤</button></div>
   ${photosUI(P)}
   <div class="row" style="margin-top:10px"><button class="btn" id="xMove">위치 옮기기</button></div>
   ${confirmUI("이 매물을 지울까요?", "매물 삭제")}`;
  bindBack();
  el.querySelectorAll("[data-f]").forEach(i => i.oninput = e => { P[i.dataset.f] = e.target.value; Store.save("listings", id); if (["rent", "area_ex", "mgmt"].includes(i.dataset.f)) { const kv = el.querySelector(".kv"); const ex = num(P.area_ex), rent = num(P.rent), mg = num(P.mgmt); kv.innerHTML = (ex && rent ? `전용 평당 월세 <b>${(rent / ex).toFixed(1)}만</b>` : "") + (rent ? ` · 월 고정비 <b>${won(rent + (mg || 0))}</b>` : ""); } });
  el.querySelectorAll("[data-f]").forEach(i => i.onchange = () => renderMap());
  el.querySelectorAll("[data-st]").forEach(b => b.onclick = () => { P.status = b.dataset.st; Store.save("listings", id, 0); renderAll(); });
  $("#xLine").onchange = e => { P.line_id = e.target.value || null; Store.save("listings", id, 0); panel(); };
  mic($("#m5"), el.querySelector('textarea[data-f="memo"]'));
  $("#xMove").onclick = () => { moveId = { t: "listings", id }; hint("새 위치를 지도에서 누르세요."); mode = "move"; };
  bindPhotos(P, "listings", id);
  bindDel(() => Store.remove("listings", id));
}
function pinPanel(el, id) {
  const p = DB.pins[id];
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>메모</h2>${back(el)}</div>
   <label class="f">제목</label><input type="text" id="pTitle" value="${esc(p.title || "")}" placeholder="예: 9번 출구 앞 버스정류장">
   <label class="f">보이는 시간대</label><select id="pSlot"><option value="all">전체 시간대</option>${SLOTS.map(([k, t]) => `<option value="${k}" ${p.slot === k ? "selected" : ""}>${t}</option>`).join("")}</select>
   <label class="f">내용</label><div class="row"><textarea id="pText">${esc(p.text || "")}</textarea><button class="btn mic" id="m3">🎤</button></div>
   ${photosUI(p)}
   <div class="mut small" style="margin-top:8px">${p.created_at ? "작성 " + new Date(p.created_at).toLocaleString("ko-KR") : ""}</div>
   ${confirmUI("이 메모를 지울까요?", "메모 삭제")}`;
  bindBack();
  $("#pTitle").oninput = e => { p.title = e.target.value; Store.save("pins", id); };
  $("#pTitle").onchange = () => renderMap();
  $("#pSlot").onchange = e => { p.slot = e.target.value; Store.save("pins", id, 0); renderAll(); };
  $("#pText").oninput = e => { p.text = e.target.value; Store.save("pins", id); };
  mic($("#m3"), $("#pText")); bindPhotos(p, "pins", id);
  bindDel(() => Store.remove("pins", id));
}
function voicePanel(el) {
  if (!vSlot) vSlot = slotOf();
  const lines = sortedLines(), stores = list("stores").sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const near = me ? nearestLine(me) : null;
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>🎤 음성 기입</h2>${back(el, "닫기")}</div>
   <div class="sub">걸으면서 말하면 라인·매장별로 나눠 드려요. 저장 전에 확인할 수 있어요.<br>예: "옥소반 라인 유동 보통, 비바나폴리 만석 웨이팅 3팀, 마가렛 휴무"</div>
   <div class="row" style="gap:8px"><select id="vSlot" style="flex:1">${SLOTS.map(([k, t]) => `<option value="${k}" ${k === vSlot ? "selected" : ""}>${t}</option>`).join("")}</select>
    <span class="mut small" style="flex:1.4">${me ? (near ? `내 위치: <b>${esc(near.no + ". " + near.name)}</b> 근처` : "내 위치 근처 라인 없음") : `<a href="#" id="vLoc">내 위치 켜기</a> (이름 안 말해도 근처 라인에 붙어요)`}</span></div>
   <div class="row" style="align-items:flex-start;margin-top:8px"><textarea id="vText" style="min-height:110px" placeholder="${SR ? "🎤를 누르고 말하세요. 다시 누르면 멈춰요" : "키보드의 🎤(받아쓰기)로 말하세요"}">${esc(vText)}</textarea>${SR ? `<button class="btn mic big" id="vMic" title="음성 입력">🎤</button>` : ""}</div>
   <div id="vLive" class="mut small" style="min-height:18px"></div>
   <div class="row"><button class="btn pri" id="vGo">정리하기</button>${vItems ? `<button class="btn" id="vReset">다시 쓰기</button>` : ""}</div>
   ${vMsg ? `<div class="sub" style="margin-top:8px;color:var(--acc)">${esc(vMsg)}</div>` : ""}
   ${vItems && vItems.length ? `<h2 style="margin-top:14px">확인 후 저장</h2>${vItems.map((it, i) => `<div class="vi ${it.on ? "" : "off"}" data-i="${i}">
      <div class="row"><input type="checkbox" class="vOn" ${it.on ? "checked" : ""}>
       <select class="vType" style="width:auto"><option value="line" ${it.type === "line" ? "selected" : ""}>라인</option><option value="store" ${it.type === "store" ? "selected" : ""}>매장</option><option value="newstore" ${it.type === "newstore" ? "selected" : ""}>새 매장</option><option value="feedback" ${it.type === "feedback" ? "selected" : ""}>개선 요청</option></select>
       ${it.type === "line" ? `<select class="vId" style="flex:1"><option value="">— 라인 선택 —</option>${lines.map(L => `<option value="${L.id}" ${L.id === it.id ? "selected" : ""}>${esc(L.no + ". " + L.name)}</option>`).join("")}</select>`
        : it.type === "store" ? `<select class="vId" style="flex:1"><option value="">— 매장 선택 —</option>${stores.map(S => `<option value="${S.id}" ${S.id === it.id ? "selected" : ""}>${esc(S.name)}</option>`).join("")}</select>`
        : it.type === "feedback" ? `<span class="mut small" style="flex:1">앱 개선 요청으로 저장돼요</span>`
        : `<input type="text" class="vName" style="flex:1" value="${esc(it.name || "")}" placeholder="새 매장 이름">`}</div>
      ${it.type === "line" ? `<div class="rate" style="margin-top:6px">${["많음","보통","적음",""].map(v => `<button data-v="${v}" class="${it.rating === v ? "on" : ""}">${v || "판정 없음"}</button>`).join("")}</div>${it.how ? `<div class="mut small">라인은 ${it.how}으로 찾았어요</div>` : ""}`
        : it.type === "feedback" ? "" : `<div class="mut small" style="margin-top:4px">기록: <b>${esc(obsText(it.obs))}</b>${it.type === "newstore" ? " · 위치는 지금 내 위치로 저장돼요" : ""}</div>`}
      <textarea class="vNote" style="min-height:44px;margin-top:6px">${esc(it.note)}</textarea></div>`).join("")}
     <button class="btn pri" id="vSave" style="width:100%;padding:10px">체크한 ${vItems.filter(x => x.on).length}건 저장</button>` : ""}
   ${voiceLogUI()}`;
  bindBack();
  $("#vSlot").onchange = e => { vSlot = e.target.value; if (vItems) vItems.forEach(x => x.slot = vSlot); };
  $("#vText").oninput = e => vText = e.target.value;
  const vl = $("#vLoc"); if (vl) vl.onclick = e => { e.preventDefault(); startWatch(); toast("위치를 찾는 중…"); setTimeout(panel, 3000); };
  const vm = $("#vMic"); if (vm) { if (rec) vm.classList.add("live"); vm.onclick = () => startRec(vm, t => { vText = (vText ? vText.trimEnd() + "\n" : "") + t; const ta = $("#vText"); if (ta) ta.value = vText; }); }
  $("#vGo").onclick = () => { vText = $("#vText").value.trim(); if (!vText) { vMsg = "먼저 말하거나 적어 주세요."; return panel(); } if (rec) rec.stop(); vItems = parseVoice(vText, vSlot); vMsg = vItems.length ? "" : "정리할 내용을 못 찾았어요."; panel(); };
  const rs = $("#vReset"); if (rs) rs.onclick = () => { vItems = null; vMsg = ""; panel(); };
  el.querySelectorAll(".vi").forEach(box => {
    const it = vItems[+box.dataset.i];
    box.querySelector(".vOn").onchange = e => { it.on = e.target.checked; panel(); };
    box.querySelector(".vType").onchange = e => { it.type = e.target.value; it.id = ""; if (it.type !== "line" && !it.obs) it.obs = storeObsIn(it.note) || { open: "영업" }; if (it.type === "newstore" && !it.name) it.name = guessName(it.note); panel(); };
    const s = box.querySelector(".vId"); if (s) s.onchange = e => { it.id = e.target.value; };
    const n = box.querySelector(".vName"); if (n) n.oninput = e => { it.name = e.target.value; };
    box.querySelectorAll(".rate button").forEach(b => b.onclick = () => { it.rating = b.dataset.v; panel(); });
    box.querySelector(".vNote").oninput = e => { it.note = e.target.value; if (it.type !== "line") it.obs = storeObsIn(it.note) || it.obs; };
  });
  const sv = $("#vSave"); if (sv) sv.onclick = vApply;
}
function voiceLogUI() {
  const L = list("voice_log").sort((a, b) => (b.at || "").localeCompare(a.at || "")).slice(0, 8);
  if (!L.length) return "";
  return `<details style="margin-top:14px"><summary class="small mut">최근 음성 원문 ${L.length}건</summary>${L.map(v => `<div class="small" style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="mut">${md(v.at)} ${hhmm(v.at)} · ${slotName(v.slot)} · ${v.applied}건 반영</span><br>${esc(v.text)}</div>`).join("")}</details>`;
}
function searchPanel(el) {
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>검색 결과 ${searchRes.length}개</h2>${back(el, "닫기")}</div>
   <div class="sub">누르면 지도가 이동해요. 버튼으로 바로 매장·매물·메모로 추가할 수 있어요.</div>
   ${searchRes.map((r, i) => { const has = list("stores").find(S => S.place && S.place.id === r.id); return `<div class="res" data-i="${i}"><b>${esc(r.place_name)}</b><span class="mut small">${esc(r.road_address_name || r.address_name)} · ${esc((r.category_name || "").split(" > ").slice(-1)[0])}</span><div class="row" style="margin-top:4px;flex-wrap:wrap">${has ? `<button class="btn" data-open="${has.id}">등록된 매장 열기</button>` : `<button class="btn" data-a="store">매장으로 추가</button>`}<button class="btn" data-a="listing">매물로</button><button class="btn" data-a="pin">메모로</button></div></div>`; }).join("") || `<div class="mut">결과가 없어요</div>`}`;
  bindBack();
  el.querySelectorAll(".res").forEach(d => d.onclick = e => {
    const r = searchRes[+d.dataset.i];
    if (e.target.dataset.open) return select("store", e.target.dataset.open);
    if (e.target.dataset.a) return addAt(e.target.dataset.a, +(+r.y).toFixed(6), +(+r.x).toFixed(6), r);
    panTo(+r.y, +r.x, 2);
  });
}
let tableTab = "line";
function tablePanel(el) {
  let body = "";
  if (tableTab === "line") body = `<table class="cmp"><tr><th>라인</th>${SLOTS.map(s => `<th>${s[1].replace(" ", "<br>")}</th>`).join("")}</tr>
   ${sortedLines().map(L => `<tr data-l="${L.id}"><td><b>${esc(L.no)}</b> ${esc(L.name)}<div class="mut small">${esc(L.zone || "")}${(L.tags || []).length ? " · " + esc(L.tags.join(", ")) : ""}</div></td>${SLOTS.map(([k]) => `<td>${chip((L.ratings || {})[k] || "")}</td>`).join("")}</tr>`).join("")}</table>`;
  if (tableTab === "store") body = `<table class="cmp"><tr><th>매장</th>${SLOTS.map(s => `<th>${s[1].replace(" ", "<br>")}</th>`).join("")}</tr>
   ${list("stores").sort((a, b) => a.name.localeCompare(b.name, "ko")).map(S => `<tr data-s="${S.id}"><td><b>${esc(S.name)}</b><div class="mut small">${esc(S.category || "")}${S.line_id && DB.lines[S.line_id] ? " · " + DB.lines[S.line_id].no + "번 라인" : ""}</div></td>${SLOTS.map(([k]) => { const o = latestObs(S.id, k); return `<td class="small">${o ? `<span class="sdot" style="background:${obsState(o).c}"></span>${esc(obsText(o))}` : `<span class="mut">—</span>`}</td>`; }).join("")}</tr>`).join("")}</table>`;
  if (tableTab === "listing") body = `<table class="cmp"><tr><th>매물</th><th>보증금</th><th>월세</th><th>권리금</th><th>전용</th><th>평당</th><th>상태</th></tr>
   ${list("listings").map(P => { const ex = num(P.area_ex), r = num(P.rent); return `<tr data-x="${P.id}"><td><b>${esc(P.title || P.address || "(매물)")}</b><div class="mut small">${esc(P.floor || "")}${P.line_id && DB.lines[P.line_id] ? " · " + DB.lines[P.line_id].no + "번 라인" : ""}</div></td><td>${won(num(P.deposit))}</td><td>${won(r)}</td><td>${won(num(P.premium))}</td><td>${ex ? ex + "평" : "—"}</td><td>${ex && r ? (r / ex).toFixed(1) : "—"}</td><td class="small">${esc(P.status || "")}</td></tr>`; }).join("")}</table>`;
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>비교표</h2>${back(el, "닫기")}</div>
   <div class="htabs">${[["line", "라인"], ["store", "매장"], ["listing", "매물"]].map(([k, t]) => `<button data-t="${k}" class="${tableTab === k ? "on" : ""}">${t}</button>`).join("")}</div>
   <div style="overflow-x:auto">${body}</div>`;
  bindBack();
  el.querySelectorAll("[data-t]").forEach(b => b.onclick = () => { tableTab = b.dataset.t; panel(); });
  el.querySelectorAll("[data-l]").forEach(d => d.onclick = () => select("line", d.dataset.l));
  el.querySelectorAll("tr[data-s]").forEach(d => d.onclick = () => select("store", d.dataset.s));
  el.querySelectorAll("[data-x]").forEach(d => d.onclick = () => select("listing", d.dataset.x));
}
function download(name, text, type) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
function csv() {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`, row = a => a.map(q).join(",");
  const out = [row(["[라인]"]), row(["번호", "라인", "구역", "종류", ...SLOTS.flatMap(([k, t]) => [t, t + " 메모"]), "태그", "특징 메모"])];
  sortedLines().forEach(L => out.push(row([L.no, L.name, L.zone, L.kind === "node" ? "지점" : "라인", ...SLOTS.flatMap(([k]) => [(L.ratings || {})[k] || "", (L.notes || {})[k] || ""]), (L.tags || []).join(", "), L.memo])));
  out.push("", row(["[매장 기록]"]), row(["매장", "업종", "라인", "일시", "시간대", "영업", "혼잡%", "만석", "웨이팅(팀)", "손님(팀)", "메모"]));
  list("stores").forEach(S => obsOf(S.id).forEach(o => out.push(row([S.name, S.category, S.line_id && DB.lines[S.line_id] ? DB.lines[S.line_id].no : "", new Date(o.at).toLocaleString("ko-KR"), slotName(o.slot), o.open, o.pct ?? "", o.is_full ? "Y" : "", o.wait || "", o.teams || "", o.note]))));
  out.push("", row(["[매물]"]), row(["이름", "주소", "층", "상태", "보증금(만)", "월세(만)", "권리금(만)", "관리비(만)", "전용(평)", "계약(평)", "평당 월세", "출처", "라인", "메모"]));
  list("listings").forEach(P => { const ex = num(P.area_ex), r = num(P.rent); out.push(row([P.title, P.address, P.floor, P.status, P.deposit, P.rent, P.premium, P.mgmt, P.area_ex, P.area_ct, ex && r ? (r / ex).toFixed(1) : "", P.source, P.line_id && DB.lines[P.line_id] ? DB.lines[P.line_id].no : "", P.memo])); });
  out.push("", row(["[메모]"]), row(["제목", "시간대", "내용", "위도", "경도"]));
  list("pins").forEach(p => out.push(row([p.title, slotName(p.slot), p.text, p.lat, p.lng])));
  return "﻿" + out.join("\n");
}
function regionsPanel(el) {
  const R = Object.values(DB.regions).sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>지역</h2>${back(el, "닫기")}</div>
   <div class="list">${R.map(r => { const n = Object.values(DB.lines).filter(L => L.region_id === r.id).length, s = Object.values(DB.stores).filter(S => S.region_id === r.id).length, x = Object.values(DB.listings).filter(P => P.region_id === r.id).length; return `<div class="it" data-r="${r.id}"><span class="dot" style="background:${r.id === region ? "var(--acc)" : "#9aa3ae"}">${r.id === region ? "✓" : ""}</span><div style="flex:1"><b>${esc(r.name)}</b><div class="mut small">라인 ${n} · 매장 ${s} · 매물 ${x}</div></div><button class="btn small" data-rn="${r.id}">이름</button></div>`; }).join("")}</div>
   <h2 style="margin-top:14px">새 지역 만들기</h2><div class="sub">지금 지도 화면 가운데가 지역의 시작 위치가 돼요. 먼저 지도를 그 동네로 옮겨 주세요.</div>
   <div class="row"><input type="text" id="rName" placeholder="예: 철산역, 과천 학원가"><button class="btn pri" id="rAdd">만들기</button></div>`;
  bindBack();
  el.querySelectorAll("[data-r]").forEach(d => d.onclick = e => { if (e.target.dataset.rn) return; setRegion(d.dataset.r); });
  el.querySelectorAll("[data-rn]").forEach(b => b.onclick = () => { const r = DB.regions[b.dataset.rn]; const v = prompt("지역 이름", r.name); if (v && v.trim()) { r.name = v.trim(); Store.save("regions", r.id, 0); setRegion(region, true); panel(); } });
  $("#rAdd").onclick = () => { const name = $("#rName").value.trim(); if (!name) return toast("지역 이름을 적어 주세요"); const c = map ? map.getCenter() : null; const r = put("regions", { name, center: c ? { lat: c.getLat(), lng: c.getLng() } : (CFG.CENTER || {}), level: map ? map.getLevel() : 4, zones: [] }); setRegion(r.id); toast(name + " 지역을 만들었어요"); };
}
function menuPanel(el) {
  const d = new Date().toISOString().slice(0, 10);
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>메뉴</h2>${back(el, "닫기")}</div>
   <div class="sub">${Store.kind === "supa" ? (Store.user ? "클라우드 저장 · " + esc(Store.user.email || "") : "로그인 필요") : "이 기기에만 저장 중 (클라우드 연결 전)"}</div>
   <div class="list">
    <div class="it" id="mFb">💡 앱 개선 요청 남기기·보기 <span class="mut small">(${Object.values(DB.feedback).filter(f => !f.done).length}건 대기)</span></div>
    <div class="it" id="mRegion">지역 바꾸기·새 지역</div>
    <div class="it" id="mZones">구역 경계 ${showZones ? "숨기기" : "보이기"}</div>
    <div class="it" id="mWatch">내 위치 계속 표시 ${watchId != null ? "끄기" : "켜기"}</div>
    <div class="it" id="mCsv">엑셀(CSV)로 내보내기 (라인·매장 기록·매물)</div>
    <div class="it" id="mJson">전체 백업(JSON) 내보내기</div>
    <label class="it" style="cursor:pointer">백업(JSON) 가져오기<input type="file" id="mImp" accept="application/json,.json" hidden></label>
    ${Store.kind === "supa" && Store.user ? `<div class="it" id="mOut">로그아웃</div>` : ""}
   </div>
   <div class="mut small" style="margin-top:14px">폰 홈 화면에 추가: 아이폰은 사파리 공유 → '홈 화면에 추가', 안드로이드는 크롬 메뉴 → '홈 화면에 추가'.</div>`;
  bindBack();
  $("#mRegion").onclick = () => { view = "regions"; panel(); };
  $("#mFb").onclick = () => { view = "feedback"; panel(); };
  $("#mZones").onclick = () => { showZones = !showZones; localStorage.setItem("zones", showZones ? "1" : "0"); drawZones(); panel(); };
  $("#mWatch").onclick = () => { if (watchId != null) stopWatch(); else startWatch(); panel(); };
  $("#mCsv").onclick = () => download(`상권지도_${(DB.regions[region] || {}).name || ""}_${d}.csv`, csv(), "text/csv;charset=utf-8");
  $("#mJson").onclick = () => { const o = {}; TABLES.forEach(t => o[t] = Object.values(DB[t])); download(`상권지도_백업_${d}.json`, JSON.stringify(o, null, 1), "application/json"); };
  $("#mImp").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const j = JSON.parse(await f.text()); let n = 0; for (const t of TABLES) for (const r of (j[t] || [])) { if (!r.id) continue; DB[t][r.id] = r; Store.save(t, r.id, 0); n++; } toast(n + "건 가져왔어요"); afterLoad(); }
    catch (err) { toast("가져오기 실패: " + err.message, 4000); }
  };
  const o = $("#mOut"); if (o) o.onclick = async () => { await Store.sb.auth.signOut(); location.reload(); };
}
function loginPanel(el) {
  el.innerHTML = `<h2>로그인</h2><div class="sub">이메일로 받은 링크를 누르면 로그인돼요. 한 번 로그인하면 이 기기에서 계속 유지돼요.</div>
   <label class="f">이메일</label><input type="email" id="em" autocomplete="email" placeholder="you@example.com">
   <div class="row" style="margin-top:12px"><button class="btn pri" id="go">로그인 링크 받기</button></div><div id="msg" class="sub" style="margin-top:10px"></div>`;
  $("#go").onclick = async () => {
    const email = $("#em").value.trim(); if (!email) return;
    $("#go").disabled = true;
    const { error } = await Store.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    $("#msg").textContent = error ? "실패: " + error.message : "메일함에서 로그인 링크를 눌러 주세요. (스팸함도 확인)";
    $("#go").disabled = false;
  };
}
function addFeedback(text) { return put("feedback", { text, at: now(), view: view, done: false, reply: "" }); }
let fbText = "";
function feedbackPanel(el) {
  const F = Object.values(DB.feedback).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>💡 앱 개선 요청</h2>${back(el, "닫기")}</div>
   <div class="sub">쓰다가 불편한 점, 있었으면 하는 기능을 남겨 두세요. 다음에 Claude를 부르면 모아서 고쳐요.<br>음성 기입에서 "개선 요청 …"으로 시작해도 여기에 쌓여요.</div>
   <div class="row" style="align-items:flex-start"><textarea id="fbT" placeholder="예: 매장 기록할 때 웨이팅 버튼도 있었으면">${esc(fbText)}</textarea><button class="btn mic" id="fbM">🎤</button></div>
   <button class="btn pri" id="fbS" style="margin-top:8px">남기기</button>
   <div class="list" style="margin-top:12px">${F.map(f => `<div class="it" style="cursor:default;${f.done ? "opacity:.5" : ""}"><span class="dot" style="background:${f.done ? "#2e7d32" : "#f0a43a"}">${f.done ? "✓" : "!"}</span><div style="flex:1"><div>${esc(f.text)}</div><div class="mut small">${md(f.at)} ${hhmm(f.at)}${f.reply ? " · " + esc(f.reply) : ""}</div></div><button class="btn small" data-fd="${f.id}">✕</button></div>`).join("") || `<div class="mut small">아직 요청이 없어요</div>`}</div>`;
  bindBack();
  $("#fbT").oninput = e => fbText = e.target.value;
  mic($("#fbM"), $("#fbT"));
  $("#fbS").onclick = () => { const t = $("#fbT").value.trim(); if (!t) return; addFeedback(t); fbText = ""; toast("남겼어요"); panel(); };
  el.querySelectorAll("[data-fd]").forEach(b => b.onclick = () => { Store.remove("feedback", b.dataset.fd); panel(); });
}
function setupPanel(el) {
  el.innerHTML = `<h2>지도를 불러오지 못했어요</h2><div class="sub">인터넷 연결이나 카카오 키의 도메인 등록을 확인해 주세요. 목록·편집은 그대로 쓸 수 있어요.</div>
   <div class="row"><button class="btn" id="cont">목록 보기</button></div>`;
  $("#cont").onclick = () => { view = "home"; panel(); };
}
// 위치 옮기기 모드
const _onMapClick = onMapClick;
onMapClick = function (lat, lon) {
  if (mode === "move" && moveId) { const r = DB[moveId.t][moveId.id]; r.lat = +lat.toFixed(6); r.lng = +lon.toFixed(6); Store.save(moveId.t, r.id, 0); mode = "sel"; hint(""); moveId = null; renderAll(); toast("위치를 옮겼어요"); return; }
  _onMapClick(lat, lon);
};

/* ---------------- start ---------------- */
(async () => {
  if (window.innerWidth >= 900) { toggleSheet(sheetHidden); } else if (sheetHidden) applySheet(HIDE_H, false); else applySheet(clampH(sheetH || Math.round(vh() * 0.42)), false);
  try { await loadKakao(); initMap(); }
  catch (e) { view = "setup"; }
  await Store.init();
  if (view !== "login") renderAll();
  if (localStorage.getItem("watch") === "1") startWatch();
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
})();
