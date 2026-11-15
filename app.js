/* 상권 기입 지도 — 카카오맵 + Supabase PWA */
(() => {
"use strict";
const CFG = window.APP_CONFIG || {};
const SLOTS = [["wl","평일 점심"],["wd","평일 저녁"],["sl","주말 점심"],["sd","주말 저녁"]];
const COL = {"많음":"#D6452B","보통":"#F0A43A","적음":"#7E98B3","":"#9AA3AE"};
const PINCOL = {"관찰":"#0f766e","특징":"#3b2a8f","매물":"#b42318"};
const TAGS = ["직장인","가족·유모차","어르신","커플","주민","퇴근 통행","목적 방문","임대문의 많음","응달·북향","야장","배달 많음","웨이팅"];
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const slotName = k => (SLOTS.find(s => s[0] === k) || [0,"전체"])[1];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "x" + Date.now() + Math.random().toString(16).slice(2));

let slot = localStorage.getItem("slot") || "wl";
let mode = "sel", sel = null, draft = [], view = "home", searchRes = [], showZones = localStorage.getItem("zones") !== "0";
let LINES = {}, PINS = {};
let dName = "", dZone = "";

/* ---------------- toast / hint ---------------- */
let toastT;
function toast(t, ms = 2200) { const el = $("#toast"); el.textContent = t; el.style.display = "block"; clearTimeout(toastT); toastT = setTimeout(() => el.style.display = "none", ms); }
function hint(t) { const h = $("#hint"); h.textContent = t || ""; h.style.display = t ? "block" : "none"; }

/* ---------------- storage ---------------- */
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
    } else {
      this.kind = "local"; this.loadLocal();
    }
  },
  loadLocal() { try { const j = JSON.parse(localStorage.getItem("magok-map-data") || "{}"); LINES = j.lines || {}; PINS = j.pins || {}; } catch (e) {} renderAll(); },
  saveLocal() { try { localStorage.setItem("magok-map-data", JSON.stringify({ lines: LINES, pins: PINS })); } catch (e) { toast("이 기기 저장 공간이 가득 찼어요"); } },
  async load() {
    const [a, b] = await Promise.all([this.sb.from("lines").select("*"), this.sb.from("pins").select("*")]);
    if (a.error || b.error) { toast("불러오기 실패: " + (a.error || b.error).message, 4000); return; }
    LINES = {}; a.data.forEach(r => LINES[r.id] = r);
    PINS = {}; b.data.forEach(r => PINS[r.id] = r);
    renderAll();
    if (!this.ch) {
      this.ch = this.sb.channel("rt")
        .on("postgres_changes", { event: "*", schema: "public", table: "lines" }, p => this.remote("lines", p))
        .on("postgres_changes", { event: "*", schema: "public", table: "pins" }, p => this.remote("pins", p))
        .subscribe();
    }
  },
  remote(table, p) {
    const M = table === "lines" ? LINES : PINS;
    if (p.eventType === "DELETE") { delete M[p.old.id]; }
    else { const r = p.new; if (this.pending[table + r.id]) return; M[r.id] = r; }
    renderAll(true);
  },
  save(table, id, ms = 500) {
    const M = table === "lines" ? LINES : PINS;
    if (!M[id]) return;
    M[id].updated_at = new Date().toISOString();
    if (this.kind === "local") { this.saveLocal(); return; }
    const key = table + id; this.pending[key] = true;
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(() => this.flush(table, id), ms);
  },
  async flush(table, id) {
    const key = table + id; const M = table === "lines" ? LINES : PINS;
    if (this.busy[key]) { this.busy[key] = "again"; return; }
    this.busy[key] = true;
    const row = M[id];
    if (row) { const { error } = await this.sb.from(table).upsert(row); if (error) toast("저장 실패: " + error.message, 4000); }
    const again = this.busy[key] === "again"; delete this.busy[key];
    if (again) return this.flush(table, id);
    setTimeout(() => delete this.pending[key], 1500);
  },
  async remove(table, id) {
    const M = table === "lines" ? LINES : PINS; delete M[id];
    if (this.kind === "local") { this.saveLocal(); return; }
    const { error } = await this.sb.from(table).delete().eq("id", id);
    if (error) toast("삭제 실패: " + error.message, 4000);
  },
  async uploadPhoto(blob) {
    if (this.kind === "local") return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    const path = `${new Date().toISOString().slice(0,10)}/${uid()}.jpg`;
    const { error } = await this.sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg" });
    if (error) throw error;
    return this.sb.storage.from("photos").getPublicUrl(path).data.publicUrl;
  }
};

/* ---------------- map ---------------- */
let map = null, ov = [], draftOv = [], meOv = null, zoneOv = [], ignoreMapClick = 0;
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
  drawZones();
}
function drawZones() {
  zoneOv.forEach(o => o.setMap(null)); zoneOv = [];
  if (!map || !showZones || !window.ZONES) return;
  for (const z of window.ZONES) {
    const pg = new (K().Polygon)({ path: z.pts.map(p => LL(p[0], p[1])), strokeWeight: 1, strokeColor: "#8c9bb5", strokeOpacity: .7, strokeStyle: "shortdash", fillColor: z.name.endsWith("북") ? "#dfe6f3" : "#eef1f6", fillOpacity: .35, zIndex: 0 });
    pg.setMap(map); K().event.addListener(pg, "click", clickShape(null)); zoneOv.push(pg);
    const lat = z.pts.reduce((a, p) => a + p[0], 0) / z.pts.length, lon = z.pts.reduce((a, p) => a + p[1], 0) / z.pts.length;
    const el = document.createElement("div"); el.className = "zl"; el.textContent = z.name;
    const co = new (K().CustomOverlay)({ position: LL(lat, lon), content: el, zIndex: 1 }); co.setMap(map); zoneOv.push(co);
  }
}
// 도형 클릭: 그리기·핀 모드면 지도 클릭으로, 선택 모드면 해당 라인 선택
function clickShape(fn) {
  return e => {
    if (Date.now() < ignoreMapClick) return;
    ignoreMapClick = Date.now() + 350;
    if (mode !== "sel" && e && e.latLng) { onMapClick(e.latLng.getLat(), e.latLng.getLng()); return; }
    if (fn) fn(); else if (e && e.latLng) onMapClick(e.latLng.getLat(), e.latLng.getLng());
  };
}
function renderMap() {
  if (!map) return;
  ov.forEach(o => o.setMap(null)); ov = [];
  const ids = Object.keys(LINES).sort((a, b) => (LINES[a].no || 0) - (LINES[b].no || 0));
  for (const id of ids) {
    const L = LINES[id]; const pts = (L.pts || []).filter(p => p && p.lat && p.lon); if (!pts.length) continue;
    const r = (L.ratings || {})[slot] || ""; const c = COL[r] ?? COL[""]; const on = sel && sel.type === "line" && sel.id === id;
    const pick = clickShape(() => select("line", id));
    let anchor;
    if (L.kind === "node") {
      anchor = LL(pts[0].lat, pts[0].lon);
      const ci = new (K().Circle)({ center: anchor, radius: L.r_m || 35, strokeWeight: on ? 4 : 2, strokeColor: on ? "#3b2a8f" : "#fff", strokeOpacity: 1, fillColor: c, fillOpacity: r ? .8 : .35, zIndex: 3 });
      ci.setMap(map); K().event.addListener(ci, "click", pick); ov.push(ci);
    } else {
      const path = pts.map(p => LL(p.lat, p.lon));
      if (on) { const h = new (K().Polyline)({ path, strokeWeight: 16, strokeColor: "#3b2a8f", strokeOpacity: .35, zIndex: 2 }); h.setMap(map); ov.push(h); }
      const pl = new (K().Polyline)({ path, strokeWeight: 9, strokeColor: c, strokeOpacity: r ? .95 : .7, strokeStyle: r ? "solid" : "shortdash", zIndex: 3 });
      pl.setMap(map); K().event.addListener(pl, "click", pick); ov.push(pl);
      const m = Math.floor((pts.length - 1) / 2), n = Math.ceil((pts.length - 1) / 2);
      anchor = LL((pts[m].lat + pts[n].lat) / 2, (pts[m].lon + pts[n].lon) / 2);
    }
    const el = document.createElement("div"); el.className = "badge" + (on ? " sel" : ""); el.textContent = L.no ?? "•";
    el.onclick = e => { e.stopPropagation(); if (mode === "sel") { ignoreMapClick = Date.now() + 350; select("line", id); } };
    const b = new (K().CustomOverlay)({ position: anchor, content: el, zIndex: on ? 9 : 5, clickable: true }); b.setMap(map); ov.push(b);
  }
  for (const id in PINS) {
    const p = PINS[id]; if (p.slot !== "all" && p.slot !== slot) continue;
    const on = sel && sel.type === "pin" && sel.id === id; const c = PINCOL[p.kind] || "#3b2a8f";
    const el = document.createElement("div"); el.className = "pinm" + (on ? " sel" : ""); el.style.color = c;
    el.innerHTML = `<div class="b"><span style="color:${on ? "#fff" : c}">${esc((p.title || p.kind || "메모").slice(0, 12))}</span></div><div class="t"></div>`;
    el.onclick = e => { e.stopPropagation(); ignoreMapClick = Date.now() + 350; select("pin", id); };
    const co = new (K().CustomOverlay)({ position: LL(p.lat, p.lng), content: el, yAnchor: 0, zIndex: on ? 10 : 6, clickable: true });
    co.setMap(map); ov.push(co);
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
function isEditing() { const a = document.activeElement; return a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && $("#panel").contains(a); }
function panTo(lat, lon, level) { if (!map) return; if (level) map.setLevel(level); map.panTo(LL(lat, lon)); }

/* ---------------- interactions ---------------- */
function onMapClick(lat, lon) {
  lat = +lat.toFixed(6); lon = +lon.toFixed(6);
  if (mode === "line") { draft.push({ lat, lon }); renderDraft(); panel(); return; }
  if (mode === "pin") { newPin(lat, lon); return; }
  if (sel) { sel = null; view = "home"; renderAll(); }
}
function newPin(lat, lng, place) {
  const id = uid();
  PINS[id] = { id, kind: "관찰", title: place ? place.place_name : "", text: place ? (place.road_address_name || place.address_name || "") : "", slot: place ? "all" : slot, lat, lng, place: place || null, photos: [], created_at: new Date().toISOString() };
  Store.save("pins", id, 0); setMode("sel"); select("pin", id);
  setTimeout(() => { const i = $("#pTitle"); if (i && !place) i.focus(); }, 80);
}
function select(type, id) { sel = { type, id }; view = type; renderAll(); sheetSize("mid"); }
function setSlot(k) { slot = k; localStorage.setItem("slot", k); document.querySelectorAll("#slots button").forEach(b => b.classList.toggle("on", b.dataset.s === k)); renderAll(); }
function setMode(m) {
  mode = m; draft = []; dName = ""; dZone = "";
  $("#fLine").classList.toggle("on", m === "line"); $("#fPin").classList.toggle("on", m === "pin");
  hint(m === "line" ? "라인을 따라 지도를 차례로 눌러 점을 찍으세요. 점 1개면 사거리·몰 같은 지점이 돼요." : m === "pin" ? "메모를 남길 위치를 지도에서 누르세요." : "");
  if (m === "line") { sel = null; view = "draw"; sheetSize("mid"); }
  else if (view === "draw") view = "home";
  renderAll();
}
$("#slots").innerHTML = SLOTS.map(([k, t]) => `<button data-s="${k}" class="${k === slot ? "on" : ""}">${t}</button>`).join("");
$("#slots").onclick = e => { const b = e.target.closest("button"); if (b) setSlot(b.dataset.s); };
$("#fLine").onclick = () => setMode(mode === "line" ? "sel" : "line");
$("#fPin").onclick = () => setMode(mode === "pin" ? "sel" : "pin");
$("#fTable").onclick = () => { sel = null; view = view === "table" ? "home" : "table"; sheetSize("max"); renderAll(); };
$("#fMenu").onclick = () => { sel = null; view = view === "menu" ? "home" : "menu"; sheetSize("mid"); renderAll(); };
$("#fLoc").onclick = () => {
  if (!navigator.geolocation) return toast("위치를 쓸 수 없어요");
  navigator.geolocation.getCurrentPosition(p => {
    const { latitude: la, longitude: lo } = p.coords; panTo(la, lo, 3);
    if (map) { if (meOv) meOv.setMap(null); const el = document.createElement("div"); el.className = "me"; meOv = new (K().CustomOverlay)({ position: LL(la, lo), content: el, zIndex: 20 }); meOv.setMap(map); }
  }, () => toast("위치 권한을 확인해 주세요"), { enableHighAccuracy: true, timeout: 10000 });
};
$("#searchForm").onsubmit = e => {
  e.preventDefault(); const q = $("#q").value.trim(); if (!q) return;
  if (!map || !K().services) return toast("지도 키 설정 후 검색할 수 있어요");
  $("#q").blur();
  const ps = new (K().services.Places)();
  ps.keywordSearch(q, (data, status) => {
    searchRes = status === K().services.Status.OK ? data : [];
    sel = null; view = "search"; sheetSize("mid"); panel();
  }, { location: map.getCenter(), radius: 5000, sort: K().services.SortBy.ACCURACY });
};
// bottom sheet
function sheetSize(s) { const el = $("#sheet"); el.classList.toggle("min", s === "min"); el.classList.toggle("max", s === "max"); document.documentElement.style.setProperty("--sheet", s === "min" ? "64px" : s === "max" ? "86vh" : "46vh"); }
$("#grab").onclick = () => { const el = $("#sheet"); sheetSize(el.classList.contains("min") ? "mid" : el.classList.contains("max") ? "min" : "max"); };
document.addEventListener("keydown", e => { if (e.key === "Escape") { if (mode !== "sel") setMode("sel"); else { sel = null; view = "home"; renderAll(); } } });

/* ---------------- voice ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recBtn = null;
function mic(btn, ta) {
  if (!SR) { btn.style.display = "none"; return; }
  btn.onclick = () => {
    if (rec) { rec.stop(); if (recBtn === btn) return; }
    rec = new SR(); rec.lang = "ko-KR"; rec.interimResults = false; rec.continuous = true; recBtn = btn; btn.classList.add("live");
    rec.onresult = ev => { for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) { const t = ev.results[i][0].transcript.trim(); ta.value = (ta.value ? ta.value.trimEnd() + " " : "") + t; ta.dispatchEvent(new Event("input")); } };
    rec.onend = () => { btn.classList.remove("live"); rec = null; recBtn = null; };
    rec.onerror = () => toast("음성 입력을 쓸 수 없어요. 키보드의 마이크를 써 주세요");
    try { rec.start(); } catch (e) { btn.classList.remove("live"); rec = null; }
  };
}

/* ---------------- photos ---------------- */
async function resize(file) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const s = Math.min(1, 1600 / Math.max(img.width, img.height)); const c = document.createElement("canvas");
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return await new Promise(r => c.toBlob(r, "image/jpeg", .8));
}
function photosUI(obj, table, id) {
  const ph = obj.photos || [];
  return `<label class="f">사진</label><div class="photos">${ph.map((u, i) => `<div class="ph"><a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt=""></a><button class="x" data-i="${i}">✕</button></div>`).join("")}
    <label class="upl">＋ 사진<input type="file" accept="image/*" capture="environment" id="phIn" hidden multiple></label></div>`;
}
function bindPhotos(obj, table, id) {
  const inp = $("#phIn"); if (!inp) return;
  inp.onchange = async () => {
    for (const f of inp.files) {
      try { toast("사진 올리는 중…", 8000); const url = await Store.uploadPhoto(await resize(f)); obj.photos = [...(obj.photos || []), url]; Store.save(table, id, 0); toast("사진 저장됨"); }
      catch (e) { toast("사진 저장 실패: " + (e.message || e), 4000); }
    }
    panel();
  };
  document.querySelectorAll(".photos .x").forEach(b => b.onclick = () => { obj.photos = obj.photos.filter((_, i) => i !== +b.dataset.i); Store.save(table, id, 0); panel(); });
}

/* ---------------- panels ---------------- */
const chip = r => r ? `<span class="chip" style="background:${COL[r]}">${r}</span>` : `<span class="mut small">—</span>`;
const sortedLines = () => Object.keys(LINES).sort((a, b) => (LINES[a].no || 0) - (LINES[b].no || 0));
function nextNo() { let m = 0; for (const k in LINES) m = Math.max(m, +LINES[k].no || 0); return m + 1; }
function panel() {
  const el = $("#panel");
  if (view === "setup") return setupPanel(el);
  if (view === "login") return loginPanel(el);
  if (view === "redraw") return redrawPanel(el);
  if (view === "draw" || mode === "line") return drawPanel(el);
  if (view === "line" && sel && LINES[sel.id]) return linePanel(el, sel.id);
  if (view === "pin" && sel && PINS[sel.id]) return pinPanel(el, sel.id);
  if (view === "search") return searchPanel(el);
  if (view === "table") return tablePanel(el);
  if (view === "menu") return menuPanel(el);
  return homePanel(el);
}
function homePanel(el) {
  const ids = sortedLines(); const pins = Object.keys(PINS).filter(id => PINS[id].slot === "all" || PINS[id].slot === slot);
  el.innerHTML = `<h2>${slotName(slot)} · 라인 ${ids.length}개</h2>
   <div class="list">${ids.map(id => { const L = LINES[id]; return `<div class="it" data-l="${id}"><span class="dot">${esc(L.no)}</span><div style="flex:1"><div>${esc(L.name)} ${chip((L.ratings || {})[slot] || "")}</div><div class="mut small">${esc(L.zone || "")}${(L.notes || {})[slot] ? " · " + esc(L.notes[slot].slice(0, 70)) : ""}</div></div></div>`; }).join("") || `<div class="mut">아직 라인이 없어요. 오른쪽 ／ 버튼으로 그려 보세요.</div>`}</div>
   <h2 style="margin-top:16px">메모 핀 ${pins.length}개</h2>
   <div class="list">${pins.map(id => { const p = PINS[id]; return `<div class="it" data-p="${id}"><span class="dot" style="background:${PINCOL[p.kind] || "#3b2a8f"}">${esc((p.kind || "•")[0])}</span><div style="flex:1"><div>${esc(p.title || "(제목 없음)")}</div><div class="mut small">${esc((p.text || "").slice(0, 80))}</div></div></div>`; }).join("") || `<div class="mut small">이 시간대 핀 없음</div>`}</div>`;
  el.querySelectorAll("[data-l]").forEach(d => d.onclick = () => { const L = LINES[d.dataset.l]; select("line", d.dataset.l); const p = L.pts?.[Math.floor((L.pts.length - 1) / 2)]; if (p) panTo(p.lat, p.lon); });
  el.querySelectorAll("[data-p]").forEach(d => d.onclick = () => { const p = PINS[d.dataset.p]; select("pin", d.dataset.p); panTo(p.lat, p.lng); });
}
const ZONES_LIST = ["W 북","W 남","C 북","C 남","E1 북","E1 남","E2 북","E2 남","몰","영역 밖"];
function drawPanel(el) {
  el.innerHTML = `<h2>새 라인 그리기</h2><div class="sub">점 ${draft.length}개 찍음 · 점 1개면 지점(사거리·몰)으로 저장돼요</div>
   <label class="f">라인 이름</label><input type="text" id="dName" value="${esc(dName)}" placeholder="예: 6로 북측 면 (옥소반 라인)">
   <label class="f">구역</label><input type="text" id="dZone" value="${esc(dZone)}" list="zl"><datalist id="zl">${ZONES_LIST.map(z => `<option value="${z}">`).join("")}</datalist>
   <div class="row" style="margin-top:14px;flex-wrap:wrap"><button class="btn pri" id="dOk" ${draft.length ? "" : "disabled"}>라인 만들기</button><button class="btn" id="dUndo" ${draft.length ? "" : "disabled"}>마지막 점 취소</button><button class="btn" id="dCancel">그만두기</button></div>`;
  $("#dName").oninput = e => dName = e.target.value; $("#dZone").oninput = e => dZone = e.target.value;
  $("#dUndo").onclick = () => { draft.pop(); renderDraft(); panel(); };
  $("#dCancel").onclick = () => setMode("sel");
  $("#dOk").onclick = () => {
    const id = uid(), one = draft.length === 1;
    LINES[id] = { id, no: nextNo(), name: dName.trim() || "새 라인", zone: dZone.trim(), kind: one ? "node" : "line", pts: draft.slice(), r_m: one ? 35 : null, ratings: { wl: "", wd: "", sl: "", sd: "" }, notes: { wl: "", wd: "", sl: "", sd: "" }, tags: [], memo: "", photos: [], created_at: new Date().toISOString() };
    Store.save("lines", id, 0); setMode("sel"); select("line", id);
  };
}
function linePanel(el, id) {
  const L = LINES[id]; L.ratings = L.ratings || {}; L.notes = L.notes || {}; L.tags = L.tags || [];
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2><span class="dot" style="margin-right:6px">${esc(L.no)}</span>라인 편집</h2><button class="btn" id="back">목록</button></div>
   <label class="f">라인 이름</label><input type="text" id="lName" value="${esc(L.name)}">
   <label class="f">구역</label><input type="text" id="lZone" value="${esc(L.zone || "")}" list="zl2"><datalist id="zl2">${ZONES_LIST.map(z => `<option value="${z}">`).join("")}</datalist>
   <label class="f">${slotName(slot)} 유동인구</label>
   <div class="rate">${["많음","보통","적음",""].map(v => `<button data-v="${v}" class="${(L.ratings[slot] || "") === v ? "on" : ""}">${v || "미기입"}</button>`).join("")}</div>
   <div class="mini">${SLOTS.map(([k, t]) => `<div data-s="${k}" class="${k === slot ? "cur" : ""}" style="background:${L.ratings[k] ? COL[L.ratings[k]] + "33" : "#f1f2f4"}">${t}<br><b>${L.ratings[k] || "—"}</b></div>`).join("")}</div>
   <label class="f">${slotName(slot)} 관찰 메모</label>
   <div class="row"><textarea id="lNote" placeholder="예: 12:05 만석·웨이팅 3팀, 직장인 위주">${esc(L.notes[slot] || "")}</textarea><button class="btn mic" id="m1">🎤</button></div>
   <label class="f">특징 태그</label><div class="tags">${[...new Set([...TAGS, ...L.tags])].map(t => `<span class="tag ${L.tags.includes(t) ? "on" : ""}" data-t="${esc(t)}">${esc(t)}</span>`).join("")}</div>
   <input type="text" id="newTag" placeholder="태그 직접 추가 후 Enter" style="margin-top:6px">
   <label class="f">라인 특징 메모 (시간대 공통)</label>
   <div class="row"><textarea id="lMemo" placeholder="예: 북향, 1층 임대문의 4곳, 버스정류장 앞">${esc(L.memo || "")}</textarea><button class="btn mic" id="m2">🎤</button></div>
   ${photosUI(L)}
   ${L.kind === "line" ? `<div class="row" style="margin-top:12px"><button class="btn" id="reDraw">선 모양 다시 그리기</button></div>` : `<label class="f">지점 크기 (미터)</label><input type="text" id="lR" inputmode="numeric" value="${esc(L.r_m || 35)}">`}
   <div class="row" style="margin-top:16px;justify-content:space-between"><span class="mut small">입력하면 자동 저장돼요</span><button class="btn danger" id="del">라인 삭제</button></div>
   <div class="confirm" id="cf">이 라인과 네 시간대 메모를 모두 지울까요?<div class="row" style="margin-top:6px"><button class="btn danger" id="delY">삭제</button><button class="btn" id="delN">취소</button></div></div>`;
  $("#back").onclick = () => { sel = null; view = "home"; renderAll(); };
  $("#lName").oninput = e => { L.name = e.target.value; Store.save("lines", id); };
  $("#lZone").oninput = e => { L.zone = e.target.value; Store.save("lines", id); };
  el.querySelectorAll(".rate button").forEach(b => b.onclick = () => { L.ratings = { ...L.ratings, [slot]: b.dataset.v }; Store.save("lines", id, 0); renderAll(); });
  el.querySelectorAll(".mini div").forEach(d => d.onclick = () => setSlot(d.dataset.s));
  $("#lNote").oninput = e => { L.notes = { ...L.notes, [slot]: e.target.value }; Store.save("lines", id); };
  $("#lMemo").oninput = e => { L.memo = e.target.value; Store.save("lines", id); };
  el.querySelectorAll(".tag").forEach(t => t.onclick = () => { const v = t.dataset.t; L.tags = L.tags.includes(v) ? L.tags.filter(x => x !== v) : [...L.tags, v]; Store.save("lines", id, 0); panel(); });
  $("#newTag").onkeydown = e => { if (e.key === "Enter" && e.target.value.trim()) { e.preventDefault(); const v = e.target.value.trim(); if (!L.tags.includes(v)) L.tags = [...L.tags, v]; Store.save("lines", id, 0); panel(); } };
  mic($("#m1"), $("#lNote")); mic($("#m2"), $("#lMemo"));
  bindPhotos(L, "lines", id);
  const rd = $("#reDraw"); if (rd) rd.onclick = () => { reDrawId = id; mode = "line"; draft = []; dName = L.name; dZone = L.zone || ""; view = "redraw"; hint("새 선 모양을 따라 점을 찍고 '모양 저장'을 누르세요."); redrawPanel(el); };
  const lr = $("#lR"); if (lr) lr.oninput = e => { const v = parseInt(e.target.value, 10); if (v > 0) { L.r_m = v; Store.save("lines", id); renderMap(); } };
  $("#del").onclick = () => $("#cf").style.display = "block"; $("#delN").onclick = () => $("#cf").style.display = "none";
  $("#delY").onclick = () => { sel = null; view = "home"; Store.remove("lines", id).then(renderAll); renderAll(); };
}
let reDrawId = null;
function redrawPanel(el) {
  el.innerHTML = `<h2>선 모양 다시 그리기</h2><div class="sub">점 ${draft.length}개 · 판정과 메모는 그대로 유지돼요</div>
   <div class="row" style="margin-top:10px"><button class="btn pri" id="rOk" ${draft.length > 1 ? "" : "disabled"}>모양 저장</button><button class="btn" id="rUndo">마지막 점 취소</button><button class="btn" id="rCancel">취소</button></div>`;
  $("#rOk").onclick = () => { LINES[reDrawId].pts = draft.slice(); Store.save("lines", reDrawId, 0); const id = reDrawId; reDrawId = null; mode = "sel"; draft = []; hint(""); select("line", id); };
  $("#rUndo").onclick = () => { draft.pop(); renderDraft(); redrawPanel(el); };
  $("#rCancel").onclick = () => { const id = reDrawId; reDrawId = null; mode = "sel"; draft = []; hint(""); select("line", id); };
}
function pinPanel(el, id) {
  const p = PINS[id];
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>메모 핀</h2><button class="btn" id="back">목록</button></div>
   <label class="f">종류</label><div class="rate" id="pk">${["관찰","특징","매물"].map(k => `<button data-k="${k}" style="${p.kind === k ? `background:${PINCOL[k]};color:#fff;border-color:${PINCOL[k]}` : ""}">${k}</button>`).join("")}</div>
   <label class="f">제목</label><input type="text" id="pTitle" value="${esc(p.title || "")}" placeholder="예: 9번 출구 앞 버스정류장">
   <label class="f">보이는 시간대</label><select id="pSlot"><option value="all">전체 시간대</option>${SLOTS.map(([k, t]) => `<option value="${k}" ${p.slot === k ? "selected" : ""}>${t}</option>`).join("")}</select>
   <label class="f">내용</label><div class="row"><textarea id="pText">${esc(p.text || "")}</textarea><button class="btn mic" id="m3">🎤</button></div>
   ${p.place ? `<div class="mut small" style="margin-top:6px">카카오 장소: ${esc(p.place.place_name)} · ${esc(p.place.category_name || "")} ${p.place.place_url ? `· <a href="${esc(p.place.place_url)}" target="_blank" rel="noopener">상세</a>` : ""}</div>` : ""}
   ${photosUI(p)}
   <div class="mut small" style="margin-top:8px">${p.created_at ? "작성 " + new Date(p.created_at).toLocaleString("ko-KR") : ""}</div>
   <div class="row" style="margin-top:14px;justify-content:space-between"><span class="mut small">입력하면 자동 저장돼요</span><button class="btn danger" id="del">핀 삭제</button></div>
   <div class="confirm" id="cf">이 핀을 지울까요?<div class="row" style="margin-top:6px"><button class="btn danger" id="delY">삭제</button><button class="btn" id="delN">취소</button></div></div>`;
  if (p.slot === "all") $("#pSlot").value = "all";
  $("#back").onclick = () => { sel = null; view = "home"; renderAll(); };
  el.querySelectorAll("#pk button").forEach(b => b.onclick = () => { p.kind = b.dataset.k; Store.save("pins", id, 0); renderAll(); });
  $("#pTitle").oninput = e => { p.title = e.target.value; Store.save("pins", id); };
  $("#pTitle").onchange = () => renderMap();
  $("#pSlot").onchange = e => { p.slot = e.target.value; Store.save("pins", id, 0); renderAll(); };
  $("#pText").oninput = e => { p.text = e.target.value; Store.save("pins", id); };
  mic($("#m3"), $("#pText")); bindPhotos(p, "pins", id);
  $("#del").onclick = () => $("#cf").style.display = "block"; $("#delN").onclick = () => $("#cf").style.display = "none";
  $("#delY").onclick = () => { sel = null; view = "home"; Store.remove("pins", id).then(renderAll); renderAll(); };
}
function searchPanel(el) {
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>검색 결과 ${searchRes.length}개</h2><button class="btn" id="back">닫기</button></div>
   <div class="sub">누르면 지도가 이동해요. '핀으로 저장'을 누르면 그 위치에 메모 핀이 생겨요.</div>
   ${searchRes.map((r, i) => `<div class="res" data-i="${i}"><b>${esc(r.place_name)}</b><span class="mut small">${esc(r.road_address_name || r.address_name)} · ${esc((r.category_name || "").split(" > ").slice(-1)[0])}</span><div class="row" style="margin-top:4px"><button class="btn" data-pin="${i}">핀으로 저장</button></div></div>`).join("") || `<div class="mut">결과가 없어요</div>`}`;
  $("#back").onclick = () => { view = "home"; panel(); };
  el.querySelectorAll(".res").forEach(d => d.onclick = e => { const r = searchRes[+d.dataset.i]; if (e.target.dataset.pin !== undefined) { newPin(+(+r.y).toFixed(6), +(+r.x).toFixed(6), r); return; } panTo(+r.y, +r.x, 2); });
}
function tablePanel(el) {
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>네 시간대 비교</h2><button class="btn" id="back">닫기</button></div>
   <table class="cmp"><tr><th>라인</th>${SLOTS.map(s => `<th>${s[1].replace(" ", "<br>")}</th>`).join("")}</tr>
   ${sortedLines().map(id => { const L = LINES[id]; return `<tr data-l="${id}" style="cursor:pointer"><td><b>${esc(L.no)}</b> ${esc(L.name)}<div class="mut small">${esc(L.zone || "")}${(L.tags || []).length ? " · " + esc(L.tags.join(", ")) : ""}</div></td>${SLOTS.map(([k]) => `<td>${chip((L.ratings || {})[k] || "")}</td>`).join("")}</tr>`; }).join("")}</table>`;
  $("#back").onclick = () => { view = "home"; sheetSize("mid"); panel(); };
  el.querySelectorAll("[data-l]").forEach(d => d.onclick = () => select("line", d.dataset.l));
}
function download(name, text, type) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
function csv() {
  const head = ["번호","라인","구역","종류", ...SLOTS.flatMap(([k, t]) => [t, t + " 메모"]), "태그", "특징 메모"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = sortedLines().map(id => { const L = LINES[id]; return [L.no, L.name, L.zone, L.kind === "node" ? "지점" : "라인", ...SLOTS.flatMap(([k]) => [(L.ratings || {})[k] || "", (L.notes || {})[k] || ""]), (L.tags || []).join(", "), L.memo].map(q).join(","); });
  const prow = Object.values(PINS).map(p => [p.kind, p.title, slotName(p.slot), p.text, p.lat, p.lng].map(q).join(","));
  return "﻿" + head.map(q).join(",") + "\n" + rows.join("\n") + "\n\n" + ["핀 종류","제목","시간대","내용","위도","경도"].map(q).join(",") + "\n" + prow.join("\n");
}
function menuPanel(el) {
  const d = new Date().toISOString().slice(0, 10);
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>메뉴</h2><button class="btn" id="back">닫기</button></div>
   <div class="sub">${Store.kind === "supa" ? (Store.user ? "클라우드 저장 · " + esc(Store.user.email || "") : "로그인 필요") : "이 기기에만 저장 중 (클라우드 설정 전)"}</div>
   <div class="list">
    <div class="it" id="mZones">구역 경계 ${showZones ? "숨기기" : "보이기"}</div>
    <div class="it" id="mCsv">엑셀(CSV)로 내보내기</div>
    <div class="it" id="mJson">전체 데이터(JSON) 내보내기</div>
    <div class="it" id="mHome">마곡역~발산역으로 이동</div>
    ${Store.kind === "supa" && Store.user ? `<div class="it" id="mOut">로그아웃</div>` : ""}
   </div>
   <div class="mut small" style="margin-top:14px">폰 홈 화면에 추가: 아이폰은 사파리 공유 → '홈 화면에 추가', 안드로이드는 크롬 메뉴 → '앱 설치' 또는 '홈 화면에 추가'.</div>`;
  $("#back").onclick = () => { view = "home"; panel(); };
  $("#mZones").onclick = () => { showZones = !showZones; localStorage.setItem("zones", showZones ? "1" : "0"); drawZones(); panel(); };
  $("#mCsv").onclick = () => download(`상권지도_${d}.csv`, csv(), "text/csv;charset=utf-8");
  $("#mJson").onclick = () => download(`상권지도_${d}.json`, JSON.stringify({ lines: Object.values(LINES), pins: Object.values(PINS) }, null, 1), "application/json");
  $("#mHome").onclick = () => { const c = CFG.CENTER || { lat: 37.5603, lng: 126.8325 }; panTo(c.lat, c.lng, CFG.LEVEL || 4); };
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
function setupPanel(el) {
  el.innerHTML = `<h2>지도 키가 아직 없어요</h2><div class="sub">config.js에 카카오 JavaScript 키를 넣으면 실제 지도가 떠요. 지금은 목록·편집만 쓸 수 있어요.</div>
   <div class="row"><button class="btn" id="cont">목록 보기</button></div>`;
  $("#cont").onclick = () => { view = "home"; panel(); };
}

/* ---------------- start ---------------- */
(async () => {
  sheetSize("mid");
  try { await loadKakao(); initMap(); }
  catch (e) { view = "setup"; if (CFG.KAKAO_JS_KEY) toast("카카오 지도를 불러오지 못했어요. 도메인 등록을 확인해 주세요", 5000); }
  await Store.init();
  if (view !== "login") renderAll();
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
})();
