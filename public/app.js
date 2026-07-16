/* ================================================================
   TOEI LIVE — app.js
   Matches the Tokyo Metro Live layout pattern.

   Route matching strategy (since GTFS-RT routeId is empty):
   1. Cross-reference tripId → routeId from TripUpdates feed (server does this)
   2. Parse vehicle ID: Toei IDs encode the line in the letter suffix
      e.g. 120907TB → "TB" suffix
      We match against the odpt:Railway owl:sameAs values from the API.
   3. The server's /api/debug shows what routeIds are actually returned.
================================================================ */

const REFRESH_SEC   = 10;    // poll often so we detect a new real position quickly
const TOKYO_CENTER  = [139.745, 35.682];
// We do NOT predict. When a NEW real position arrives we glide from the
// previous real position to it, spread over the real update interval
// (~30s for Toei). Every point shown lies between two real reports.
const DEFAULT_SEGMENT_MS = 30000; // assumed gap until proven otherwise
const MIN_SEGMENT_MS     = 8000;
const MAX_SEGMENT_MS     = 50000;
const SAME_POS_THRESHOLD = 30;    // metres: below this = position unchanged

/* Official Toei line metadata — colour, Japanese name, short code */
const LINE_META = {
  "odpt.Railway:Toei.Asakusa"       : { color:"#F62E36", jp:"浅草線",               en:"Asakusa Line",         code:"A",  hasVehicles:true  },
  "odpt.Railway:Toei.Mita"          : { color:"#2B7BB8", jp:"三田線",               en:"Mita Line",            code:"M",  hasVehicles:true  },
  "odpt.Railway:Toei.Shinjuku"      : { color:"#6CBB3C", jp:"新宿線",               en:"Shinjuku Line",        code:"S",  hasVehicles:true  },
  "odpt.Railway:Toei.Oedo"          : { color:"#B6007A", jp:"大江戸線",             en:"Oedo Line",            code:"O",  hasVehicles:true  },
  "odpt.Railway:Toei.Arakawa"       : { color:"#F9A11B", jp:"都電荒川線",           en:"Tokyo Sakura Tram",    code:"ST", hasVehicles:true  },
  "odpt.Railway:Toei.NipporiToneri" : { color:"#B5B5AC", jp:"日暮里・舎人ライナー", en:"Nippori-Toneri Liner", code:"NT", hasVehicles:false, noData:true },
};

/* ── state ── */
let map;
let stationData  = {};      // id → station object (from /api/stations)
let trainInfoMap = {};      // railwayId → trainInfo object
let activeLines  = new Set(Object.keys(LINE_META));
let stationMarkers = [];
let trainMarkers   = {};
let syncComplete   = false;   // true once trains start gliding (2nd update seen)
let firstDataTime  = null;    // when the very first data arrived    // vehicleId → { marker, el, fromCoord, toCoord, startTime, lineKey }
let countdown      = REFRESH_SEC;
let countdownTimer = null;
let animFrameId    = null;
let allVehicles    = [];
let allAlerts      = [];

/* ================================================================ helpers */

function getLineKey(routeId) {
  if (!routeId) return null;
  // 1. Direct exact match — most reliable
  if (LINE_META[routeId]) return routeId;
  // 2. Full railway key suffix match e.g. "Toei.Mita" → "odpt.Railway:Toei.Mita"
  for (const key of Object.keys(LINE_META)) {
    if (key.endsWith(":" + routeId) || key.endsWith("." + routeId)) return key;
  }
  // 3. routeId contains the full railway name e.g. "odpt.Railway:Toei.Mita"
  for (const key of Object.keys(LINE_META)) {
    if (routeId === key) return key;
    if (routeId.length > 10 && key.includes(routeId)) return key;
    if (routeId.length > 10 && routeId.includes(key.split(":").pop())) return key;
  }
  return null;
}

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpCoord(a, b, t) { return [lerp(a[0],b[0],t), lerp(a[1],b[1],t)]; }
function easeInOut(t) { return t < 0.5 ? 2*t*t : -1+(4-2*t)*t; }

/* ================================================================
   TRACK-PATH GEOMETRY
   Each line's track is a polyline (array of [lng,lat] points).
   Trains follow the curve by projecting onto the track and walking
   along it (distance in metres) instead of cutting straight across.
================================================================ */
let trackPaths = {};   // lineKey -> { coords, cumulative }

function metresBetween(a, b) {
  const R = 6371000;
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLng = (b[0] - a[0]) * Math.PI / 180;
  const lat  = (a[1] + b[1]) / 2 * Math.PI / 180;
  const x = dLng * Math.cos(lat);
  return Math.sqrt(x*x + dLat*dLat) * R;
}

function buildTrackPath(lineKey, coords) {
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++)
    cumulative[i] = cumulative[i-1] + metresBetween(coords[i-1], coords[i]);
  trackPaths[lineKey] = { coords, cumulative };
}

// Project GPS point onto track -> { along, dist } (metres along, sq dist off-track)
// hintAlong: if given, prefer matches near that distance (avoids jumping to a
// far part of a loop/parallel track that happens to be geometrically close).
function projectOntoTrack(lineKey, lng, lat, hintAlong) {
  const path = trackPaths[lineKey];
  if (!path || path.coords.length < 2) return null;
  const latScale = Math.cos(lat * Math.PI / 180);
  let bestScore = Infinity, bestAlong = 0, bestOff = Infinity;

  for (let i = 0; i < path.coords.length - 1; i++) {
    const a = path.coords[i], b = path.coords[i+1];
    const ax = a[0]*latScale, ay = a[1];
    const bx = b[0]*latScale, by = b[1];
    const px = lng*latScale,  py = lat;
    const dx = bx-ax, dy = by-ay;
    const segLen2 = dx*dx + dy*dy;
    let t = segLen2 > 0 ? ((px-ax)*dx + (py-ay)*dy) / segLen2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t*dx, cy = ay + t*dy;
    const d2 = (px-cx)*(px-cx) + (py-cy)*(py-cy); // off-track distance²
    const segM = path.cumulative[i+1] - path.cumulative[i];
    const along = path.cumulative[i] + t * segM;

    // Score = off-track distance, plus a penalty for being far from the hint.
    // The penalty is gentle so a clearly-closer point still wins, but ties
    // near the train's last position are preferred (prevents back-jumps).
    let score = d2;
    if (hintAlong != null) {
      const deltaAlong = Math.abs(along - hintAlong);
      // convert metres-along to a comparable scale (deg²-ish) with a weight
      const penalty = Math.pow(deltaAlong / 111000, 2) * 0.15;
      score += penalty;
    }
    if (score < bestScore) {
      bestScore = score; bestAlong = along; bestOff = d2;
    }
  }
  return { along: bestAlong, off: bestOff };
}

// Distance along track (metres) -> [lng,lat]
function pointAtDistance(lineKey, along) {
  const path = trackPaths[lineKey];
  if (!path) return null;
  const cum = path.cumulative;
  const total = cum[cum.length - 1];
  along = Math.max(0, Math.min(total, along));
  for (let i = 0; i < cum.length - 1; i++) {
    if (along <= cum[i+1]) {
      const segM = cum[i+1] - cum[i];
      const t = segM > 0 ? (along - cum[i]) / segM : 0;
      return lerpCoord(path.coords[i], path.coords[i+1], t);
    }
  }
  return path.coords[path.coords.length - 1];
}

function setLoad(pct, msg) {
  document.getElementById("loading-bar").style.width = pct + "%";
  document.getElementById("loading-status").textContent = msg;
}

async function apiFetch(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

/* ================================================================ map */
function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources: { carto: {
        type: "raster",
        tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
        tileSize: 256,
      }},
      layers: [{ id:"carto-dark", type:"raster", source:"carto" }],
    },
    center: TOKYO_CENTER,
    zoom: 12, minZoom: 9, maxZoom: 18,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  return new Promise(res => map.on("load", res));
}

/* ================================================================ static data */
async function loadStaticData() {
  setLoad(20, "LOADING STATIONS...");
  const stRes = await apiFetch("/api/stations");
  const stations = stRes.stations || [];
  stationData = {};
  for (const s of stations) stationData[s.id] = s;

  setLoad(40, "LOADING TRAIN INFO...");
  await refreshTrainInfo();

  setLoad(55, "DRAWING LINES & STATIONS...");
  await drawLines();
  drawStations(stations);
  buildLineFilters();

}

async function refreshTrainInfo() {
  try {
    const res = await apiFetch("/api/train-info");
    trainInfoMap = {};
    for (const ti of (res.trainInfo || [])) {
      const rwId = ti["odpt:railway"];
      if (rwId) trainInfoMap[rwId] = ti;
    }
  } catch (e) { console.warn("trainInfo:", e.message); }
}

/* ================================================================ draw track lines */
async function drawLines() {
  try {
    const res = await apiFetch("/api/railways-full");
    const railwaysData = res.railways || [];

    for (const rw of railwaysData) {
      const rwId   = rw["owl:sameAs"];
      const lineKey = getLineKey(rwId);
      if (!lineKey) continue;

      const meta   = LINE_META[lineKey];
      const order  = rw["odpt:stationOrder"] || [];
      const coords = order
        .map(o => {
          const s = stationData[o["odpt:station"]];
          if (!s) return null;
          return [s.lng, s.lat];
        })
        .filter(Boolean);

      if (coords.length < 2) continue;

      // Store track coords for path-following animation
      buildTrackPath(lineKey, coords);

      const srcId = "src-" + lineKey.replace(/\W/g,"_");
      const lyrId = "lyr-" + lineKey.replace(/\W/g,"_");

      if (!map.getSource(srcId)) {
        map.addSource(srcId, {
          type: "geojson",
          data: { type:"Feature", geometry:{ type:"LineString", coordinates:coords } },
        });
      }
      if (!map.getLayer(lyrId)) {
        map.addLayer({
          id: lyrId, type: "line", source: srcId,
          layout: { "line-join":"round", "line-cap":"round" },
          paint: {
            "line-color"  : meta.color,
            "line-width"  : ["interpolate",["linear"],["zoom"], 9,1.5, 11,2.5, 13,4, 16,7],
            "line-opacity": 0.92,
          },
        });
      }
    }
  } catch(e) { console.warn("drawLines:", e.message); }
}

/* ================================================================ station markers */
function drawStations(stations) {
  stationMarkers.forEach(m => m.remove());
  stationMarkers = [];

  for (const s of stations) {
    const lineKey = getLineKey(s.railway);
    if (!lineKey || !activeLines.has(lineKey)) continue;
    if (!s.lat || !s.lng) continue;

    const color = LINE_META[lineKey].color;
    const wrap  = document.createElement("div");
    wrap.className = "station-marker-wrap";
    wrap.innerHTML = `<div class="station-dot" style="background:${color};box-shadow:0 0 4px ${color}77"></div>`;

    const marker = new maplibregl.Marker({ element:wrap, anchor:"center" })
      .setLngLat([s.lng, s.lat])
      .addTo(map);

    // Stations are added before trains, so trains naturally render ON TOP.
    // We keep the station's CLICKABLE area large (see .station-marker-wrap in
    // CSS) so its edges stick out around a parked train + delay ring and stay
    // clickable, even though the train sits visually on top.
    wrap.addEventListener("click", e => {
      e.stopPropagation();
      showStationPanel(s, lineKey, color);
    });

    stationMarkers.push(marker);
  }
}

/* ================================================================ main refresh */
async function doRefresh() {
  try {
    await refreshTrainInfo();
    const [vRes, aRes] = await Promise.all([
      apiFetch("/api/vehicles"),
      apiFetch("/api/alerts"),
    ]);

    allVehicles = vRes.vehicles || [];
    allAlerts   = aRes.alerts   || [];

    updateTrainMarkers();
    updateStats(vRes.lastUpdated);
    updateAlertBanner();
    updateLineCounts();
    updateDelayBadges();
    updateSyncBadge();

    document.getElementById("stat-refresh").textContent =
      new Date().toLocaleTimeString("ja-JP",{timeZone:"Asia/Tokyo",hour12:false});
  } catch(e) {
    console.error("doRefresh:", e);
  }

  startCountdown();
}

/* ================================================================ train markers */
function updateTrainMarkers() {
  const seen = new Set();

  for (const v of allVehicles) {
    const lineKey = getLineKey(v.routeId);
    if (!lineKey) continue;
    if (!activeLines.has(lineKey)) continue;

    const meta = LINE_META[lineKey];

    // Skip lines that don't have vehicle position data (e.g. Nippori-Toneri)
    if (!meta.hasVehicles) continue;

    const ti    = trainInfoMap[v.routeId] || trainInfoMap[lineKey];
    const tiJa  = ti?.["odpt:trainInformationText"]?.ja || "";
    const lineDelay   = tiJa.includes("遅延") && !tiJa.includes("ありません");
    const isSuspended = tiJa.includes("運転見合わせ");
    // Per-train delay (like Mini Tokyo 3D): 60s+ counts as late.
    const trainLate   = (v.delaySec || 0) >= 60;
    const isDelay     = lineDelay || trainLate;
    // Icon keeps its LINE colour always. Delay is shown by a red ring instead.
    const color       = meta.color;

    seen.add(v.vehicleId);

    // We don't have from/to station from GTFS-RT,
    // so we position at current lat/lng and animate to next refresh position
    const coord = [v.lng, v.lat];

    if (trainMarkers[v.vehicleId]) {
      const tm = trainMarkers[v.vehicleId];

      // If lineKey changed (e.g. after a server fix), destroy and recreate the marker
      if (tm.lineKey !== lineKey) {
        tm.marker.remove();
        delete trainMarkers[v.vehicleId];
        // Fall through to create new marker below
      } else {
        // Project the new GPS point onto the track.
        const proj = projectOntoTrack(lineKey, v.lng, v.lat, tm.targetAlong);
        const now  = performance.now();

        if (proj && tm.targetAlong != null) {
          let newAlong = proj.along;

          // How far did the reported position move since our current target?
          const moved = Math.abs(newAlong - tm.targetAlong);

          if (moved < SAME_POS_THRESHOLD) {
            // Position hasn't really changed → this poll returned the SAME
            // real data. Do nothing: let the train keep gliding toward the
            // existing target. We do NOT reset the animation.
          } else {
            // A genuinely NEW real position arrived. Glide from where the
            // train is shown now to the new real position. We spread it over a
            // duration slightly LONGER than the real interval so the train is
            // usually still gliding when the next update lands (smooth hand-off)
            // instead of finishing early and sitting idle. Still never moves
            // PAST the latest real point — no prediction.
            const measuredGap = tm.lastChangeTime ? (now - tm.lastChangeTime) : DEFAULT_SEGMENT_MS;
            const blended = (measuredGap + DEFAULT_SEGMENT_MS) / 2;
            tm.segmentMs   = Math.max(MIN_SEGMENT_MS, Math.min(MAX_SEGMENT_MS, blended * 1.15));
            tm.fromAlong   = currentDisplayedAlong(tm);          // seamless start
            if (tm.fromAlong == null) tm.fromAlong = tm.targetAlong;
            tm.toAlong     = newAlong;
            tm.targetAlong = newAlong;
            tm.startTime   = now;
            tm.lastChangeTime = now;
            tm.useTrack    = true;
          }
        } else if (proj) {
          // First valid projection for this train
          tm.targetAlong = tm.fromAlong = tm.toAlong = proj.along;
          tm.segmentMs   = DEFAULT_SEGMENT_MS;
          tm.startTime   = now;
          tm.lastChangeTime = now;
          tm.useTrack    = true;
        } else {
          // Fallback: straight-line if track unavailable
          tm.fromCoord = tm.toCoord || coord;
          tm.toCoord   = coord;
          tm.startTime = now;
          tm.useTrack  = false;
        }
        tm.vehicle   = v;
        const icon = tm.el.querySelector(".train-icon");
        if (icon) {
          icon.style.background = color;
          icon.style.boxShadow  = `0 0 8px ${color}bb, 0 0 18px ${color}44`;
          icon.textContent      = meta.code;
        }
        // Toggle the red delay ring on the wrapper (keeps icon colour intact)
        tm.el.classList.toggle("delayed-ring", isDelay || isSuspended);
        continue; // skip to next vehicle — marker is updated
      }
    }
    
    if (!trainMarkers[v.vehicleId]) {
      const wrap = document.createElement("div");
      wrap.className = "train-marker-wrap" + (isDelay||isSuspended?" delayed-ring":"");
      const icon = document.createElement("div");
      icon.className = "train-icon";
      icon.style.background = color;
      icon.style.boxShadow  = `0 0 8px ${color}bb, 0 0 18px ${color}44`;
      icon.textContent = meta.code;
      wrap.appendChild(icon);

      // Fade in new markers smoothly instead of popping
      wrap.style.opacity = "0";
      wrap.style.transition = "opacity 0.5s";
      const marker = new maplibregl.Marker({ element:wrap, anchor:"center" })
        .setLngLat(coord)
        .addTo(map);
      requestAnimationFrame(() => { wrap.style.opacity = "1"; });

      const proj = projectOntoTrack(lineKey, v.lng, v.lat);
      const along = proj ? proj.along : null;
      const entry = {
        marker, el: wrap,
        fromCoord: coord,
        toCoord:   coord,
        along, fromAlong: along, toAlong: along,
        targetAlong: along,
        segmentMs: DEFAULT_SEGMENT_MS,
        lastChangeTime: performance.now(),
        useTrack: along != null,
        startTime: performance.now(),
        lineKey, vehicle: v,
      };

      wrap.addEventListener("click", e => {
        e.stopPropagation();
        showVehiclePanel(entry);
      });

      trainMarkers[v.vehicleId] = entry;
    }
  }

  // Remove stale markers — with a grace period to avoid flicker.
  // A train must be absent for 2 consecutive refreshes before removal,
  // so brief gaps in the feed don't make trains blink in and out.
  for (const id of Object.keys(trainMarkers)) {
    if (!seen.has(id)) {
      const tm = trainMarkers[id];
      tm.missCount = (tm.missCount || 0) + 1;
      if (tm.missCount >= 2) {
        // Fade out then remove
        tm.el.style.transition = "opacity 0.4s";
        tm.el.style.opacity = "0";
        const m = tm.marker;
        setTimeout(() => m.remove(), 400);
        delete trainMarkers[id];
      }
    } else {
      trainMarkers[id].missCount = 0; // seen again — reset
    }
  }

  document.getElementById("train-count-badge").textContent = seen.size + " TRAINS";
}

// Where is this train shown right now (distance-along-track)?
// Linear glide from the previous real point to the latest real point over
// this segment's measured duration, then HOLD at the real point. We never
// move past the latest real position — no prediction.
function currentDisplayedAlong(tm) {
  if (!tm.useTrack || tm.fromAlong == null || tm.toAlong == null) return null;
  const dur = tm.segmentMs || DEFAULT_SEGMENT_MS;
  const gap = tm.toAlong - tm.fromAlong;
  if (Math.abs(gap) > 4000) return tm.toAlong;        // teleport → snap
  const t = Math.min((performance.now() - tm.startTime) / dur, 1); // clamp → hold
  return tm.fromAlong + gap * t;
}

/* Smooth motion loop.
   Each train glides at a steady pace from its previous REAL position to its
   latest REAL position, taking the real update interval (~30s) to get there,
   then holds until the next real update. Honest: every point is between two
   real reports; nothing is predicted past the latest data. */

function startAnimLoop() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  function tick() {
    for (const tm of Object.values(trainMarkers)) {
      if (tm.useTrack && tm.fromAlong != null && tm.toAlong != null) {
        const gap = tm.toAlong - tm.fromAlong;
        if (Math.abs(gap) > 4000) {                   // teleport guard
          const pt = pointAtDistance(tm.lineKey, tm.toAlong);
          if (pt) tm.marker.setLngLat(pt);
          continue;
        }
        const along = currentDisplayedAlong(tm);
        const pt = pointAtDistance(tm.lineKey, along);
        if (pt) tm.marker.setLngLat(pt);
      } else if (tm.fromCoord && tm.toCoord) {
        const dur = tm.segmentMs || DEFAULT_SEGMENT_MS;
        const t = Math.min((performance.now() - tm.startTime) / dur, 1);
        tm.marker.setLngLat(lerpCoord(tm.fromCoord, tm.toCoord, t));
      }
    }
    animFrameId = requestAnimationFrame(tick);
  }
  animFrameId = requestAnimationFrame(tick);
}

/* ================================================================ info panels */
const STATUS_LABELS = { 0:"Incoming", 1:"At Stop", 2:"In Transit" };

function showVehiclePanel(tm) {
  const v      = tm.vehicle;
  const lineKey= tm.lineKey;
  const meta   = LINE_META[lineKey];
  const color  = meta.color;
  const ti     = trainInfoMap[v.routeId] || trainInfoMap[lineKey];
  const tiJa   = ti?.["odpt:trainInformationText"]?.ja || "";
  const tiEn   = ti?.["odpt:trainInformationText"]?.en || "";
  const isDelay= tiJa.includes("遅延") && !tiJa.includes("ありません");
  const isSusp = tiJa.includes("運転見合わせ");
  const delaySec  = v.delaySec || 0;
  const trainLate = delaySec >= 60;
  const anyDelay  = isDelay || trainLate;
  const sClass = isSusp?"disruption":anyDelay?"delay":"normal";
  const sLabel = isSusp?"⛔ SUSPENDED":anyDelay?"⚠ DELAYED":"✓ ON TIME";
  const delayText = delaySec > 0
    ? (delaySec >= 60 ? `${Math.floor(delaySec/60)}分${delaySec%60}秒` : `${delaySec}秒`)
    : "定刻 (on time)";

  // Station name helper: turn a station ID into its Japanese name.
  const staName = (id) => {
    if (!id) return null;
    const s = stationData[id];
    if (s) return s.titleJa || s.titleEn;
    // Fallback: last part of the ID (e.g. ...Oedo.Tochomae → Tochomae)
    return id.split(".").pop();
  };

  const fromName = staName(v.fromStation);
  const toName   = staName(v.toStation);

  // Build the station status block:
  //   - Moving (has a next station): 前駅 → 次駅
  //   - Stopped (no next station): 停車中 at the current station
  let stationHtml = "";
  if (toName && fromName) {
    // Moving between two stations
    stationHtml = `
      <div class="info-divider"></div>
      <div class="info-row"><span class="info-key">前駅</span><span class="info-val">${fromName}</span></div>
      <div class="info-row"><span class="info-key">次駅</span><span class="info-val" style="color:${color}">${toName}</span></div>`;
  } else if (fromName) {
    // Stopped at a station
    stationHtml = `
      <div class="info-divider"></div>
      <div class="info-row"><span class="info-key">状態</span><span class="info-val" style="color:${color}">停車中</span></div>
      <div class="info-row"><span class="info-key">停車駅</span><span class="info-val">${fromName}</span></div>`;
  }

  setInfoPanel({
    type  : "▶ LIVE TRAIN",
    color,
    name  : v.vehicleId,
    sub   : `${meta.en}  ／  ${meta.jp}`,
    html  : `
      <div class="info-row"><span class="info-key">STATUS</span><span class="status-tag ${sClass}">${sLabel}</span></div>
      <div class="info-row"><span class="info-key">LINE</span><span class="info-val" style="color:${color}">${meta.en}</span></div>
      <div class="info-row"><span class="info-key">VEHICLE</span><span class="info-val">${v.vehicleId}</span></div>
      <div class="info-row"><span class="info-key">TRIP</span><span class="info-val">${v.tripId||"—"}</span></div>
      <div class="info-row"><span class="info-key">DELAY</span><span class="info-val ${trainLate?"danger":"success"}">${delayText}</span></div>
      ${stationHtml}
      ${tiEn && !tiEn.includes("Normal") ? `<div class="info-divider"></div><div class="info-desc">${tiEn}</div>` : ""}
      ${tiJa ? `<div class="info-desc" style="margin-top:4px">${tiJa}</div>` : ""}
    `,
  });
}

function showStationPanel(s, lineKey, color) {
  const meta = LINE_META[lineKey];
  const ti   = trainInfoMap[s.railway];
  const tiJa = ti?.["odpt:trainInformationText"]?.ja || "";
  const tiEn = ti?.["odpt:trainInformationText"]?.en || "";
  const isDelay = tiJa.includes("遅延") && !tiJa.includes("ありません");
  const isSusp  = tiJa.includes("運転見合わせ");
  const sClass  = isSusp?"disruption":isDelay?"delay":"normal";
  const sLabel  = isSusp?"⛔ SUSPENDED":isDelay?"⚠ DELAY":"✓ NORMAL";

  setInfoPanel({
    type  : "◉ STATION",
    color,
    name  : s.titleEn || s.titleJa,
    sub   : s.titleJa,
    html  : `
      <div class="info-row"><span class="info-key">STATUS</span><span class="status-tag ${sClass}">${sLabel}</span></div>
      <div class="info-row"><span class="info-key">LINE</span><span class="info-val" style="color:${color}">${meta.en}</span></div>
      <div class="info-row"><span class="info-key">路線</span><span class="info-val">${meta.jp}</span></div>
      <div class="info-row"><span class="info-key">LATITUDE</span><span class="info-val">${s.lat?.toFixed(5)}</span></div>
      <div class="info-row"><span class="info-key">LONGITUDE</span><span class="info-val">${s.lng?.toFixed(5)}</span></div>
      ${tiEn ? `<div class="info-divider"></div><div class="info-desc">${tiEn}</div>` : ""}
      ${tiJa ? `<div class="info-desc" style="margin-top:4px">${tiJa}</div>` : ""}
    `,
  });
}

function setInfoPanel({ type, color, name, sub, html }) {
  document.getElementById("info-type").textContent = type;
  const ne = document.getElementById("info-name");
  ne.textContent = name;
  ne.style.borderLeftColor = color;
  document.getElementById("info-sub").textContent = sub || "";
  document.getElementById("info-rows").innerHTML  = html;
  document.getElementById("info-panel").classList.add("visible");
}

document.getElementById("info-close").addEventListener("click", () =>
  document.getElementById("info-panel").classList.remove("visible"));

/* ================================================================ line filters */
function buildLineFilters() {
  const cont = document.getElementById("line-filters");
  cont.querySelectorAll(".line-btn").forEach(b => b.remove());

  const sorted = Object.entries(LINE_META)
    .sort((a,b) => a[1].en.localeCompare(b[1].en));

  for (const [id, meta] of sorted) {
    const btn = document.createElement("button");
    btn.className   = "line-btn active";
    btn.dataset.lid = id;
    btn.style.setProperty("--line-color", meta.color);
    btn.innerHTML = `
      <div class="line-dot"></div>
      <div class="line-label">
        <div class="line-label-en">${meta.en}</div>
        <div class="line-label-jp">${meta.noData ? meta.jp + " (track only)" : meta.jp}</div>
      </div>
      <span class="delay-indicator">DELAY</span>
      ${meta.noData ? "" : `<span class="line-train-count" id="cnt_${id.replace(/\W/g,"_")}">0</span>`}`;
    btn.addEventListener("click", () => toggleLine(id, btn));
    cont.appendChild(btn);
  }

  document.getElementById("toggle-all-btn").addEventListener("click", toggleAllLines);
}

function toggleLine(id, btn) {
  if (activeLines.has(id)) { activeLines.delete(id); btn.classList.remove("active"); }
  else                     { activeLines.add(id);    btn.classList.add("active"); }
  updateLineVis();
  updateToggleBtn();
}

function toggleAllLines() {
  const allOn = activeLines.size >= Object.keys(LINE_META).length;
  if (allOn) {
    activeLines.clear();
    document.querySelectorAll(".line-btn").forEach(b => b.classList.remove("active"));
  } else {
    Object.keys(LINE_META).forEach(id => activeLines.add(id));
    document.querySelectorAll(".line-btn").forEach(b => b.classList.add("active"));
  }
  updateLineVis();
  updateToggleBtn();
}

function updateToggleBtn() {
  const btn   = document.getElementById("toggle-all-btn");
  const allOn = activeLines.size >= Object.keys(LINE_META).length;
  btn.textContent = allOn ? "● ALL LINES" : "○ ALL LINES";
  btn.classList.toggle("all-off", !allOn);
}

function updateLineVis() {
  for (const [id] of Object.entries(LINE_META)) {
    const lyrId = "lyr-" + id.replace(/\W/g,"_");
    if (map.getLayer(lyrId))
      map.setLayoutProperty(lyrId, "visibility", activeLines.has(id) ? "visible" : "none");
  }
  for (const tm of Object.values(trainMarkers)) {
    tm.el.style.display = activeLines.has(tm.lineKey) ? "" : "none";
  }
  for (const m of stationMarkers) m.getElement().style.display = "";
  // Re-render stations with filter
  // (simpler: just hide via dataset)
}

function updateLineCounts() {
  const counts = {};
  for (const v of allVehicles) {
    const k = getLineKey(v.routeId);
    if (k) counts[k] = (counts[k]||0) + 1;
  }
  for (const id of Object.keys(LINE_META)) {
    const el = document.getElementById(`cnt_${id.replace(/\W/g,"_")}`);
    if (el) el.textContent = counts[id] || 0;
  }
  document.getElementById("stat-routes").textContent =
    Object.values(counts).filter(c => c > 0).length;
}

function updateDelayBadges() {
  for (const [id] of Object.entries(LINE_META)) {
    const ti    = trainInfoMap[id];
    const tiJa  = ti?.["odpt:trainInformationText"]?.ja || "";
    const delay = tiJa.includes("遅延") && !tiJa.includes("ありません");
    const btn   = document.querySelector(`[data-lid="${id}"]`);
    if (btn) btn.classList.toggle("has-delay", delay);
  }
}

/* ================================================================ stats & alerts */
function updateSyncBadge() {
  const badge = document.getElementById("live-badge");
  const text  = document.getElementById("live-badge-text");
  if (!badge || !text) return;

  if (firstDataTime == null) firstDataTime = performance.now();

  if (!syncComplete) {
    // Sync is complete once any train has a real segment to glide along
    // (its from and to differ → it's moving between two real positions).
    const moving = Object.values(trainMarkers).some(
      tm => tm.useTrack && tm.fromAlong != null && tm.toAlong != null &&
            Math.abs(tm.toAlong - tm.fromAlong) > 1
    );
    if (moving) syncComplete = true;
  }

  if (syncComplete) {
    text.textContent = "LIVE";
    badge.classList.remove("syncing");
  } else {
    text.textContent = "SYNCING";
    badge.classList.add("syncing");
  }
}

function updateStats(lastUpdated) {
  const matched = allVehicles.filter(v => getLineKey(v.routeId));
  document.getElementById("stat-trains").textContent  = matched.length;

  // Count trains that are individually late (60s+) OR on a line with a
  // formal delay announcement — matches how the red rings are shown.
  let delayed = 0;
  for (const v of matched) {
    const lineKey = getLineKey(v.routeId);
    const ti   = trainInfoMap[v.routeId] || trainInfoMap[lineKey];
    const tiJa = ti?.["odpt:trainInformationText"]?.ja || "";
    const lineDelay = tiJa.includes("遅延") && !tiJa.includes("ありません");
    const suspended = tiJa.includes("運転見合わせ");
    if ((v.delaySec || 0) >= 60 || lineDelay || suspended) delayed++;
  }
  const delEl = document.getElementById("stat-delayed");
  if (delEl) {
    delEl.textContent = delayed;
    delEl.className   = `stat-value ${delayed > 0 ? "danger" : "success"}`;
  }

  document.getElementById("stat-alerts").textContent  = allAlerts.length;
  document.getElementById("stat-alerts").className    =
    `stat-value ${allAlerts.length > 0 ? "danger" : "success"}`;
}

function updateAlertBanner() {
  const b = document.getElementById("alert-banner");
  if (allAlerts.length > 0) {
    b.textContent = `⚠ ${allAlerts.length} SERVICE ALERT${allAlerts.length>1?"S":""} ACTIVE`;
    b.classList.add("visible");
  } else {
    b.classList.remove("visible");
  }
}

/* ================================================================ clock & countdown */
function startClock() {
  const el = document.getElementById("clock");
  const tick = () => el.textContent =
    new Date().toLocaleTimeString("ja-JP",{timeZone:"Asia/Tokyo",hour12:false});
  tick(); setInterval(tick, 1000);
}

function startCountdown() {
  countdown = REFRESH_SEC;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(async () => {
    countdown--;
    document.getElementById("next-update").textContent = `NEXT UPDATE: ${countdown}s`;
    if (countdown <= 0) { clearInterval(countdownTimer); await doRefresh(); }
  }, 1000);
}

/* ================================================================ boot */
async function main() {
  setLoad(5, "INITIALISING MAP...");
  await initMap();

  setLoad(15, "LOADING DATA...");
  await loadStaticData();

  setLoad(75, "FETCHING LIVE TRAINS...");
  await doRefresh();

  setLoad(100, "READY");
  setTimeout(() => {
    document.getElementById("loading").classList.add("hidden");
  }, 400);

  startAnimLoop();
  startClock();
  setupSearch();
  setupAboutModal();
  setupCommute();
  setupCommuteModeToggle();
  autoApplyCommuteOnLoad();
}

function setupAboutModal() {
  const btn     = document.getElementById("about-btn");
  const overlay = document.getElementById("about-overlay");
  const close   = document.getElementById("about-close");
  if (!btn || !overlay || !close) return;
  const open = () => overlay.classList.add("visible");
  const hide = () => overlay.classList.remove("visible");
  btn.addEventListener("click", open);
  close.addEventListener("click", hide);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) hide(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
}

function setupSearch() {
  const input   = document.getElementById("search-input");
  const results = document.getElementById("search-results");
  const box     = document.getElementById("search-box");
  const toggle  = document.getElementById("search-toggle");
  if (!input || !results) return;
  let activeIndex = -1, currentMatches = [];

  // Mobile: tapping the icon slides the search bar open and focuses the input.
  if (toggle && box) {
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      box.classList.add("open");
      setTimeout(() => input.focus(), 50);
    });
    // Tapping outside the search box closes it (mobile collapse).
    document.addEventListener("click", (e) => {
      if (!box.contains(e.target)) {
        box.classList.remove("open");
        results.classList.remove("visible");
      }
    });
  }

  function render(matches) {
    currentMatches = matches; activeIndex = -1;
    if (matches.length === 0) {
      results.innerHTML = `<div class="search-no-results">該当なし / No stations found</div>`;
      results.classList.add("visible"); return;
    }
    results.innerHTML = matches.map((s, i) => {
      const meta = LINE_META[getLineKey(s.railway)] || {};
      const color = meta.color || "#00b4ff";
      return `<div class="search-result" data-idx="${i}">
        <div class="search-result-dot" style="background:${color}"></div>
        <div class="search-result-text">
          <div class="search-result-name">${s.titleJa || s.titleEn} <span style="color:var(--text-dim);font-size:11px">${s.titleEn||""}</span></div>
          <div class="search-result-line">${meta.en||""}</div>
        </div></div>`;
    }).join("");
    results.classList.add("visible");
    results.querySelectorAll(".search-result").forEach(el => {
      el.addEventListener("click", () => selectStation(matches[+el.dataset.idx]));
    });
  }
  function selectStation(s) {
    map.flyTo({ center: [s.lng, s.lat], zoom: 15, speed: 1.2, essential: true });
    input.value = s.titleJa || s.titleEn;
    results.classList.remove("visible");
    if (box) box.classList.remove("open");   // collapse the mobile search bar
    flashStation(s);
    // Also open the station's info panel
    const lineKey = getLineKey(s.railway);
    const color   = (LINE_META[lineKey] || {}).color || "#00b4ff";
    if (lineKey) showStationPanel(s, lineKey, color);
  }
  function doSearch(q) {
    q = q.trim().toLowerCase();
    if (!q) { results.classList.remove("visible"); return; }
    const seen = new Set(), matches = [];
    for (const id in stationData) {
      const s = stationData[id];
      if (!s.lat || !s.lng) continue;
      if ((s.titleJa||"").toLowerCase().includes(q) || (s.titleEn||"").toLowerCase().includes(q)) {
        const key = (s.titleJa||s.titleEn) + "|" + s.railway;
        if (seen.has(key)) continue;
        seen.add(key); matches.push(s);
      }
    }
    matches.sort((a, b) => {
      const aS = (a.titleEn||"").toLowerCase().startsWith(q) || (a.titleJa||"").startsWith(q);
      const bS = (b.titleEn||"").toLowerCase().startsWith(q) || (b.titleJa||"").startsWith(q);
      return aS && !bS ? -1 : !aS && bS ? 1 : 0;
    });
    render(matches.slice(0, 12));
  }
  input.addEventListener("input", () => doSearch(input.value));
  input.addEventListener("focus", () => { if (input.value.trim()) doSearch(input.value); });
  input.addEventListener("keydown", (e) => {
    const items = results.querySelectorAll(".search-result");
    if (e.key === "ArrowDown") { e.preventDefault(); activeIndex = Math.min(activeIndex+1, items.length-1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIndex = Math.max(activeIndex-1, 0); }
    else if (e.key === "Enter") {
      if (activeIndex >= 0 && currentMatches[activeIndex]) selectStation(currentMatches[activeIndex]);
      else if (currentMatches[0]) selectStation(currentMatches[0]);
      return;
    } else if (e.key === "Escape") { results.classList.remove("visible"); if (box) box.classList.remove("open"); input.blur(); return; }
    else return;
    items.forEach((el, i) => el.classList.toggle("active", i === activeIndex));
  });
  document.addEventListener("click", (e) => {
    if (!document.getElementById("search-box").contains(e.target)) results.classList.remove("visible");
  });
}

/* ================================================================
   MY COMMUTE — manual multi-leg route saved to localStorage
================================================================ */
const COMMUTE_KEY = "toei_commute_v1";
let commuteMarkers = [];   // highlight markers for saved commute stations

// Load / save to localStorage
function loadCommute() {
  try {
    const raw = localStorage.getItem(COMMUTE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveCommute(commute) {
  try { localStorage.setItem(COMMUTE_KEY, JSON.stringify(commute)); } catch {}
}
function clearCommuteStorage() {
  try { localStorage.removeItem(COMMUTE_KEY); } catch {}
}

// Build list of stations for a given line (sorted by order), for the dropdowns.
function stationsForLine(lineKey) {
  const out = [];
  for (const id in stationData) {
    const s = stationData[id];
    if (getLineKey(s.railway) === lineKey) out.push(s);
  }
  out.sort((a,b) => (a.order ?? 999) - (b.order ?? 999));
  return out;
}

function setupCommute() {
  const btn      = document.getElementById("commute-btn");
  const overlay  = document.getElementById("commute-overlay");
  const close    = document.getElementById("commute-close");
  if (!btn || !overlay || !close) return;

  const savedBox = document.getElementById("commute-saved");
  const builder  = document.getElementById("commute-builder");
  const legsWrap = document.getElementById("commute-legs");
  const routeDisp= document.getElementById("commute-route-display");

  let editingLegs = [];   // working copy while building

  const open  = () => { refreshView(); overlay.classList.add("visible"); };
  const hide  = () => overlay.classList.remove("visible");
  btn.addEventListener("click", open);
  close.addEventListener("click", hide);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) hide(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });

  // Decide whether to show the saved summary or the builder.
  function refreshView() {
    const commute = loadCommute();
    if (commute && commute.legs && commute.legs.length) {
      savedBox.style.display = "block";
      builder.style.display  = "none";
      renderSavedSummary(commute);
    } else {
      savedBox.style.display = "none";
      builder.style.display  = "block";
      if (editingLegs.length === 0) editingLegs = [ blankLeg() ];
      renderBuilder();
    }
  }

  function blankLeg() { return { line: "", from: "", to: "", xferMin: 5 }; }

  // ---- Builder rendering ----
  function renderBuilder() {
    legsWrap.innerHTML = "";
    editingLegs.forEach((leg, i) => {
      const legEl = document.createElement("div");
      legEl.className = "commute-leg";

      const lineOptions = Object.entries(LINE_META)
        .map(([id, m]) => `<option value="${id}" ${leg.line===id?"selected":""}>${m.en} / ${m.jp}</option>`)
        .join("");

      const fromStations = leg.line ? stationsForLine(leg.line) : [];
      const toStations   = leg.line ? stationsForLine(leg.line) : [];
      const fromOptions = fromStations
        .map(s => `<option value="${s.id}" ${leg.from===s.id?"selected":""}>${s.titleJa||s.titleEn}</option>`).join("");
      const toOptions = toStations
        .map(s => `<option value="${s.id}" ${leg.to===s.id?"selected":""}>${s.titleJa||s.titleEn}</option>`).join("");

      legEl.innerHTML = `
        <div class="commute-leg-head">
          <span class="commute-leg-num">区間 ${i+1}</span>
          ${editingLegs.length > 1 ? `<button class="commute-leg-remove" data-i="${i}">✕</button>` : ""}
        </div>
        <select class="commute-select commute-line" data-i="${i}">
          <option value="">路線を選択 / Select line</option>
          ${lineOptions}
        </select>
        <div class="commute-leg-stations">
          <select class="commute-select commute-from" data-i="${i}" ${!leg.line?"disabled":""}>
            <option value="">出発駅 / From</option>${fromOptions}
          </select>
          <span class="commute-arrow">→</span>
          <select class="commute-select commute-to" data-i="${i}" ${!leg.line?"disabled":""}>
            <option value="">到着駅 / To</option>${toOptions}
          </select>
        </div>`;
      legsWrap.appendChild(legEl);

      if (i < editingLegs.length - 1) {
        const nextLeg = editingLegs[i+1];
        const tr = document.createElement("div");
        tr.className = "commute-transfer-mark";
        tr.innerHTML = `
          <div class="commute-transfer-row">
            <span>🔄 乗り換え / Transfer</span>
            <span class="commute-transfer-time">
              徒歩 <input type="number" class="commute-xfer-input" data-i="${i+1}"
                     min="0" max="30" value="${nextLeg.xferMin ?? 5}"> 分
            </span>
          </div>`;
        legsWrap.appendChild(tr);
      }
    });

    // Wire up the selects
    legsWrap.querySelectorAll(".commute-line").forEach(sel => {
      sel.addEventListener("change", (e) => {
        const i = +e.target.dataset.i;
        editingLegs[i].line = e.target.value;
        editingLegs[i].from = "";
        editingLegs[i].to   = "";
        renderBuilder();
      });
    });
    legsWrap.querySelectorAll(".commute-from").forEach(sel => {
      sel.addEventListener("change", (e) => { editingLegs[+e.target.dataset.i].from = e.target.value; });
    });
    legsWrap.querySelectorAll(".commute-to").forEach(sel => {
      sel.addEventListener("change", (e) => { editingLegs[+e.target.dataset.i].to = e.target.value; });
    });
    legsWrap.querySelectorAll(".commute-leg-remove").forEach(b => {
      b.addEventListener("click", (e) => {
        editingLegs.splice(+e.target.dataset.i, 1);
        renderBuilder();
      });
    });
    legsWrap.querySelectorAll(".commute-xfer-input").forEach(inp => {
      inp.addEventListener("change", (e) => {
        const i = +e.target.dataset.i;
        let v = parseInt(e.target.value, 10);
        if (isNaN(v) || v < 0) v = 0;
        if (v > 30) v = 30;
        editingLegs[i].xferMin = v;
      });
    });
  }

  // ---- Saved summary rendering ----
  function renderSavedSummary(commute) {
    const parts = commute.legs.map((leg, i) => {
      const m = LINE_META[leg.line] || {};
      const fromN = (stationData[leg.from]?.titleJa) || staTail(leg.from);
      const toN   = (stationData[leg.to]?.titleJa)   || staTail(leg.to);
      return `
        <div class="commute-route-leg">
          <div class="commute-route-line" style="border-color:${m.color}">
            <span class="commute-route-dot" style="background:${m.color}"></span>
            <span class="commute-route-name">${m.jp||m.en||""}</span>
          </div>
          <div class="commute-route-stations">${fromN} <span style="color:${m.color}">→</span> ${toN}</div>
        </div>
        ${i < commute.legs.length-1 ? `<div class="commute-route-transfer">🔄 乗り換え（徒歩 ${commute.legs[i+1].xferMin ?? 5}分）</div>` : ""}`;
    }).join("");
    routeDisp.innerHTML = parts;
  }

  function staTail(id){ return id ? id.split(".").pop() : "—"; }

  // ---- Buttons ----
  document.getElementById("commute-add-leg").addEventListener("click", () => {
    // New leg pre-fills its "from" with the previous leg's "to" (transfer point)
    const prev = editingLegs[editingLegs.length-1];
    const nl = blankLeg();
    if (prev && prev.to) nl.from = ""; // user picks line first; from set after line chosen
    editingLegs.push(nl);
    renderBuilder();
  });

  document.getElementById("commute-save-btn").addEventListener("click", () => {
    // Validate: every leg needs line + from + to
    const valid = editingLegs.filter(l => l.line && l.from && l.to);
    if (valid.length === 0) {
      alert("少なくとも1区間（路線・出発駅・到着駅）を入力してください。");
      return;
    }
    saveCommute({ legs: valid, savedAt: Date.now() });
    editingLegs = [];
    refreshView();
    applyCommute();   // immediately apply to the map
    updateCommuteModeButton();
  });

  document.getElementById("commute-cancel-btn").addEventListener("click", () => {
    editingLegs = [];
    refreshView();
  });

  document.getElementById("commute-edit-btn").addEventListener("click", () => {
    const commute = loadCommute();
    editingLegs = commute ? commute.legs.map(l => ({...l})) : [ blankLeg() ];
    savedBox.style.display = "none";
    builder.style.display  = "block";
    document.getElementById("commute-cancel-btn").style.display = "";
    renderBuilder();
  });

  document.getElementById("commute-clear-btn").addEventListener("click", () => {
    if (confirm("保存したルートを削除しますか？")) {
      clearCommuteStorage();
      clearCommuteHighlights();
      exitCommuteMode();
      editingLegs = [];
      refreshView();
      updateCommuteModeButton();
    }
  });

  document.getElementById("commute-show-btn").addEventListener("click", () => {
    hide();
    applyCommute();
  });

  document.getElementById("commute-reverse-btn").addEventListener("click", () => {
    const commute = loadCommute();
    if (!commute || !commute.legs) return;
    // Reverse the journey: reverse leg order AND swap each leg's from/to.
    // The transfer walk time (xferMin) shifts to the leg that now precedes it.
    const reversed = commute.legs.slice().reverse().map(l => ({
      line: l.line, from: l.to, to: l.from, xferMin: l.xferMin,
    }));
    // Re-assign walk times: in the reversed route, the walk time belongs to the
    // leg you board AFTER a transfer. Shift them so they line up sensibly.
    const walkTimes = commute.legs.map(l => l.xferMin ?? 5);
    // Original walk times apply between leg i-1 and i. After reversing, the
    // transfer between reversed legs k and k+1 corresponds to the original
    // transfer between legs (n-1-k-1) and (n-1-k). Simplest: reuse in reverse.
    const rWalks = walkTimes.slice(1).reverse();  // transfers only
    for (let k = 1; k < reversed.length; k++) {
      reversed[k].xferMin = rWalks[k-1] ?? 5;
    }
    saveCommute({ legs: reversed, savedAt: Date.now() });
    refreshView();
    applyCommute();
  });
}

// Apply the saved commute to the map: filter to its lines + highlight its stations.
let commuteModeActive = false;

function applyCommute() {
  const commute = loadCommute();
  if (!commute || !commute.legs || !commute.legs.length) return;

  commuteModeActive = true;
  updateCommuteModeButton();

  // 1. Filter lines to only those in the commute
  const commuteLines = new Set(commute.legs.map(l => l.line));
  activeLines = new Set(commuteLines);
  document.querySelectorAll(".line-btn").forEach(b => {
    const id = b.dataset.lid;
    b.classList.toggle("active", commuteLines.has(id));
  });
  updateLineVis();
  updateToggleBtn();

  // 2. Highlight the commute stations and fit the map to them
  clearCommuteHighlights();
  const pts = [];
  commute.legs.forEach((leg, li) => {
    [leg.from, leg.to].forEach((sid, idx) => {
      const s = stationData[sid];
      if (!s) return;
      pts.push([s.lng, s.lat]);
      const isHome = li===0 && idx===0;
      const isWork = li===commute.legs.length-1 && idx===1;
      const kind = isHome ? "home" : isWork ? "work" : "transfer";
      let travelFrom = leg.from, travelTo = leg.to;
      if (idx === 1 && li < commute.legs.length - 1) {
        travelFrom = commute.legs[li+1].from;
        travelTo   = commute.legs[li+1].to;
      }
      // Context lets a transfer station compute earliest catchable train:
      //   legIndex = which leg the user BOARDS here
      //   isTransferPoint = arrival station that's also a boarding point
      const boardLegIndex = (idx === 1 && li < commute.legs.length - 1) ? li+1 : li;
      addCommuteHighlight(s, kind, {
        from: travelFrom, to: travelTo,
        commute, boardLegIndex,
        isTransferPoint: (kind === "transfer"),
      });
    });
  });

  if (pts.length >= 2) {
    const lngs = pts.map(p=>p[0]), lats = pts.map(p=>p[1]);
    const bounds = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
    map.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 1000 });
  } else if (pts.length === 1) {
    map.flyTo({ center: pts[0], zoom: 14 });
  }
}

// Exit commute mode → show all lines and trains again.
function exitCommuteMode() {
  commuteModeActive = false;
  updateCommuteModeButton();
  clearCommuteHighlights();
  // Turn all lines back on
  activeLines = new Set(Object.keys(LINE_META));
  document.querySelectorAll(".line-btn").forEach(b => b.classList.add("active"));
  updateLineVis();
  updateToggleBtn();
}

// Toggle button in the header switches between commute view and normal view.
function updateCommuteModeButton() {
  const btn = document.getElementById("commute-mode-toggle");
  if (!btn) return;
  const hasCommute = !!(loadCommute()?.legs?.length);
  btn.style.display = hasCommute ? "" : "none";
  if (commuteModeActive) {
    btn.textContent = "🗺 全路線表示";
    btn.classList.add("active");
  } else {
    btn.textContent = "🚊 マイルート表示";
    btn.classList.remove("active");
  }
}

function setupCommuteModeToggle() {
  const btn = document.getElementById("commute-mode-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (commuteModeActive) exitCommuteMode();
    else applyCommute();
  });
  updateCommuteModeButton();
}

function addCommuteHighlight(s, kind, travel) {
  const colors = { home: "#00e676", work: "#00b4ff", transfer: "#ffaa00" };
  const c = colors[kind] || "#fff";

  // NO EMOJI. Emojis render at unpredictable sizes and load timing, which
  // throws off MapLibre's center measurement so later markers drift on zoom.
  // A pure CSS ring + inner dot has a guaranteed fixed size and stays anchored.
  // A tiny 1x1 center point is used as the marker element, and the visible
  // ring is drawn with an absolutely-centered child that has NO layout effect,
  // so MapLibre always measures the same (1x1) box and centers it perfectly.
  const el = document.createElement("div");
  el.className = "commute-highlight commute-highlight-" + kind;
  el.style.cssText = "width:0;height:0;";
  el.innerHTML =
    `<div class="commute-hl-ring" style="border-color:${c};color:${c};">` +
    `<span class="commute-hl-dot" style="background:${c};"></span></div>`;

  const marker = new maplibregl.Marker({ element: el, anchor: "center", offset: [0, 0] })
    .setLngLat([s.lng, s.lat]).addTo(map);
  marker.getElement().style.zIndex = "6";

  // Clickable → show the commute-station panel with next departures.
  el.style.pointerEvents = "auto";
  el.style.cursor = "pointer";
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    showCommuteStationPanel(s, kind, travel);
  });

  commuteMarkers.push(marker);
}

// Panel for a clicked commute marker: role + station name + next 5 trains.
async function showCommuteStationPanel(s, kind, travel) {
  const roleLabel = { home: "\uD83D\uDEA9 DEPARTURE / \u51FA\u767A", work: "\uD83C\uDFC1 ARRIVAL / \u5230\u7740", transfer: "\uD83D\uDD04 TRANSFER / \u4E57\u308A\u63DB\u3048" }[kind] || "";
  const roleColor = { home: "#00e676", work: "#00b4ff", transfer: "#ffaa00" }[kind] || "#fff";
  const staName = s.titleJa || s.titleEn;
  const lineKey = getLineKey(s.railway);
  const meta = LINE_META[lineKey] || {};

  // WORK (destination) marker: show ARRIVAL times, not departures. Compute the
  // next trains arriving here from the final leg's boarding station.
  if (kind === "work" && travel?.commute) {
    setInfoPanel({
      type: roleLabel, color: roleColor, name: staName,
      sub: `${meta.en||""}  \uFF0F  ${meta.jp||""}`,
      html: `<div class="info-row"><span class="info-key">\u8DEF\u7DDA</span><span class="info-val" style="color:${meta.color}">${meta.jp||meta.en||"\u2014"}</span></div>
             <div class="info-divider"></div>
             <div class="commute-tt-title">\u5230\u7740\u6642\u523B / ARRIVALS</div>
             <div id="commute-tt-list"><div class="commute-tt-loading">\u8AAD\u307F\u8FBC\u307F\u4E2D... / Loading\u2026</div></div>`,
    });
    await showWorkArrivals(s, travel);
    return;
  }

  setInfoPanel({
    type  : roleLabel,
    color : roleColor,
    name  : staName,
    sub   : `${meta.en||""}  \uFF0F  ${meta.jp||""}`,
    html  : `<div class="info-row"><span class="info-key">\u8DEF\u7DDA</span><span class="info-val" style="color:${meta.color}">${meta.jp||meta.en||"\u2014"}</span></div>
             <div class="info-divider"></div>
             <div class="commute-tt-title">\u6B21\u306E\u767A\u8ECA / NEXT DEPARTURES</div>
             <div id="commute-tt-list"><div class="commute-tt-loading">\u8AAD\u307F\u8FBC\u307F\u4E2D... / Loading\u2026</div></div>`,
  });

  try {
    const res = await apiFetch(`/api/station-timetable?station=${encodeURIComponent(s.id)}`);
    const list = document.getElementById("commute-tt-list");
    if (!list) return;

    if (res.error || !res.timetables || !res.timetables.length) {
      list.innerHTML = `<div class="commute-tt-loading">\u6642\u523B\u8868\u30C7\u30FC\u30BF\u304C\u3042\u308A\u307E\u305B\u3093 / No timetable</div>`;
      return;
    }

    let now = tokyoNowMinutes();

    // If this is a TRANSFER point, don't start from the clock — start from when
    // the user can realistically catch a train here: their ACTUAL scheduled
    // arrival from the previous leg (from the train timetable) + their personal
    // walk/transfer time (乗り換え時間).
    let transferNote = "";
    if (travel?.isTransferPoint && travel.commute && travel.boardLegIndex > 0) {
      const prevLeg  = travel.commute.legs[travel.boardLegIndex - 1];
      const boardLeg = travel.commute.legs[travel.boardLegIndex];
      const walkMin  = boardLeg?.xferMin ?? 5;

      // Ask the server for the real train: earliest train on the PREVIOUS leg
      // departing prevLeg.from after 'now', and when it ARRIVES at this station.
      try {
        const jr = await apiFetch(
          `/api/journey?railway=${encodeURIComponent(prevLeg.line)}`
          + `&from=${encodeURIComponent(prevLeg.from)}`
          + `&to=${encodeURIComponent(s.id)}`
          + `&after=${tokyoNowMinutes()}`
        );
        if (jr && !jr.error && jr.arrMins != null) {
          // Ready to board here = scheduled arrival + walk time.
          now = jr.arrMins + walkMin;
          const arrHM = jr.arrTime || minutesToHM(jr.arrMins);
          transferNote = `<div class="commute-tt-note">🚶 ${arrHM}着 + 徒歩${walkMin}分 → ${minutesToHM(now)}以降 / after ${walkMin}-min transfer</div>`;
        } else {
          // Fallback: rough estimate if the journey lookup fails.
          const pFrom = stationData[prevLeg.from]?.order;
          const pTo   = stationData[s.id]?.order;
          const rideMin = (pFrom!=null && pTo!=null) ? Math.abs(pTo-pFrom)*2 : 0;
          now = tokyoNowMinutes() + rideMin + walkMin;
          transferNote = `<div class="commute-tt-note">🚶 乗り換え徒歩 ${walkMin}分を考慮 / after ${walkMin}-min transfer</div>`;
        }
      } catch {
        const pFrom = stationData[prevLeg.from]?.order;
        const pTo   = stationData[s.id]?.order;
        const rideMin = (pFrom!=null && pTo!=null) ? Math.abs(pTo-pFrom)*2 : 0;
        now = tokyoNowMinutes() + rideMin + walkMin;
        transferNote = `<div class="commute-tt-note">🚶 乗り換え徒歩 ${walkMin}分を考慮 / after ${walkMin}-min transfer</div>`;
      }
    }
    const lineDelaySec = currentLineDelaySec(lineKey);
    const todayCal = todayCalendarKey();   // "Weekday" or "SaturdayHoliday"

    // Which direction does the USER travel on this leg? Compare the station
    // order of their boarding station vs their destination. Trains heading the
    // same way (their destination is on the same side as the user's "to") are
    // the only ones we show.
    const fromOrder = stationData[travel?.from]?.order;
    const toOrder   = stationData[travel?.to]?.order;
    const userGoesUp = (fromOrder != null && toOrder != null) ? (toOrder > fromOrder) : null;

    // Figure out the ODPT railDirection the user travels, by finding which
    // direction's timetable contains a departure whose destination sits toward
    // the user's "to" station. Then keep only that direction (reliable even for
    // through-service destinations we don't have coordinates for).
    const thisOrder = stationData[s.id]?.order;
    const todaysTimetables = res.timetables.filter(tt => {
      if (getLineKey(tt.railway) !== lineKey) return false;
      const cal = tt.calendar || "";
      return todayCal === "SaturdayHoliday"
        ? (cal.includes("Saturday") || cal.includes("Holiday"))
        : cal.includes("Weekday");
    });

    // Score each direction by how many of its departures head the user's way.
    let userDirection = null;
    if (userGoesUp != null && thisOrder != null) {
      let bestScore = -1;
      for (const tt of todaysTimetables) {
        let score = 0;
        for (const d of tt.departures) {
          const destOrder = stationData[d.dest]?.order;
          if (destOrder == null) continue;
          const depGoesUp = destOrder > thisOrder;
          if (depGoesUp === userGoesUp) score++;
        }
        if (score > bestScore) { bestScore = score; userDirection = tt.direction; }
      }
    }

    let deps = [];
    for (const tt of todaysTimetables) {
      // If we identified the user's direction, keep only that one.
      if (userDirection && tt.direction !== userDirection) continue;
      for (const d of tt.departures) {
        const mins = hmToMinutes(d.time);
        if (mins == null) continue;
        deps.push({ ...d, mins });
      }
    }

    // Next 5 upcoming in the user's direction.
    deps = deps.filter(d => d.mins >= now).sort((a,b) => a.mins - b.mins).slice(0, 5);

    if (deps.length === 0) {
      list.innerHTML = `<div class="commute-tt-loading">\u672C\u65E5\u306E\u6B8B\u308A\u767A\u8ECA\u306A\u3057 / No more today</div>`;
      return;
    }

    const late = lineDelaySec >= 60;
    const statusText = late ? `+${Math.round(lineDelaySec/60)}\u5206\u9045\u308C` : "\u5B9A\u523B";
    const statusColor = late ? "#ff3b3b" : "#00e676";

    // Show the destination the user is heading toward as a small header.
    const toName = (stationData[travel?.to]?.titleJa) || "";
    let html = transferNote;
    html += toName ? `<div class="commute-tt-dir">${toName}\u65B9\u9762 / toward ${toName}</div>` : "";
    html += deps.map(d => {
      const destName = (stationData[d.dest]?.titleJa) || (d.dest ? d.dest.split(".").pop() : "");
      return `<div class="commute-tt-row">
        <span class="commute-tt-time">${d.time}</span>
        <span class="commute-tt-status" style="color:${statusColor}">\uFF08${statusText}\uFF09</span>
        <span class="commute-tt-dest">${destName ? destName+"\u884C" : ""}</span>
      </div>`;
    }).join("");

    list.innerHTML = html;
  } catch (e) {
    const list = document.getElementById("commute-tt-list");
    if (list) list.innerHTML = `<div class="commute-tt-loading">\u8AAD\u307F\u8FBC\u307F\u30A8\u30E9\u30FC / Error</div>`;
  }
}

// Today's calendar key in Tokyo: "Weekday" or "SaturdayHoliday".
function todayCalendarKey() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const day = now.getDay(); // 0 Sun .. 6 Sat
  return (day === 0 || day === 6) ? "SaturdayHoliday" : "Weekday";
}

// Human-readable direction label from an ODPT railDirection id.
function directionLabel(dir) {
  if (!dir) return "\u767A\u8ECA / Departures";
  const tail = dir.split(".").pop();  // e.g. "Eastbound"
  const map = {
    Eastbound:  "\u6771\u65B9\u9762 (Eastbound)",
    Westbound:  "\u897F\u65B9\u9762 (Westbound)",
    Northbound: "\u5317\u65B9\u9762 (Northbound)",
    Southbound: "\u5357\u65B9\u9762 (Southbound)",
    Inbound:    "\u4E0A\u308A (Inbound)",
    Outbound:   "\u4E0B\u308A (Outbound)",
  };
  return map[tail] || tail;
}

function tokyoNowMinutes() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return now.getHours()*60 + now.getMinutes();
}
function hmToMinutes(hm) {
  if (!hm || !hm.includes(":")) return null;
  const [h,m] = hm.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h*60 + m;
}
// Minutes-since-midnight → "HH:MM" (handles >24h by wrapping).
function minutesToHM(mins) {
  if (mins == null) return "";
  const t = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(t/60), m = t%60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

// Show the next arrivals at the WORK (final destination) station: for the last
// leg, find the next trains from its boarding station and show when each
// reaches here. Chains through transfers by walking each leg in sequence.
async function showWorkArrivals(s, travel) {
  const list = document.getElementById("commute-tt-list");
  if (!list) return;
  const commute = travel.commute;
  const lineDelaySec = currentLineDelaySec(getLineKey(s.railway));
  const late = lineDelaySec >= 60;
  const statusText = late ? `+${Math.round(lineDelaySec/60)}\u5206\u9045\u308C` : "\u5B9A\u523B";
  const statusColor = late ? "#ff3b3b" : "#00e676";

  try {
    // Walk the whole journey for the next few start times, computing the final
    // arrival at work for each. Iterate the first leg's departures, chaining
    // each subsequent leg with the walk time.
    let startAfter = tokyoNowMinutes();
    const arrivals = [];
    const seenArr = new Set();     // dedupe identical final arrivals
    let guard = 0;

    while (arrivals.length < 5 && guard < 20) {
      guard++;
      let curAfter = startAfter;
      let ok = true;
      let firstDep = null;

      for (let li = 0; li < commute.legs.length; li++) {
        const leg = commute.legs[li];
        const jr = await apiFetch(
          `/api/journey?railway=${encodeURIComponent(leg.line)}`
          + `&from=${encodeURIComponent(leg.from)}`
          + `&to=${encodeURIComponent(leg.to)}`
          + `&after=${curAfter}`
        );
        if (!jr || jr.error || jr.arrMins == null) { ok = false; break; }
        if (li === 0) firstDep = jr.depMins;
        const nextWalk = commute.legs[li+1]?.xferMin ?? 0;
        curAfter = jr.arrMins + nextWalk;
        if (li === commute.legs.length - 1) {
          // Only add if this is a new arrival (avoids repeats from convergence).
          if (!seenArr.has(jr.arrMins)) {
            seenArr.add(jr.arrMins);
            arrivals.push({ arrMins: jr.arrMins, depMins: firstDep });
          }
        }
      }
      if (!ok) break;
      // Advance to just after this run's first departure so the next loop finds
      // the following train. If firstDep didn't advance, force it forward.
      const nextStart = (firstDep != null ? firstDep : startAfter) + 1;
      startAfter = Math.max(nextStart, startAfter + 1);
    }

    // Sort by arrival time so the list is always chronological.
    arrivals.sort((a,b) => a.arrMins - b.arrMins);

    if (arrivals.length === 0) {
      list.innerHTML = `<div class="commute-tt-loading">\u672C\u65E5\u306E\u5230\u7740\u60C5\u5831\u306A\u3057 / No more arrivals today</div>`;
      return;
    }

    const homeName = stationData[commute.legs[0].from]?.titleJa || "";
    let html = homeName ? `<div class="commute-tt-dir">${homeName}\u767A \u2192 \u5230\u7740 / from ${homeName}</div>` : "";
    html += arrivals.map(a => {
      return `<div class="commute-tt-row">
        <span class="commute-tt-time">${minutesToHM(a.arrMins)}</span>
        <span class="commute-tt-status" style="color:${statusColor}">\uFF08${statusText}\uFF09</span>
        <span class="commute-tt-dest">${minutesToHM(a.depMins)}\u767A</span>
      </div>`;
    }).join("");
    list.innerHTML = html;
  } catch (e) {
    list.innerHTML = `<div class="commute-tt-loading">\u8AAD\u307F\u8FBC\u307F\u30A8\u30E9\u30FC / Error</div>`;
  }
}
function currentLineDelaySec(lineKey) {
  let maxDelay = 0;
  for (const v of allVehicles) {
    if (getLineKey(v.routeId) === lineKey) maxDelay = Math.max(maxDelay, v.delaySec || 0);
  }
  return maxDelay;
}

function clearCommuteHighlights() {
  commuteMarkers.forEach(m => m.remove());
  commuteMarkers = [];
}

// On startup, if a commute is saved, apply it automatically.
function autoApplyCommuteOnLoad() {
  const commute = loadCommute();
  if (commute && commute.legs && commute.legs.length) {
    applyCommute();
  }
}

let flashMarker = null;
function flashStation(s) {
  if (flashMarker) flashMarker.remove();
  const el = document.createElement("div");
  el.className = "search-flash";
  flashMarker = new maplibregl.Marker({ element: el, anchor: "center" })
    .setLngLat([s.lng, s.lat]).addTo(map);
  setTimeout(() => { if (flashMarker) { flashMarker.remove(); flashMarker = null; } }, 3000);
}

main().catch(err => {
  document.getElementById("loading-status").textContent = "ERROR: " + err.message;
  document.getElementById("loading-bar").style.background = "#ff3b3b";
  console.error(err);
});