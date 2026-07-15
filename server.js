/**
 * server.js — Toei Transit Real-Time Map Backend
 * Loads GTFS static trips.txt for definitive trip→route mapping.
 */

import express from "express";
import cors    from "cors";
import { fileURLToPath } from "url";
import { dirname, join }  from "path";
import protobuf from "protobufjs";

const { default: fetch } = await import("node-fetch");
const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(join(__dirname, "public")));

// ODPT API key. On Render (or any host) set an env var ODPT_KEY in the
// dashboard. The fallback lets it still run locally without setting anything.
const KEY  = process.env.ODPT_KEY || "2swbs2ofcui4yan1ri19phbxes2r5gxdxhhxbomczfuayo6jobyrl1atiyyy68ym";
const BASE = "https://api.odpt.org/api/v4";

const FEEDS = {
  vehicles : `${BASE}/gtfs/realtime/toei_odpt_train_vehicle?acl:consumerKey=${KEY}`,
  trips    : `${BASE}/gtfs/realtime/toei_odpt_train_trip_update?acl:consumerKey=${KEY}`,
  alerts   : `${BASE}/gtfs/realtime/toei_odpt_train_alert?acl:consumerKey=${KEY}`,
};
const JSON_ENDPOINTS = {
  trainInfo : `${BASE}/odpt:TrainInformation?odpt:operator=odpt.Operator:Toei&acl:consumerKey=${KEY}`,
  stations  : `${BASE}/odpt:Station?odpt:operator=odpt.Operator:Toei&acl:consumerKey=${KEY}`,
  railways  : `${BASE}/odpt:Railway?odpt:operator=odpt.Operator:Toei&acl:consumerKey=${KEY}`,
  // #7 Train location — gives odpt:trainNumber + odpt:railway (the OFFICIAL line)
  trains    : `${BASE}/odpt:Train?odpt:operator=odpt.Operator:Toei&acl:consumerKey=${KEY}`,
};

// ── GTFS static trip→route map ────────────────────────────────────────
let staticTripRouteMap = {};

async function loadGtfsStatic() {
  const GTFS_URL = `https://api.odpt.org/api/v4/files/Toei/data/Toei-Train-GTFS.zip?acl:consumerKey=${KEY}`;

  // route_short_name / numeric id → full railway key
  const ROUTE_NAME_MAP = {
    "A"  : "odpt.Railway:Toei.Asakusa",
    "I"  : "odpt.Railway:Toei.Mita",
    "S"  : "odpt.Railway:Toei.Shinjuku",
    "E"  : "odpt.Railway:Toei.Oedo",
    "SA" : "odpt.Railway:Toei.Arakawa",
    "NT" : "odpt.Railway:Toei.NipporiToneri",
    "1"  : "odpt.Railway:Toei.Asakusa",
    "2"  : "odpt.Railway:Toei.Mita",
    "3"  : "odpt.Railway:Toei.Shinjuku",
    "4"  : "odpt.Railway:Toei.Oedo",
    "5"  : "odpt.Railway:Toei.Arakawa",
    "6"  : "odpt.Railway:Toei.NipporiToneri",
  };

  try {
    console.log("Loading GTFS static data...");
    const res = await fetch(GTFS_URL, { timeout: 30000 });
    if (!res.ok) {
      console.warn(`  GTFS static: HTTP ${res.status} — will use ID inference instead`);
      return;
    }

    const { default: JSZip } = await import("jszip");
    const buf = await res.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);

    // ── Parse routes.txt → routeId → railway key ──────────────────
    const routeMap = {};
    if (zip.files["routes.txt"]) {
      const txt  = await zip.files["routes.txt"].async("text");
      const rows = txt.trim().split("\n");
      const hdrs = rows[0].split(",").map(h => h.trim().replace(/"/g, ""));
      const idIdx = hdrs.indexOf("route_id");
      const snIdx = hdrs.indexOf("route_short_name");

      for (let i = 1; i < rows.length; i++) {
        const cols    = rows[i].split(",").map(c => c.trim().replace(/"/g, ""));
        const routeId = cols[idIdx] || "";
        const short   = cols[snIdx] || "";
        const rwKey   = ROUTE_NAME_MAP[short] || "";
        if (routeId && rwKey) routeMap[routeId] = rwKey;
      }
      console.log(`  routes.txt: ${Object.keys(routeMap).length} routes mapped`);
    }

    // ── Parse trips.txt → tripId → railway key ────────────────────
    if (zip.files["trips.txt"]) {
      const txt  = await zip.files["trips.txt"].async("text");
      const rows = txt.trim().split("\n");
      const hdrs = rows[0].split(",").map(h => h.trim().replace(/"/g, ""));
      const ridIdx = hdrs.indexOf("route_id");
      const tidIdx = hdrs.indexOf("trip_id");

      let count = 0;
      for (let i = 1; i < rows.length; i++) {
        const cols    = rows[i].split(",").map(c => c.trim().replace(/"/g, ""));
        const routeId = cols[ridIdx] || "";
        const tripId  = cols[tidIdx] || "";
        const rwKey   = routeMap[routeId] || "";
        if (tripId && rwKey) {
          staticTripRouteMap[tripId] = rwKey;
          count++;
        }
      }
      console.log(`  trips.txt: ${count} trip→route mappings loaded ✓`);
    }

  } catch (err) {
    console.warn("  GTFS static load error:", err.message, "— using ID inference");
  }
}

// ── Vehicle ID suffix → railway key (fallback when GTFS static unavailable) ──
const SUFFIX_MAP = {
  "NT" : "odpt.Railway:Toei.NipporiToneri",
  "SA" : "odpt.Railway:Toei.Arakawa",
  "TB" : "odpt.Railway:Toei.Asakusa",
  "TA" : "odpt.Railway:Toei.Asakusa",
  "TC" : "odpt.Railway:Toei.Asakusa",
  "H"  : "odpt.Railway:Toei.Arakawa",
  "T"  : "odpt.Railway:Toei.Asakusa",
  "N"  : "odpt.Railway:Toei.NipporiToneri",
  "K"  : "odpt.Railway:Toei.Shinjuku",
  "G"  : "odpt.Railway:Toei.Oedo",
  "E"  : "odpt.Railway:Toei.Oedo",
  "I"  : "odpt.Railway:Toei.Mita",
  "M"  : "odpt.Railway:Toei.Mita",
  "B"  : "odpt.Railway:Toei.Mita",
  "S"  : "odpt.Railway:Toei.Shinjuku",
  "A"  : "odpt.Railway:Toei.Asakusa",
  "O"  : "odpt.Railway:Toei.Oedo",
};

function inferRailway(vehicleId, tripId) {
  const id = vehicleId || tripId || "";

  // Pure 8-digit numeric IDs = Tokyo Sakura Tram (Arakawa line / 都電荒川線).
  // Verified by coordinates: these trace the tram route (Waseda→Minowabashi),
  // NOT the Oedo loop. Prefixes observed: 60, 61, 66, 67.
  if (/^\d{8}$/.test(id)) {
    const n = parseInt(id, 10);
    if (n >= 60000000 && n < 68000000) return "odpt.Railway:Toei.Arakawa";
  }

  const m  = id.match(/^(\d+)([A-Za-z]+)\d*$/);
  if (!m) return "";

  const prefix  = parseInt(m[1], 10);
  const letters = m[2].toUpperCase();

  // Number-prefix based rules (confirmed from live data)
  if (prefix >= 420000 && prefix < 430000) {
    if (letters === "B") return "odpt.Railway:Toei.Mita";
  }
  if (prefix >= 430000 && prefix < 440000) {
    if (letters === "A") return "odpt.Railway:Toei.Asakusa";
  }
  if (prefix >= 120000 && prefix < 130000) {
    if (letters === "H")               return "odpt.Railway:Toei.Arakawa";
    // N suffix: NipporiToneri NOT in feed per ODPT docs → reassign to Asakusa
    if (letters === "N" || letters === "NT") return "odpt.Railway:Toei.Asakusa";
    if (letters === "K" || letters === "KB") return "odpt.Railway:Toei.Shinjuku";
    if (letters === "T" || letters === "TB") return "odpt.Railway:Toei.Asakusa";
  }
  if (prefix >= 130000 && prefix < 140000) {
    if (letters === "T" || letters === "TB" || letters === "TA") return "odpt.Railway:Toei.Asakusa";
    if (letters === "H")               return "odpt.Railway:Toei.Arakawa";
    // N suffix: not NipporiToneri → Asakusa
    if (letters === "N" || letters === "NT") return "odpt.Railway:Toei.Asakusa";
    if (letters === "K" || letters === "KB") return "odpt.Railway:Toei.Shinjuku";
  }
  if (prefix >= 220000 && prefix < 230000) {
    if (letters === "T")  return "odpt.Railway:Toei.Shinjuku";
    if (letters === "K")  return "odpt.Railway:Toei.Shinjuku";
    if (letters === "G" || letters === "E") return "odpt.Railway:Toei.Oedo";
  }
  if (prefix >= 230000 && prefix < 240000) {
    if (letters === "T" || letters === "TB") return "odpt.Railway:Toei.Oedo";
    if (letters === "K")  return "odpt.Railway:Toei.Shinjuku";
    if (letters === "G" || letters === "E") return "odpt.Railway:Toei.Oedo";
  }
  if (prefix >= 320000 && prefix < 340000) {
    if (letters === "T" || letters === "TB") return "odpt.Railway:Toei.Asakusa";
  }

  // Suffix-only fallback
  for (let len = letters.length; len >= 1; len--) {
    const key = SUFFIX_MAP[letters.slice(0, len)];
    if (key) return key;
  }
  return "";
}

// ── Coordinate-based correction ───────────────────────────────────────
// Uses actual Toei line geographic bounding boxes to reassign misidentified trains.
// Each line has a known geographic corridor — if a train is outside its assigned
// line's corridor, reassign to whichever line it actually fits.

// Nearest-station lookup — built once after stations load
// stationsByLine: { railwayId → [{lat, lng}] }
let stationsByLine = {};

function buildStationIndex(stations) {
  stationsByLine = {};
  for (const s of stations) {
    if (!s.railway || !s.lat || !s.lng) continue;
    if (!stationsByLine[s.railway]) stationsByLine[s.railway] = [];
    stationsByLine[s.railway].push({ lat: s.lat, lng: s.lng });
  }
}

// Squared distance (no sqrt needed for comparison)
function dist2(lat1, lng1, lat2, lng2) {
  const dlat = lat1 - lat2;
  const dlng = (lng1 - lng2) * Math.cos(lat1 * Math.PI / 180);
  return dlat * dlat + dlng * dlng;
}

// Find the railway whose nearest station is closest to this position.
// Only considers lines that have vehicle tracking (not Nippori-Toneri).
const VEHICLE_LINES = [
  "odpt.Railway:Toei.Asakusa",
  "odpt.Railway:Toei.Mita",
  "odpt.Railway:Toei.Shinjuku",
  "odpt.Railway:Toei.Oedo",
  "odpt.Railway:Toei.Arakawa",
  // NipporiToneri excluded — not in GTFS-RT feed per ODPT documentation
];

function nearestLine(lat, lng) {
  let bestLine = null;
  let bestDist = Infinity;
  for (const line of VEHICLE_LINES) {
    const stations = stationsByLine[line] || [];
    for (const s of stations) {
      const d = dist2(lat, lng, s.lat, s.lng);
      if (d < bestDist) { bestDist = d; bestLine = line; }
    }
  }
  return bestLine;
}

function correctByPosition(routeId, lat, lng) {
  if (Object.keys(stationsByLine).length === 0) return routeId;

  // Trams are handled separately (numeric IDs). Here we only choose among
  // the SUBWAY lines, so a subway train near the tram corridor never gets
  // mislabeled as a tram, and vice versa.
  const assignedDist = routeId ? nearestStationDist(routeId, lat, lng) : Infinity;
  const { line: closestLine, dist: closestDist } = nearestSubwayWithDist(lat, lng);

  // Reassign only if another subway line is clearly closer (>330m).
  if (closestLine && closestDist < assignedDist - 0.003) {
    return closestLine;
  }
  return routeId || closestLine || "";
}

// Nearest SUBWAY line (excludes the Arakawa tram)
function nearestSubwayWithDist(lat, lng) {
  const subways = [
    "odpt.Railway:Toei.Asakusa",
    "odpt.Railway:Toei.Mita",
    "odpt.Railway:Toei.Shinjuku",
    "odpt.Railway:Toei.Oedo",
  ];
  let bestLine = null, bestDist = Infinity;
  for (const line of subways) {
    const d = nearestStationDist(line, lat, lng);
    if (d < bestDist) { bestDist = d; bestLine = line; }
  }
  return { line: bestLine, dist: bestDist };
}

// Distance from position to nearest station on a specific line
function nearestStationDist(line, lat, lng) {
  const stations = stationsByLine[line] || [];
  let best = Infinity;
  for (const s of stations) {
    const d = Math.sqrt(dist2(lat, lng, s.lat, s.lng));
    if (d < best) best = d;
  }
  return best;
}

// Nearest line + its distance
function nearestLineWithDist(lat, lng) {
  let bestLine = null, bestDist = Infinity;
  for (const line of VEHICLE_LINES) {
    const d = nearestStationDist(line, lat, lng);
    if (d < bestDist) { bestDist = d; bestLine = line; }
  }
  return { line: bestLine, dist: bestDist };
}

// ── Protobuf schema ───────────────────────────────────────────────────
const PROTO = `
  syntax = "proto2";
  package transit_realtime;
  message FeedMessage {
    required FeedHeader header = 1;
    repeated FeedEntity entity = 2;
  }
  message FeedHeader {
    required string gtfs_realtime_version = 1;
    optional uint64 timestamp = 3;
  }
  message FeedEntity {
    required string id = 1;
    optional VehiclePosition vehicle = 4;
    optional Alert alert = 5;
    optional TripUpdate trip_update = 3;
  }
  message VehiclePosition {
    optional TripDescriptor trip = 1;
    optional VehicleDescriptor vehicle = 8;
    optional Position position = 2;
    optional string stop_id = 7;
    optional uint32 current_status = 4;
    optional uint64 timestamp = 5;
  }
  message TripUpdate {
    optional TripDescriptor trip = 1;
    optional VehicleDescriptor vehicle = 3;
    repeated StopTimeUpdate stop_time_update = 2;
  }
  message StopTimeUpdate {
    optional uint32 stop_sequence = 1;
    optional string stop_id = 4;
    optional StopTimeEvent arrival = 2;
    optional StopTimeEvent departure = 3;
  }
  message StopTimeEvent {
    optional int32 delay = 1;
    optional int64 time = 2;
  }
  message Position {
    required float latitude = 1;
    required float longitude = 2;
    optional float bearing = 3;
    optional float speed = 5;
  }
  message TripDescriptor {
    optional string trip_id = 1;
    optional string route_id = 5;
    optional uint32 direction_id = 6;
  }
  message VehicleDescriptor {
    optional string id = 1;
    optional string label = 2;
  }
  message Alert {
    optional TranslatedString header_text = 10;
    optional TranslatedString description_text = 11;
    repeated EntitySelector informed_entity = 5;
  }
  message EntitySelector { optional string route_id = 2; }
  message TranslatedString {
    repeated Translation translation = 1;
    message Translation { required string text = 1; optional string language = 2; }
  }
`;

const root = protobuf.parse(PROTO, { keepCase: true }).root;
const FeedMessage = root.lookupType("transit_realtime.FeedMessage");

async function fetchGtfsRt(url) {
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
}
async function fetchJson(url) {
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Cache ─────────────────────────────────────────────────────────────
let cache = { vehicles:[], alerts:[], trainInfo:[], railways:{}, railwaysFull:[], stations:[], lastUpdated:null };

async function refreshCache() {
  try {
    const [vpFeed, tripFeed, alertFeed, trainInfoData, railwaysData, stationsData, trainsData] =
      await Promise.all([
        fetchGtfsRt(FEEDS.vehicles),
        fetchGtfsRt(FEEDS.trips),
        fetchGtfsRt(FEEDS.alerts),
        fetchJson(JSON_ENDPOINTS.trainInfo),
        fetchJson(JSON_ENDPOINTS.railways),
        fetchJson(JSON_ENDPOINTS.stations),
        fetchJson(JSON_ENDPOINTS.trains).catch(() => []),  // #7, optional
      ]);

    // Build a list of officially-located trains from the #7 feed.
    // Each #7 train has a fromStation (its current station) and the official
    // railway. We look up the station's coordinates so we can match each
    // GPS vehicle to the nearest officially-known train → official line.
    // (The #7 trainNumber doesn't match the protobuf vehicleId, so we match
    //  by POSITION instead.)
    const officialTrains = [];   // [{ lat, lng, railway }]
    if (Array.isArray(trainsData)) {
      // Build a quick station-id → {lat,lng} lookup from the stations feed
      const stationCoord = {};
      for (const s of stationsData) {
        const id = s["owl:sameAs"];
        if (id && s["geo:lat"] && s["geo:long"]) {
          stationCoord[id] = { lat: s["geo:lat"], lng: s["geo:long"] };
        }
      }
      for (const t of trainsData) {
        const rw = t["odpt:railway"];
        const fromSt = t["odpt:fromStation"];
        const toSt   = t["odpt:toStation"];
        const c = stationCoord[fromSt] || stationCoord[toSt];
        const delay = t["odpt:delay"] || 0;   // per-train delay in SECONDS
        const dir   = t["odpt:railDirection"] || "";
        if (rw && c) officialTrains.push({
          lat: c.lat, lng: c.lng, railway: rw, delay,
          fromStation: fromSt || "", toStation: toSt || "", direction: dir,
        });
      }
    }

    // For a GPS point, return info about the nearest #7 train
    // (only if it's within ~1.2km — beyond that the match is unreliable).
    function officialInfoNear(lat, lng) {
      let best = null, bestD = Infinity;
      for (const t of officialTrains) {
        const dlat = lat - t.lat;
        const dlng = (lng - t.lng) * Math.cos(lat * Math.PI/180);
        const d = dlat*dlat + dlng*dlng;
        if (d < bestD) { bestD = d; best = t; }
      }
      // 0.00012 deg² ≈ (1.2km)² threshold
      if (best && bestD < 0.00012) return {
        railway: best.railway, delay: best.delay || 0,
        fromStation: best.fromStation, toStation: best.toStation, direction: best.direction,
      };
      return { railway: "", delay: 0, fromStation: "", toStation: "", direction: "" };
    }
    function officialLineNear(lat, lng) { return officialInfoNear(lat, lng).railway; }

    // Build tripId → routeId from TripUpdates (only full Toei keys)
    const tripRouteMap = {};
    for (const entity of tripFeed.entity) {
      const tu = entity.trip_update;
      if (!tu?.trip) continue;
      const tripId  = tu.trip.trip_id  || "";
      const routeId = tu.trip.route_id || "";
      if (tripId && routeId && routeId.includes("Toei")) tripRouteMap[tripId] = routeId;
    }

    // Parse vehicles
    const vehicles = [];
    for (const entity of vpFeed.entity) {
      const vp = entity.vehicle;
      if (!vp?.position) continue;
      const lat = vp.position.latitude;
      const lng = vp.position.longitude;
      if (!lat || !lng) continue;

      const vehicleId = vp.vehicle?.id || entity.id;
      const tripId    = vp.trip?.trip_id || "";
      const stopId    = vp.stop_id || "";   // e.g. odpt.Station:Toei.Asakusa.XXX

      // ── Line assignment, in priority order ────────────────────────
      // 1) #7 Train location feed matched BY POSITION (official line)
      // 2) GTFS static trips.txt (if it loaded)
      // 3) Vehicle-ID pattern inference
      // 4) TripUpdate cross-reference
      // 5) VehiclePosition route_id field
      let routeId = "";
      let lineSource = "";

      // Match this GPS vehicle to the nearest officially-located #7 train.
      const official = officialInfoNear(lat, lng);
      let trainDelay = 0;   // seconds, from matched #7 train
      let fromStation = "", toStation = "", railDirection = "";
      routeId = official.railway;
      if (routeId) {
        lineSource = "official";
        trainDelay = official.delay || 0;
        fromStation = official.fromStation || "";
        toStation   = official.toStation || "";
        railDirection = official.direction || "";
      }

      if (!routeId && tripId && staticTripRouteMap[tripId]) { routeId = staticTripRouteMap[tripId]; lineSource = "gtfs"; }
      if (!routeId) { routeId = inferRailway(vehicleId, tripId); if (routeId) lineSource = "infer"; }
      if (!routeId && tripId && tripRouteMap[tripId]) { routeId = tripRouteMap[tripId]; lineSource = "tripupdate"; }
      if (!routeId && vp.trip?.route_id) { routeId = vp.trip.route_id; lineSource = "vp"; }

      // ── Verify/correct line assignment by geographic position ──────
      // Tokyo Sakura Tram (Arakawa line) corridor — Waseda→Minowabashi.
      // The tram runs on surface streets in northern Tokyo:
      //   lat 35.705–35.755, lng 139.710–139.795
      const inArakawaBox =
        lat >= 35.705 && lat <= 35.755 && lng >= 139.710 && lng <= 139.795;

      const isNumeric = /^\d{8}$/.test(vehicleId);

      // Numeric IDs are trams. If a numeric-ID vehicle is inside the tram box,
      // lock it as Arakawa. If somehow outside, still trust numeric = tram.
      if (isNumeric) {
        routeId = "odpt.Railway:Toei.Arakawa";
      } else if (routeId === "odpt.Railway:Toei.Arakawa" && !inArakawaBox) {
        // A non-numeric vehicle wrongly tagged Arakawa but outside the tram
        // corridor is not really the tram — clear and re-decide.
        routeId = "";
      }

      // Lock trams (numeric or verified-in-box). Everything else may be
      // position-corrected against the subway lines — UNLESS we already have
      // the official line from the #7 feed, which we trust as-is.
      const isLockedTram = isNumeric ||
        (routeId === "odpt.Railway:Toei.Arakawa" && inArakawaBox);

      if (!isLockedTram && lineSource !== "official") {
        routeId = correctByPosition(routeId, lat, lng);
      }

      const ts = vp.timestamp ? Number(vp.timestamp) : null;

      // Staleness filter: skip trains whose position is older than 3 minutes.
      // A train frozen for that long has likely ended its run or left coverage.
      const STALE_SECONDS = 300; // 5 min — trains at terminals can idle a while
      if (ts) {
        const ageSec = (Date.now() / 1000) - ts;
        if (ageSec > STALE_SECONDS) continue;
      }

      vehicles.push({
        id: entity.id, vehicleId,
        label        : vp.vehicle?.label || "",
        routeId, tripId,
        lat, lng,
        bearing      : vp.position.bearing || 0,
        speed        : vp.position.speed   || 0,
        timestamp    : ts,
        ageSec       : ts ? Math.round((Date.now()/1000) - ts) : null,
        updatedAt    : ts ? new Date(ts*1000).toLocaleTimeString("ja-JP",{timeZone:"Asia/Tokyo"}) : "—",
        currentStatus: Number(vp.current_status ?? 2),
        stopId, lineSource,
        delaySec: trainDelay,   // per-train delay in seconds (from #7)
        fromStation, toStation, railDirection,   // for 前駅/次駅/停車中 display
      });
    }

    // Parse alerts
    const alerts = [];
    for (const entity of alertFeed.entity) {
      if (!entity.alert) continue;
      const a = entity.alert;
      alerts.push({
        header     : a.header_text?.translation?.[0]?.text      || "",
        description: a.description_text?.translation?.[0]?.text || "",
        routes     : (a.informed_entity||[]).map(e=>e.route_id).filter(Boolean),
      });
    }

    // Railway lookup
    const railways = {};
    for (const rw of railwaysData) {
      railways[rw["owl:sameAs"]] = {
        color: rw["odpt:color"] || "#00b4ff",
        en   : rw["odpt:railwayTitle"]?.en || rw["dc:title"] || "",
        ja   : rw["dc:title"] || "",
        code : rw["odpt:lineCode"] || "?",
      };
    }

    // Stations sorted by order
    const stationOrderMap = {};
    for (const rw of railwaysData) {
      for (const entry of rw["odpt:stationOrder"] || []) {
        stationOrderMap[entry["odpt:station"]] = entry["odpt:index"] || 999;
      }
    }
    const stations = stationsData
      .filter(s => s["geo:lat"] && s["geo:long"])
      .map(s => ({
        id      : s["owl:sameAs"],
        titleEn : s["odpt:stationTitle"]?.en || s["dc:title"] || "",
        titleJa : s["dc:title"] || "",
        railway : s["odpt:railway"] || "",
        lat     : s["geo:lat"],
        lng     : s["geo:long"],
        order   : stationOrderMap[s["owl:sameAs"]] ?? 999,
      }))
      .sort((a,b) => a.railway === b.railway ? a.order - b.order : a.railway.localeCompare(b.railway));

    const dist = {};
    for (const v of vehicles) dist[v.routeId||"?"] = (dist[v.routeId||"?"]||0)+1;
    console.log(`[${new Date().toLocaleTimeString()}] ✓ ${vehicles.length} vehicles | routes: ${JSON.stringify(dist)}`);

    buildStationIndex(stations);
    cache = {
      vehicles, alerts, trainInfo:trainInfoData, railways,
      railwaysFull:railwaysData, stations,
      officialTrainCount: officialTrains.length,
      trainsSample: Array.isArray(trainsData) ? trainsData.slice(0,2) : [],
      lastUpdated:new Date().toISOString(),
    };
  } catch(err) {
    console.error("Refresh error:", err.message);
  }
}

// ── Routes ────────────────────────────────────────────────────────────
app.get("/api/vehicles",      (_,res) => res.json({vehicles:cache.vehicles, lastUpdated:cache.lastUpdated, count:cache.vehicles.length}));
app.get("/api/alerts",        (_,res) => res.json({alerts:cache.alerts, lastUpdated:cache.lastUpdated}));
app.get("/api/railways",      (_,res) => res.json({railways:cache.railways, lastUpdated:cache.lastUpdated}));
app.get("/api/railways-full", (_,res) => res.json({railways:cache.railwaysFull, lastUpdated:cache.lastUpdated}));
app.get("/api/stations",      (_,res) => res.json({stations:cache.stations, lastUpdated:cache.lastUpdated}));
app.get("/api/train-info",    (_,res) => res.json({trainInfo:cache.trainInfo, lastUpdated:cache.lastUpdated}));
app.get("/api/status",        (_,res) => res.json({ok:true, count:cache.vehicles.length}));

// Station timetable — next departures for a specific station.
// The frontend calls this when a commute marker is clicked.
// Query: /api/station-timetable?station=odpt.Station:Toei.Oedo.Tochomae
const stTimetableCache = {};   // station id → { data, fetchedAt }
app.get("/api/station-timetable", async (req, res) => {
  const station = req.query.station;
  if (!station) return res.json({ error: "missing station" });
  try {
    // Cache per station for 10 minutes (timetables are static).
    const cached = stTimetableCache[station];
    if (cached && (Date.now() - cached.fetchedAt) < 600000) {
      return res.json({ station, timetables: cached.data });
    }
    const url = `${BASE}/odpt:StationTimetable?odpt:station=${station}&acl:consumerKey=${KEY}`;
    const data = await fetchJson(url);
    const slim = (Array.isArray(data) ? data : []).map(t => ({
      railway   : t["odpt:railway"] || "",
      direction : t["odpt:railDirection"] || "",
      calendar  : t["odpt:calendar"] || "",
      departures: (t["odpt:stationTimetableObject"] || []).map(o => ({
        time: o["odpt:departureTime"] || "",
        dest: (o["odpt:destinationStation"] || [])[0] || "",
        type: o["odpt:trainType"] || "",
      })).filter(d => d.time),
    }));
    stTimetableCache[station] = { data: slim, fetchedAt: Date.now() };
    res.json({ station, timetables: slim });
  } catch (e) {
    res.json({ error: e.message, station });
  }
});
app.get("/api/station-timetable-sample", async (req, res) => {
  try {
    // Grab a sample for Shinjuku on the Shinjuku line (busy, always has data)
    const station = req.query.station || "odpt.Station:Toei.Shinjuku.Shinjuku";
    const url = `${BASE}/odpt:StationTimetable?odpt:station=${station}&acl:consumerKey=${KEY}`;
    const data = await fetchJson(url);
    res.json({
      station,
      total: Array.isArray(data) ? data.length : 0,
      sample: Array.isArray(data) ? data.slice(0, 1) : data,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/api/debug",         (_,res) => {
  const dist = {};
  cache.vehicles.forEach(v => { dist[v.routeId||"?"] = (dist[v.routeId||"?"]||0)+1; });
  // Group by prefix3+suffix to see patterns
  const patterns = {};
  cache.vehicles.forEach(v => {
    const m = v.vehicleId.match(/^(\d{3})(\d+)([A-Za-z]+)\d*$/);
    const key = m ? `${m[1]}xxx+${m[3]}` : "?";
    const line = v.routeId.split(".").pop() || "?";
    if (!patterns[key]) patterns[key] = {};
    patterns[key][line] = (patterns[key][line]||0)+1;
  });
  const unknownIds = cache.vehicles
    .filter(v => !v.routeId)
    .map(v => v.vehicleId)
    .slice(0, 30);
  // Show coords of numeric-ID vehicles to verify line assignment
  const numericVehicles = cache.vehicles
    .filter(v => /^\d{8}$/.test(v.vehicleId))
    .map(v => ({ id: v.vehicleId, routeId: v.routeId.split(".").pop(), lat: v.lat.toFixed(4), lng: v.lng.toFixed(4) }));
  // Arakawa-specific diagnostics
  const arakawaVehicles = cache.vehicles
    .filter(v => v.routeId === "odpt.Railway:Toei.Arakawa")
    .map(v => ({ id: v.vehicleId, lat: v.lat.toFixed(4), lng: v.lng.toFixed(4) }));
  const arakawaStations = cache.stations
    .filter(s => s.railway === "odpt.Railway:Toei.Arakawa").length;
  const hSuffixCount = cache.vehicles
    .filter(v => /[Hh]\d*$/.test(v.vehicleId)).length;

  // Sample stop_ids to see if the feed provides line info this way
  const stopIdSamples = cache.vehicles
    .filter(v => v.stopId)
    .slice(0, 15)
    .map(v => ({ vehicle: v.vehicleId, stopId: v.stopId }));
  // #7 Train location diagnostics
  const sourceCounts = {};
  cache.vehicles.forEach(v => { sourceCounts[v.lineSource||"none"] = (sourceCounts[v.lineSource||"none"]||0)+1; });
  res.json({
    officialTrainCount: cache.officialTrainCount || 0,
    trainsRawSample: cache.trainsSample || [],
    lineSourceCounts: sourceCounts,
    stopIdSamples,
    vehiclesWithStopId: cache.vehicles.filter(v => v.stopId).length,
    totalVehicles: cache.vehicles.length,
    routeDistribution: dist,
    patternsByLine: patterns,
    arakawaVehicles,
    arakawaStationCount: arakawaStations,
    hSuffixVehicleCount: hSuffixCount,
    unknownIds,
    numericVehicles,
    gtfsStaticLoaded: Object.keys(staticTripRouteMap).length,
  });
});

// ── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚃  Toei Transit Map  →  http://localhost:${PORT}\n`);
  await loadGtfsStatic();
  await refreshCache();
  setInterval(refreshCache, 3_000);
});