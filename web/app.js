'use strict';

// Two disjoint filter dimensions:
//   - Amazon-operated lockers: every apisAccessPointType not in PROVIDER_TYPES.
//     Rendered as one row per type under "Amazon Lockers", auto-discovered
//     from the data (so any new variant Amazon ships shows up automatically).
//   - PROVIDER_TYPES: partner-operated pickup points, governed by "Partner
//     Pickup" rows. The HELIX vs 3P distinction is an internal API artifact
//     and not exposed in the UI.
// A locker belongs to exactly one dimension, so the two filter sections
// can't interfere with each other.
const PROVIDER_TYPES = new Set(['HELIX', '3P']);
const STATION_KINDS = ['rail', 'subway', 'light_rail'];

// Display metadata for known Amazon-locker apisAccessPointType values.
// Unknown types fall back to the raw value as label and a default colour.
const TYPE_META = {
  CORE_LOCKER: { label: 'Core Locker', color: '#1976d2' },
  ODIN_LOCKER: { label: 'Odin Locker', color: '#003e7e' },
};
const TYPE_FALLBACK_COLOR = '#5e35b1';
let amazonTypes = [];  // populated after lockers load

// Amazon ownerIds map deterministically to provider brands. Owners not in
// this table fall into 'other' (small/mixed convenience operators).
const PROVIDER_BY_OWNER = {
  'A2SVXR8L2IAWSZ': 'post_office',  // HELIX: "Amazon Counter - Post Office …"
  'ASW7WA1AVJEO1':  'collect_plus', // HELIX: "Amazon Counter - Collect+ …"
  'AJYX11KYZS7RJ':  'post_office',  // 3P:    "Local Collect at … (Post Office)"
  'A3OP953GMI6COS': 'coop',         // HELIX: "Amazon Counter - Co-op …"
  'A2WLU71GZDFYHW': 'asda',         // HELIX: "Amazon Counter - Asda …"
  'A3RREG72DQKTVQ': 'asda',         // HELIX: "Amazon Counter - Asda Express …"
  'A3NDIDSS54H5PN': 'waitrose',     // HELIX: "Amazon Counter - Waitrose …"
  'A2FWTZCC7NF5ZS': 'morrisons',    // HELIX: "Morrisons - …"
  'A15TPTB02MLNV7': 'amazon_fresh', // HELIX: "Amazon Counter - Amazon Fresh …"
};

// Display metadata for provider brands. Known brands first (insertion order =
// sidebar order); unknown values discovered in data fall through to 'other'.
const PROVIDER_META = {
  post_office:  { label: 'Post Office',  color: '#c8102e' },
  collect_plus: { label: 'Collect+',     color: '#00a884' },
  coop:         { label: 'Co-op',        color: '#00b1e7' },
  asda:         { label: 'Asda',         color: '#7dc242' },
  waitrose:     { label: 'Waitrose',     color: '#3e7c3a' },
  morrisons:    { label: 'Morrisons',    color: '#ffd200' },
  amazon_fresh: { label: 'Amazon Fresh', color: '#ff9900' },
  other:        { label: 'Other',        color: '#757575' },
};
let providers = [];  // populated after lockers load

function providerOf(l) {
  return PROVIDER_BY_OWNER[l && l.ownerId] || 'other';
}

let map, cluster;
let stationLayer;                 // L.LayerGroup, populated when "Draw stations" is on
let lockers = [];                 // array of all known lockers
const lockersById = new Map();    // id -> locker
const refreshTimes = new Map();   // id -> Date.now() of last live refresh
const activeTypes = new Set();
const activeProviders = new Set();
let currentPanelId = null;
let currentPanelKind = 'locker';   // 'locker' | 'kiosk'
let clickModeOn = false;

// Amazon Returns Kiosks at Morrisons stores. Sourced from morrisons_kiosks.json
// (see harvest_morrisons_kiosks.py). Kept in their own layer so they don't
// interact with the locker filters/clusters.
let kiosks = [];
const kiosksById = new Map();
let kioskLayer = null;
let showKiosks = false;

let stations = [];                // [{name, lat, lng, kind, network}]
let stationGrid = null;           // spatial grid: Map<"i,j", station[]>
const STATION_GRID_KM = 5;        // cell size; lookups expand by ceil(radius/cell)
let nearStationOn = false;
let stationRadiusM = 500;
const activeStationKinds = new Set(STATION_KINDS);
let nearLockerIds = null;         // Set<id> of lockers passing station filter; null = filter off
let nearCacheKey = '';            // memoization key for the above

// ---------- bootstrap ----------------------------------------------------
async function init() {
  map = L.map('map').setView([54.7, -3.5], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
  cluster = L.markerClusterGroup({
    chunkedLoading: true,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    maxClusterRadius: 60,
  });
  map.addLayer(cluster);

  stationLayer = L.layerGroup();
  kioskLayer = L.layerGroup();

  installFilters();
  installPanel();
  installClickMode();
  installStationFilter();
  installKioskFilter();

  await Promise.all([loadBaseline(), loadStations(), loadKiosks()]);
  updateStationCounts();
}

async function loadKiosks() {
  try {
    const r = await fetch('/data/morrisons_kiosks.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    kiosks = data.kiosks || [];
    kiosksById.clear();
    for (const k of kiosks) {
      if (k.id != null) kiosksById.set(String(k.id), k);
    }
  } catch (e) {
    console.warn('Could not load Morrisons kiosks:', e);
    kiosks = [];
    const cb = document.getElementById('show-kiosks');
    if (cb) cb.disabled = true;
  }
  const countEl = document.getElementById('kiosk-count');
  if (countEl) countEl.textContent = kiosks.length.toLocaleString();
}

function installKioskFilter() {
  const cb = document.getElementById('show-kiosks');
  if (!cb) return;
  cb.addEventListener('change', () => {
    showKiosks = cb.checked;
    if (showKiosks) {
      redrawKiosksLayer();
      map.addLayer(kioskLayer);
    } else {
      map.removeLayer(kioskLayer);
    }
  });
}

function redrawKiosksLayer() {
  kioskLayer.clearLayers();
  for (const k of kiosks) {
    const lat = k.location && k.location.latitude;
    const lng = k.location && k.location.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const m = L.marker([lat, lng], {
      icon: L.divIcon({
        className: 'kiosk-marker',
        html: '<span class="dot kiosk-dot"></span>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
    });
    m.bindTooltip(k.storeName || 'Morrisons kiosk',
                  { direction: 'top', offset: [0, -6] });
    const id = String(k.id);
    m.on('click', () => openKioskPanel(id));
    kioskLayer.addLayer(m);
  }
}

async function loadStations() {
  try {
    const r = await fetch('/static/stations.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    stations = data.stations || [];
    stationGrid = buildStationGrid(stations);
  } catch (e) {
    console.warn('Could not load stations:', e);
    stations = [];
    document.getElementById('near-station').disabled = true;
    document.getElementById('station-summary').textContent =
      'Station data unavailable. Run `python3 fetch_stations.py` and reload.';
  }
}

function buildStationGrid(items) {
  const grid = new Map();
  for (const s of items) {
    const [i, j] = gridCell(s.lat, s.lng);
    const key = i + ',' + j;
    let cell = grid.get(key);
    if (!cell) { cell = []; grid.set(key, cell); }
    cell.push(s);
  }
  return grid;
}

// Approximate ~5km cells using degrees, anchored at (49,-9). Lng cell size
// uses cos(54°) — fine for UK latitudes (cell shape varies <10%).
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LNG_AT_54 = 111.32 * Math.cos(54 * Math.PI / 180); // ~65.4 km
const CELL_LAT_DEG = STATION_GRID_KM / KM_PER_DEG_LAT;
const CELL_LNG_DEG = STATION_GRID_KM / KM_PER_DEG_LNG_AT_54;

function gridCell(lat, lng) {
  return [
    Math.floor((lat - 49) / CELL_LAT_DEG),
    Math.floor((lng + 9) / CELL_LNG_DEG),
  ];
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371008.8;
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function lockerNearStation(lat, lng, radiusM, kinds) {
  if (!stationGrid) return false;
  const cellsOut = Math.ceil((radiusM / 1000) / STATION_GRID_KM) + 1;
  const [ci, cj] = gridCell(lat, lng);
  for (let di = -cellsOut; di <= cellsOut; di++) {
    for (let dj = -cellsOut; dj <= cellsOut; dj++) {
      const cell = stationGrid.get((ci + di) + ',' + (cj + dj));
      if (!cell) continue;
      for (const s of cell) {
        if (!kinds.has(s.kind)) continue;
        if (haversineM(lat, lng, s.lat, s.lng) <= radiusM) return true;
      }
    }
  }
  return false;
}

function recomputeNearLockerIds() {
  if (!nearStationOn) {
    nearLockerIds = null;
    nearCacheKey = '';
    return;
  }
  const key = stationRadiusM + ':' + [...activeStationKinds].sort().join(',');
  if (key === nearCacheKey && nearLockerIds) return;
  const ids = new Set();
  let n = 0;
  for (const l of lockers) {
    if (!hasValidCoords(l)) continue;
    if (lockerNearStation(l.location.latitude, l.location.longitude,
                           stationRadiusM, activeStationKinds)) {
      const id = lockerId(l);
      if (id) { ids.add(id); n++; }
    }
  }
  nearLockerIds = ids;
  nearCacheKey = key;
  document.getElementById('station-summary').textContent =
    `${n.toLocaleString()} lockers within ${formatDist(stationRadiusM)} of a matching station.`;
}

function formatDist(m) {
  return m >= 1000 ? (m / 1000) + ' km' : m + ' m';
}

async function loadBaseline() {
  setStats('Loading…');
  const r = await fetch('/data/lockers.json');
  if (!r.ok) {
    setStats(`Failed to load lockers: HTTP ${r.status}`);
    return;
  }
  const data = await r.json();
  lockers = data.lockers || [];
  lockersById.clear();
  for (const l of lockers) {
    const id = lockerId(l);
    if (id) lockersById.set(id, l);
  }
  for (const [id, ts] of Object.entries(data.refreshedAt || {})) {
    refreshTimes.set(id, Number(ts) * 1000);
  }
  discoverAmazonTypes();
  discoverProviders();
  renderTypeRows();
  renderProviderRows();
  rebuildMarkers();
  updateTypeCounts();
}

function discoverAmazonTypes() {
  const seen = new Set();
  for (const l of lockers) {
    const t = l.apisAccessPointType;
    if (t && !PROVIDER_TYPES.has(t)) seen.add(t);
  }
  // Stable ordering: known types first (in TYPE_META insertion order), then
  // any unknown ones alphabetically.
  const known = Object.keys(TYPE_META).filter(t => seen.has(t));
  const unknown = [...seen].filter(t => !TYPE_META[t]).sort();
  amazonTypes = [...known, ...unknown];
  activeTypes.clear();
  for (const t of amazonTypes) activeTypes.add(t);
}

function discoverProviders() {
  const seen = new Set();
  for (const l of lockers) {
    if (PROVIDER_TYPES.has(l.apisAccessPointType)) seen.add(providerOf(l));
  }
  // Known providers first in PROVIDER_META order, then unknown alphabetically,
  // with 'other' always pinned last.
  const known = Object.keys(PROVIDER_META).filter(p => p !== 'other' && seen.has(p));
  const unknown = [...seen].filter(p => p !== 'other' && !PROVIDER_META[p]).sort();
  providers = [...known, ...unknown];
  if (seen.has('other')) providers.push('other');
  activeProviders.clear();
  for (const p of providers) activeProviders.add(p);
}

function renderProviderRows() {
  const host = document.getElementById('provider-rows');
  if (!host) return;
  host.innerHTML = '';
  const styleParts = [];
  for (const p of providers) {
    const meta = PROVIDER_META[p] || { label: p, color: TYPE_FALLBACK_COLOR };
    styleParts.push(`.dot-provider-${cssId(p)}{background:${meta.color};}`);
    const label = document.createElement('label');
    label.innerHTML =
      `<input type="checkbox" data-provider="${escAttr(p)}" checked />` +
      `<span class="dot dot-provider-${cssId(p)}"></span> ${escHtml(meta.label)} ` +
      `<span class="count" data-provider-count="${escAttr(p)}">–</span>`;
    host.appendChild(label);
  }
  let styleEl = document.getElementById('provider-row-styles');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'provider-row-styles';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = styleParts.join('\n');
  host.querySelectorAll('input[type="checkbox"][data-provider]').forEach(cb => {
    cb.addEventListener('change', () => {
      const p = cb.dataset.provider;
      if (cb.checked) activeProviders.add(p); else activeProviders.delete(p);
      rebuildMarkers();
    });
  });
}

function renderTypeRows() {
  const host = document.getElementById('type-rows');
  if (!host) return;
  host.innerHTML = '';
  const styleParts = [];
  for (const t of amazonTypes) {
    const meta = TYPE_META[t] || { label: t, color: TYPE_FALLBACK_COLOR };
    styleParts.push(`.dot-type-${cssId(t)}{background:${meta.color};}`);
    const label = document.createElement('label');
    label.innerHTML =
      `<input type="checkbox" data-type="${escAttr(t)}" checked />` +
      `<span class="dot dot-type-${cssId(t)}"></span> ${escHtml(meta.label)} ` +
      `<span class="count" data-count="${escAttr(t)}">–</span>`;
    host.appendChild(label);
  }
  let styleEl = document.getElementById('type-row-styles');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'type-row-styles';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = styleParts.join('\n');
  // Re-bind change handlers for the freshly-rendered checkboxes.
  host.querySelectorAll('input[type="checkbox"][data-type]').forEach(cb => {
    cb.addEventListener('change', () => {
      const t = cb.dataset.type;
      if (cb.checked) activeTypes.add(t); else activeTypes.delete(t);
      rebuildMarkers();
    });
  });
}

function cssId(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }

// ---------- markers ------------------------------------------------------
function lockerId(l) {
  return l.id || l.addressId || l.storeId || null;
}

function hasValidCoords(l) {
  const lat = l.location && l.location.latitude;
  const lng = l.location && l.location.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  // sanity: must be within UK-ish bbox (catches the API's known bad geocodes)
  return lat >= 49 && lat <= 61.5 && lng >= -9 && lng <= 2.5;
}

function makeIcon(l) {
  const t = l.apisAccessPointType;
  const cls = PROVIDER_TYPES.has(t) ? `provider-${providerOf(l)}` : `type-${cssId(t || 'unknown')}`;
  return L.divIcon({
    className: 'locker-marker',
    html: `<span class="dot dot-${cls}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function rebuildMarkers() {
  recomputeNearLockerIds();
  cluster.clearLayers();
  let plotted = 0, plotable = 0;
  const batch = [];
  for (const l of lockers) {
    if (!hasValidCoords(l)) continue;
    plotable++;
    const t = l.apisAccessPointType;
    if (PROVIDER_TYPES.has(t)) {
      if (!activeProviders.has(providerOf(l))) continue;
    } else if (!activeTypes.has(t)) {
      continue;
    }
    if (nearLockerIds && !nearLockerIds.has(lockerId(l))) continue;
    const m = L.marker([l.location.latitude, l.location.longitude], {
      icon: makeIcon(l),
    });
    const id = lockerId(l);
    m.lockerId = id;
    m.on('click', () => openPanel(id));
    batch.push(m);
    plotted++;
  }
  cluster.addLayers(batch);
  let msg = `${plotted.toLocaleString()} of ${plotable.toLocaleString()} lockers shown`;
  if (nearStationOn) {
    msg += ` · within ${formatDist(stationRadiusM)} of station`;
  }
  if (lockers.length !== plotable) {
    msg += ` · ${(lockers.length - plotable).toLocaleString()} have invalid coords`;
  }
  setStats(msg);
}

function setStats(text) { document.getElementById('stats').textContent = text; }

function updateTypeCounts() {
  const counts = Object.fromEntries(amazonTypes.map(t => [t, 0]));
  const providerCounts = Object.fromEntries(providers.map(p => [p, 0]));
  for (const l of lockers) {
    const t = l.apisAccessPointType;
    if (counts[t] !== undefined) counts[t]++;
    if (PROVIDER_TYPES.has(t)) providerCounts[providerOf(l)]++;
  }
  for (const [t, c] of Object.entries(counts)) {
    const el = document.querySelector(`.count[data-count="${t}"]`);
    if (el) el.textContent = c.toLocaleString();
  }
  for (const [p, c] of Object.entries(providerCounts)) {
    const el = document.querySelector(`.count[data-provider-count="${p}"]`);
    if (el) el.textContent = c.toLocaleString();
  }
}

// ---------- filters ------------------------------------------------------
function installFilters() {
  // Type and provider rows are rendered (and wired) dynamically after data
  // loads. See renderTypeRows / renderProviderRows.
}

// ---------- station filter ----------------------------------------------
function installStationFilter() {
  document.getElementById('near-station').addEventListener('change', e => {
    nearStationOn = e.target.checked;
    rebuildMarkers();
  });
  document.getElementById('station-radius').addEventListener('change', e => {
    stationRadiusM = Number(e.target.value);
    nearCacheKey = '';
    rebuildMarkers();
  });
  document.querySelectorAll('input[data-station-kind]').forEach(cb => {
    cb.addEventListener('change', () => {
      const k = cb.dataset.stationKind;
      if (cb.checked) activeStationKinds.add(k); else activeStationKinds.delete(k);
      nearCacheKey = '';
      rebuildMarkers();
      redrawStationsLayer();
    });
  });
  document.getElementById('show-stations').addEventListener('change', e => {
    if (e.target.checked) { map.addLayer(stationLayer); redrawStationsLayer(); }
    else { map.removeLayer(stationLayer); }
  });
}

function redrawStationsLayer() {
  stationLayer.clearLayers();
  if (!map.hasLayer(stationLayer)) return;
  for (const s of stations) {
    if (!activeStationKinds.has(s.kind)) continue;
    const m = L.marker([s.lat, s.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="station-marker kind-${s.kind}" title="${escAttr(s.name)}"></div>`,
        iconSize: [10, 10],
        iconAnchor: [5, 5],
      }),
      keyboard: false,
      interactive: true,
    });
    m.bindTooltip(s.name + (s.network ? ` · ${s.network}` : ''),
                  { direction: 'top', offset: [0, -4] });
    stationLayer.addLayer(m);
  }
}

function updateStationCounts() {
  const counts = Object.fromEntries(STATION_KINDS.map(k => [k, 0]));
  for (const s of stations) if (counts[s.kind] !== undefined) counts[s.kind]++;
  for (const [k, c] of Object.entries(counts)) {
    const el = document.querySelector(`[data-station-count="${k}"]`);
    if (el) el.textContent = c.toLocaleString();
  }
}

// ---------- panel --------------------------------------------------------
function installPanel() {
  document.getElementById('panel-close').addEventListener('click', closePanel);
  document.getElementById('panel-refresh').addEventListener('click', refreshCurrentPanel);
}

function openPanel(id) {
  const l = lockersById.get(id);
  if (!l) return;
  currentPanelId = id;
  currentPanelKind = 'locker';
  document.getElementById('panel-refresh').hidden = false;
  renderPanel(l);
  setPanelStatus('');
  document.getElementById('panel').hidden = false;
}

function openKioskPanel(id) {
  const k = kiosksById.get(id);
  if (!k) return;
  currentPanelId = id;
  currentPanelKind = 'kiosk';
  // Kiosks are scraped from Morrisons; there's no live-refresh equivalent.
  document.getElementById('panel-refresh').hidden = true;
  renderKioskPanel(k);
  setPanelStatus('');
  document.getElementById('panel').hidden = false;
}

function closePanel() {
  document.getElementById('panel').hidden = true;
  currentPanelId = null;
  currentPanelKind = 'locker';
}

function renderPanel(l) {
  const el = document.getElementById('panel-content');
  const refreshed = refreshTimes.get(lockerId(l));
  let html = `<h2>${escHtml(l.name || '(unnamed)')}</h2>`;
  if (refreshed) {
    html += `<div><span class="badge">refreshed ${formatAgo(refreshed)}</span></div>`;
  }
  if (!hasValidCoords(l)) {
    html += `<div class="bad-coord-warn">⚠ The API returned coordinates outside the UK
              bounding box for this record. The address/postcode are likely correct
              but the location field is broken upstream.</div>`;
  }
  const keys = Object.keys(l).sort();
  for (const k of keys) {
    html += `<div class="field"><div class="field-key">${escHtml(k)}</div>` +
            `<div class="field-val">${formatValue(l[k])}</div></div>`;
  }
  el.innerHTML = html;
}

function renderKioskPanel(k) {
  const el = document.getElementById('panel-content');
  const a = k.address || {};
  const addrLines = [a.addressLine1, a.addressLine2, a.city, a.county, a.postcode]
    .filter(Boolean).map(escHtml).join('<br>');
  const dirLat = k.location && k.location.latitude;
  const dirLng = k.location && k.location.longitude;
  const dirHref = (typeof dirLat === 'number' && typeof dirLng === 'number')
    ? `https://www.google.com/maps/dir/?api=1&destination=${dirLat},${dirLng}`
    : null;
  const oh = Array.isArray(k.openingTimes) ? k.openingTimes : [];
  const ohRows = oh.map(d => {
    const day = d.day || d.day_short || '';
    const open = d.open || '';
    const close = d.close || '';
    const range = (open === '00:00:00' && close === '00:00:00')
      ? 'closed' : `${open.slice(0,5)} – ${close.slice(0,5)}`;
    return `<tr><td>${escHtml(day)}</td><td>${escHtml(range)}</td></tr>`;
  }).join('');

  let html = `<h2>${escHtml(k.storeName || 'Morrisons store')}</h2>`;
  html += `<div><span class="badge">Amazon Returns Kiosk</span>`;
  if (k.hasAmazonLocker) html += ` <span class="badge">Amazon Locker on site</span>`;
  html += `</div>`;
  html += `<div class="field"><div class="field-key">Address</div>` +
          `<div class="field-val">${addrLines || '<em>unknown</em>'}</div></div>`;
  if (k.telephone && k.telephone !== 'tbc') {
    html += `<div class="field"><div class="field-key">Phone</div>` +
            `<div class="field-val">${escHtml(k.telephone)}</div></div>`;
  }
  if (k.region) {
    html += `<div class="field"><div class="field-key">Region</div>` +
            `<div class="field-val">${escHtml(k.region)}</div></div>`;
  }
  if (ohRows) {
    html += `<div class="field"><div class="field-key">Store hours</div>` +
            `<div class="field-val"><table class="hours">${ohRows}</table></div></div>`;
  }
  if (Array.isArray(k.services) && k.services.length) {
    html += `<div class="field"><div class="field-key">In-store services</div>` +
            `<div class="field-val">${k.services.map(escHtml).join(', ')}</div></div>`;
  }
  if (k.storefinderUrl) {
    html += `<div class="field"><div class="field-key">Store page</div>` +
            `<div class="field-val"><a href="${escAttr(k.storefinderUrl)}" target="_blank" rel="noopener">my.morrisons.com</a></div></div>`;
  }
  if (dirHref) {
    html += `<div class="field"><div class="field-key">Directions</div>` +
            `<div class="field-val"><a href="${escAttr(dirHref)}" target="_blank" rel="noopener">Open in Google Maps</a></div></div>`;
  }
  el.innerHTML = html;
}

function formatValue(v) {
  if (v == null) return '<em>null</em>';
  if (v === '') return '<em>(empty)</em>';
  if (typeof v === 'string') {
    if (/^https?:\/\//.test(v)) return `<a href="${escAttr(v)}" target="_blank" rel="noopener">${escHtml(v)}</a>`;
    return escHtml(v);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.length === 0) return '<em>[]</em>';
  return `<pre>${escHtml(JSON.stringify(v, null, 2))}</pre>`;
}

function formatAgo(ts) {
  const sec = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.round(sec / 60) + 'm ago';
  if (sec < 86400) return Math.round(sec / 3600) + 'h ago';
  return Math.round(sec / 86400) + 'd ago';
}

function setPanelStatus(html, kind = '') {
  const el = document.getElementById('panel-status');
  el.className = kind;
  el.innerHTML = html;
}

// ---------- live refresh -------------------------------------------------
async function refreshCurrentPanel() {
  if (!currentPanelId) return;
  const btn = document.getElementById('panel-refresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  setPanelStatus('Calling live API…');
  try {
    const r = await fetch(`/api/locker/${encodeURIComponent(currentPanelId)}/refresh`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    mergeRefresh(data);
    const cur = lockersById.get(currentPanelId);
    if (cur) renderPanel(cur);
    const lines = [];
    if (data.updated.length) lines.push(`<span class="ok">${data.updated.length} updated</span>`);
    if (data.added.length) lines.push(`<span class="ok">${data.added.length} new nearby</span>`);
    if (data.rejected) lines.push(`<span class="err">${data.rejected} rejected (bad coords)</span>`);
    setPanelStatus(lines.join(' · ') || 'No changes', '');
  } catch (e) {
    setPanelStatus('Refresh failed: ' + escHtml(e.message), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh from live API';
  }
}

function mergeRefresh(data) {
  const now = Date.now();
  for (const fresh of data.lockers || []) {
    const id = lockerId(fresh);
    if (!id) continue;
    const i = lockers.findIndex(x => lockerId(x) === id);
    if (i >= 0) lockers[i] = fresh; else lockers.push(fresh);
    lockersById.set(id, fresh);
    refreshTimes.set(id, now);
  }
  rebuildMarkers();
  updateTypeCounts();
}

// ---------- click-to-query mode ------------------------------------------
function installClickMode() {
  const cb = document.getElementById('click-mode');
  cb.addEventListener('change', () => {
    clickModeOn = cb.checked;
    map.getContainer().style.cursor = clickModeOn ? 'crosshair' : '';
  });
  map.on('click', async (e) => {
    if (!clickModeOn) return;
    const { lat, lng } = e.latlng;
    setStats(`Querying live API at ${lat.toFixed(4)}, ${lng.toFixed(4)}…`);
    try {
      const r = await fetch(`/api/refresh?lat=${lat}&lng=${lng}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      mergeRefresh(data);
      setStats(`Live query returned ${data.received}; ${data.added.length} new, ${data.updated.length} updated`);
    } catch (err) {
      setStats('Live query failed: ' + err.message);
    }
  });
}

// ---------- helpers ------------------------------------------------------
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function escAttr(s) { return escHtml(s); }

init();
