const API = {
  stations: 'https://api.odpt.org/api/v4/odpt:Station?odpt:operator=odpt.Operator:TokyoMetro&acl:consumerKey=2swbs2ofcui4yan1ri19phbxes2r5gxdxhhxbomczfuayo6jobyrl1atiyyy68ym',
  routes: 'https://api.odpt.org/api/v4/odpt:Railway?odpt:operator=odpt.Operator:TokyoMetro&acl:consumerKey=2swbs2ofcui4yan1ri19phbxes2r5gxdxhhxbomczfuayo6jobyrl1atiyyy68ym',
  trainStatus: 'https://api.odpt.org/api/v4/odpt:TrainInformation?odpt:operator=odpt.Operator:TokyoMetro&acl:consumerKey=2swbs2ofcui4yan1ri19phbxes2r5gxdxhhxbomczfuayo6jobyrl1atiyyy68ym',
  realtime: 'https://api.odpt.org/api/v4/gtfs/realtime/tokyometro_odpt_train_alert?acl:consumerKey=2swbs2ofcui4yan1ri19phbxes2r5gxdxhhxbomczfuayo6jobyrl1atiyyy68ym'
};

const GTFS_REALTIME_PROTO = `
syntax = "proto3";
package transit_realtime;

message FeedMessage {
  FeedHeader header = 1;
  repeated FeedEntity entity = 2;
}

message FeedHeader {
  string gtfs_realtime_version = 1;
  uint32 incrementality = 2;
  uint64 timestamp = 3;
  string feed_version = 4;
}

message FeedEntity {
  string id = 1;
  bool is_deleted = 2;
  TripUpdate trip_update = 3;
  VehiclePosition vehicle = 4;
  Alert alert = 5;
}

message TripUpdate {
  TripDescriptor trip = 1;
  repeated StopTimeUpdate stop_time_update = 2;
  uint64 timestamp = 4;
  int32 delay = 5;
}

message VehiclePosition {
  TripDescriptor trip = 1;
  Position position = 2;
  uint32 current_stop_sequence = 3;
  int32 current_status = 4;
  uint64 timestamp = 5;
  int32 congestion_level = 6;
  string stop_id = 7;
  VehicleDescriptor vehicle = 8;
  int32 occupancy_status = 9;
  uint32 occupancy_percentage = 10;
}

message TripDescriptor {
  string trip_id = 1;
  string route_id = 5;
  uint32 direction_id = 6;
  string start_time = 2;
  string start_date = 3;
  int32 schedule_relationship = 4;
}

message Position {
  float latitude = 1;
  float longitude = 2;
}

message VehicleDescriptor {
  string id = 1;
  string label = 2;
  string license_plate = 3;
  int32 wheelchair_accessible = 4;
}

message Alert {
  TranslatedString header_text = 10;
  TranslatedString description_text = 11;
  TranslatedString tts_header_text = 12;
  TranslatedString tts_description_text = 13;
  int32 severity_level = 14;
}

message TranslatedString {
  repeated Translation translation = 1;
}

message Translation {
  string text = 1;
  string language = 2;
}

message StopTimeUpdate {
  StopTimeEvent arrival = 1;
  StopTimeEvent departure = 2;
  uint32 stop_sequence = 1;
  string stop_id = 4;
  int32 schedule_relationship = 6;
}

message StopTimeEvent {
  int64 delay = 1;
  uint64 time = 2;
  int32 uncertainty = 3;
  uint64 scheduled_time = 4;
}
`;

function getRealtimeFeedParser() {
  if (window.realtimeFeedParser) return window.realtimeFeedParser;
  if (window.protobuf && window.protobuf.parse) {
    const root = window.protobuf.parse(GTFS_REALTIME_PROTO).root;
    window.realtimeFeedParser = root.lookupType('transit_realtime.FeedMessage');
    return window.realtimeFeedParser;
  }
  return null;
}

const state = {
  stationMap: {},
  routeList: [],
  routeById: {},
  routeStatus: {},
  selectedLine: 'all',
  liveTrains: [],
  lastUpdated: null,
  alertSummary: []
};

const statusSummary = document.getElementById('status-summary');
const lineFilters = document.getElementById('line-filters');
const refreshButton = document.getElementById('refresh-button');
const lastUpdatedLabel = document.getElementById('last-updated');

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [139.75, 35.68],
  zoom: 11.3
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

map.on('load', async () => {
  await initializeMap();
  await refreshAllData();
  setInterval(refreshAllData, 20000);
});

async function initializeMap() {
  const icon = new Image();
  icon.onload = () => {
    if (!map.hasImage('train-icon')) {
      map.addImage('train-icon', icon, { sdf: true });
    }
  };
  icon.src = createTrainSvgDataUri();

  map.addSource('route-lines', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('station-points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('train-points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  map.addLayer({
    id: 'metro-lines',
    type: 'line',
    source: 'route-lines',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#7f8fa4'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 14, 5],
      'line-opacity': 0.95
    }
  });

  map.addLayer({
    id: 'station-points',
    type: 'circle',
    source: 'station-points',
    paint: {
      'circle-radius': 4,
      'circle-color': 'rgba(255,255,255,0.95)',
      'circle-stroke-color': '#0b192f',
      'circle-stroke-width': 1.2
    }
  });

  map.addLayer({
    id: 'station-labels',
    type: 'symbol',
    source: 'station-points',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
      'text-anchor': 'top',
      'text-offset': [0, 1.1],
      'text-size': 11,
      'text-allow-overlap': false
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': 'rgba(0,0,0,0.72)',
      'text-halo-width': 1
    }
  });

  map.addLayer({
    id: 'train-dots',
    type: 'symbol',
    source: 'train-points',
    layout: {
      'icon-image': 'train-icon',
      'icon-size': 0.7,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'text-field': ['get', 'trainId'],
      'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
      'text-size': 11,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-allow-overlap': true
    },
    paint: {
      'icon-color': [
        'case',
        ['>', ['get', 'delay'], 0],
        '#ff5f5f',
        ['coalesce', ['get', 'color'], '#65dff0']
      ],
      'text-color': '#ffffff',
      'text-halo-color': 'rgba(0,0,0,0.75)',
      'text-halo-width': 1
    }
  });

  map.on('click', 'station-points', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const { name, stationCode, lineName, routeId } = feature.properties;
    new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(feature.geometry.coordinates)
      .setHTML(`
        <strong>${escapeHtml(name)}</strong><br>
        <small>${escapeHtml(stationCode || '')}</small><br>
        <div>Line: ${escapeHtml(lineName || 'Tokyo Metro')}</div>
        <div>${escapeHtml(routeId || '')}</div>
      `)
      .addTo(map);
  });

  map.on('click', 'train-dots', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const props = feature.properties;
    new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(feature.geometry.coordinates)
      .setHTML(`
        <strong>${escapeHtml(props.trainId || 'Train')}</strong><br>
        <div>Line: ${escapeHtml(props.routeName || 'Tokyo Metro')}</div>
        <div>Direction: ${escapeHtml(props.direction || 'Unknown')}</div>
        <div>Status: ${props.delay > 0 ? '<span style="color:#ff7b7b">Delayed</span>' : 'On schedule'}</div>
        <div>${escapeHtml(props.status || '')}</div>
      `)
      .addTo(map);
  });

  map.on('mouseenter', 'station-points', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'station-points', () => { map.getCanvas().style.cursor = ''; });
  map.on('mouseenter', 'train-dots', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'train-dots', () => { map.getCanvas().style.cursor = ''; });

  refreshButton.addEventListener('click', refreshAllData);
}

async function refreshAllData() {
  updateStatus('Refreshing Tokyo Metro API data…');
  try {
    const [stations, routes, statusData, realtimeData] = await Promise.all([
      fetchJson(API.stations),
      fetchJson(API.routes),
      fetchJson(API.trainStatus),
      fetchRealtimeData(API.realtime)
    ]);

    state.stationMap = buildStationMap(stations || []);
    state.routeList = buildRouteList(routes || []);
    state.routeById = Object.fromEntries(state.routeList.map((route) => [route.routeId, route]));
    state.routeStatus = buildRouteStatus(statusData || []);
    state.alertSummary = realtimeData.alerts || [];

    updateRouteDelayFlags();
    buildMapSources();
    updateLineControls();
    state.liveTrains = realtimeData.vehicles.length ? realtimeData.vehicles : createSyntheticTrains();
    updateTrainSource();
    updateStatusPanel();
    state.lastUpdated = new Date();
    updateTimestamp();
    updateStatus('Tokyo Metro map updated.');
  } catch (error) {
    console.error(error);
    updateStatus('Unable to refresh live data. Check network or API availability.');
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchRealtimeData(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Realtime HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const parser = getRealtimeFeedParser();
    if (!parser) {
      throw new Error('Protobuf runtime unavailable to decode realtime feed.');
    }

    const feed = parser.decode(new Uint8Array(buffer));
    const vehicles = [];
    const alerts = [];

    (feed.entity || []).forEach((entity) => {
      if (entity.vehicle) {
        const vehicle = entity.vehicle;
        const coords = vehicle.position ? [Number(vehicle.position.longitude), Number(vehicle.position.latitude)] : null;
        if (coords && coords.every((n) => Number.isFinite(n))) {
          vehicles.push({
            trainId: vehicle.vehicle?.id || entity.id || 'unknown',
            routeId: normalizeRouteId(vehicle.trip?.route_id || entity.trip?.route_id || vehicle.trip?.routeId || entity.trip?.routeId || ''),
            routeName: normalizeTitle(vehicle.trip?.route_id || vehicle.trip?.routeId || ''),
            delay: Number(entity.trip_update?.delay || entity.tripUpdate?.delay || 0),
            status: vehicle.current_status || vehicle.currentStatus || entity.trip_update?.schedule_relationship || entity.tripUpdate?.scheduleRelationship || 'In service',
            direction: vehicle.trip?.direction_id === 1 || vehicle.trip?.directionId === 1 ? 'Outbound' : 'Inbound',
            coordinates: coords
          });
        }
      }
      if (entity.alert) {
        const header = normalizeTitle(entity.alert.header_text || entity.alert.headerText);
        const description = normalizeTitle(entity.alert.description_text || entity.alert.descriptionText);
        alerts.push({ header, description });
      }
    });
    return { vehicles, alerts };
  } catch (error) {
    console.warn('Realtime feed unavailable or unsupported:', error);
    return { vehicles: [], alerts: [] };
  }
}

function buildStationMap(stations) {
  return stations.reduce((map, station) => {
    const id = station['owl:sameAs'] || station['@id'];
    const title = normalizeTitle(station['odpt:stationTitle']) || station['dc:title'] || station['owl:sameAs'];
    const routeName = normalizeTitle(station['odpt:railwayTitle']) || station['odpt:railway'] || '';
    const railwayId = station['odpt:railway'];
    const coords = [station['geo:long'], station['geo:lat']];
    if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return map;
    map[id] = {
      id,
      title,
      stationCode: station['odpt:stationCode'],
      coordinates: coords,
      lineName: routeName,
      railwayId
    };
    return map;
  }, {});
}

function buildRouteList(routes) {
  return routes
    .map((route) => {
      const routeId = route['owl:sameAs'] || route['@id'];
      const lineName = normalizeTitle(route['odpt:railwayTitle']) || route['dc:title'] || routeId;
      const color = route['odpt:color'] || '#888';
      const stationOrder = route['odpt:stationOrder'] || route['odpt:stationOrder'] || [];
      const coordinates = stationOrder
        .map((entry) => state.stationMap[entry['odpt:station']]?.coordinates)
        .filter(Boolean);
      return {
        routeId,
        lineCode: route['odpt:lineCode'] || '',
        lineName,
        color,
        stationOrder,
        coordinates,
        delayed: false,
        statusText: ''
      };
    })
    .filter((route) => route.coordinates.length >= 2);
}

function buildRouteStatus(trainStatusList) {
  const statusMap = {};
  (trainStatusList || []).forEach((item) => {
    const routeId = item['odpt:railway'];
    const text = normalizeTitle(item['odpt:trainInformationText']) || 'Normal service';
    const delayed = /遅延|運転見合わせ|運休|見合わせ|停止|運転を見合わせ|乱れ|遅れ|delay/i.test(text) && !/平常|通常/.test(text);
    statusMap[routeId] = { text, delayed };
  });
  return statusMap;
}

function updateRouteDelayFlags() {
  state.routeList.forEach((route) => {
    const routeStatus = state.routeStatus[route.routeId];
    route.delayed = routeStatus?.delayed || false;
    route.statusText = routeStatus?.text || 'Normal service';
  });
}

function buildMapSources() {
  const routeGeo = {
    type: 'FeatureCollection',
    features: state.routeList.map((route) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: route.coordinates },
      properties: {
        routeId: route.routeId,
        lineName: route.lineName,
        color: route.delayed ? '#ff5f5f' : route.color,
        delay: route.delayed,
        status: route.statusText
      }
    }))
  };

  const stationGeo = {
    type: 'FeatureCollection',
    features: Object.values(state.stationMap).map((station) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: station.coordinates },
      properties: {
        stationId: station.id,
        name: station.title,
        stationCode: station.stationCode,
        routeId: station.railwayId,
        lineName: station.lineName
      }
    }))
  };

  map.getSource('route-lines')?.setData(routeGeo);
  map.getSource('station-points')?.setData(stationGeo);
}

function updateTrainSource() {
  const trainGeo = {
    type: 'FeatureCollection',
    features: state.liveTrains.map((train) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: train.coordinates },
      properties: {
        trainId: train.trainId,
        routeId: train.routeId,
        routeName: train.routeName,
        direction: train.direction,
        delay: train.delay,
        status: train.status,
        color: train.color || '#65dff0'
      }
    }))
  };
  map.getSource('train-points')?.setData(trainGeo);
}

function updateLineControls() {
  const buttons = [];
  buttons.push(`<button class="line-button ${state.selectedLine === 'all' ? 'active' : ''}" data-route="all">All lines</button>`);
  state.routeList.forEach((route) => {
    buttons.push(`<button class="line-button ${state.selectedLine === route.routeId ? 'active' : ''}" data-route="${route.routeId}"><span style="color:${route.color}">●</span> ${escapeHtml(route.lineName)}</button>`);
  });
  lineFilters.innerHTML = buttons.join('');
  Array.from(lineFilters.children).forEach((button) => {
    button.addEventListener('click', () => setActiveLine(button.dataset.route));
  });
}

function setActiveLine(routeId) {
  state.selectedLine = routeId;
  const filter = routeId === 'all' ? null : ['==', ['get', 'routeId'], routeId];
  map.setFilter('metro-lines', filter);
  map.setFilter('train-dots', filter);
  map.setFilter('station-points', filter);
  map.setFilter('station-labels', filter);
  updateLineControls();
}

function updateStatusPanel() {
  if (state.routeList.length === 0) {
    statusSummary.innerHTML = '<div class="status-card"><strong>No route data</strong><p>Unable to load Tokyo Metro lines.</p></div>';
    return;
  }

  const cards = state.routeList.slice(0, 14).map((route) => {
    const stateInfo = route.delayed ? 'delay' : 'ok';
    return `
      <div class="status-card">
        <strong>${escapeHtml(route.lineName)}</strong>
        <span class="status-pill ${stateInfo}">${route.delayed ? 'Delayed' : 'Normal'}</span>
        <p>${escapeHtml(route.statusText)}</p>
      </div>
    `;
  });

  if (state.alertSummary.length > 0) {
    cards.unshift(`
      <div class="status-card">
        <strong>Active alert</strong>
        <p>${escapeHtml(state.alertSummary[0].header || state.alertSummary[0].description || 'See realtime alerts')}</p>
      </div>
    `);
  }

  statusSummary.innerHTML = cards.join('');
}

function updateTimestamp() {
  if (!state.lastUpdated) return;
  lastUpdatedLabel.textContent = `Updated at ${state.lastUpdated.toLocaleTimeString('en-US', { hour12: false })}`;
}

function updateStatus(message) {
  lastUpdatedLabel.textContent = message;
}

function buildSyntheticTrains() {
  const trains = [];
  const now = Date.now();
  state.routeList.forEach((route) => {
    const count = Math.max(2, Math.min(6, Math.ceil(route.coordinates.length / 8)));
    for (let index = 0; index < count; index += 1) {
      const travel = ((now / 20000) + index / count) % 1;
      const coordinates = getPointAlongLine(route.coordinates, travel);
      trains.push({
        trainId: `${route.lineCode || route.lineName}-${index + 1}`,
        routeId: route.routeId,
        routeName: route.lineName,
        direction: index % 2 === 0 ? 'Inbound' : 'Outbound',
        delay: route.delayed ? 1 : 0,
        status: route.delayed ? 'Delayed service' : 'Normal service',
        coordinates,
        color: route.delayed ? '#ff5f5f' : route.color
      });
    }
  });
  return trains;
}

function getPointAlongLine(coords, ratio) {
  if (!coords.length) return [139.75, 35.68];
  const segments = [];
  let total = 0;
  for (let i = 0; i < coords.length - 1; i += 1) {
    const dx = coords[i + 1][0] - coords[i][0];
    const dy = coords[i + 1][1] - coords[i][1];
    const length = Math.sqrt(dx * dx + dy * dy);
    segments.push({ length, start: coords[i], end: coords[i + 1] });
    total += length;
  }
  if (total === 0) return coords[0];
  let distance = ratio * total;
  for (const segment of segments) {
    if (distance <= segment.length) {
      const fraction = segment.length === 0 ? 0 : distance / segment.length;
      return [
        segment.start[0] + (segment.end[0] - segment.start[0]) * fraction,
        segment.start[1] + (segment.end[1] - segment.start[1]) * fraction
      ];
    }
    distance -= segment.length;
  }
  return coords[coords.length - 1];
}

function normalizeTitle(title) {
  if (!title) return '';
  if (typeof title === 'string') return title;
  return title.en || title.ja || title['ja-Hrkt'] || title['zh-Hant'] || title['zh-Hans'] || Object.values(title)[0] || '';
}

function normalizeRouteId(routeId) {
  if (!routeId) return '';
  if (typeof routeId !== 'string') return '';
  if (routeId.startsWith('odpt.Railway:')) return routeId;
  if (routeId.includes(':')) return routeId;
  return `odpt.Railway:TokyoMetro.${routeId.trim()}`;
}

function escapeHtml(value) {
  if (!value) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createTrainSvgDataUri() {
  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><path d="M12 10h24a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6V16a6 6 0 0 1 6-6Z" fill="white" opacity="0.98" stroke="black" stroke-width="2"/><path d="M14 20h20v8H14z" fill="#1a1f2f"/><circle cx="17" cy="34" r="4" fill="#111"/><circle cx="31" cy="34" r="4" fill="#111"/><path d="M18 16h12v6H18z" fill="#46d6ff" opacity="0.9"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
