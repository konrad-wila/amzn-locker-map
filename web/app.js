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
// (see harvest_morrisons_kiosks.py).
let kiosks = [];
const kiosksById = new Map();
let showKiosks = false;

// InPost UK locker network. Sourced from inpost_lockers.json
// (see harvest_inpost.py).
let inpostPoints = [];
const inpostById = new Map();
let showInpost = false;
const activeInpostTypes = new Set();

// Quadient (Parcel Pending) open UK locker network — 200ish sites at host
// partners like MFG forecourts, Stonegate pubs, Northern rail stations.
// Sourced from quadient_lockers.json (see harvest_quadient.py).
let quadientPoints = [];
const quadientById = new Map();
let showQuadient = false;

// Yeep — UK locker network (mostly DPD-carrier, ~26% also UPS). Sourced
// from yeep_lockers.json (see harvest_yeep.py).
let yeepPoints = [];
const yeepById = new Map();
let showYeep = false;

let stations = [];                // [{name, lat, lng, kind, network}]
let stationGrid = null;           // spatial grid: Map<"i,j", station[]>
const STATION_GRID_KM = 5;        // cell size; lookups expand by ceil(radius/cell)
let nearStationOn = false;
let stationRadiusM = 500;
const activeStationKinds = new Set();

// ---------- bootstrap ----------------------------------------------------
async function init() {
  map = L.map('map').setView([54.7, -3.5], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
  // One unified cluster for every network. Previously each source had its
  // own clustering (Amazon, InPost) or no clustering at all (Morrisons),
  // which produced overlapping cluster badges and stray markers at low zoom.
  // Folding everything into one MarkerCluster makes the cluster counts
  // additive (one "127" per area, not three) and the cluster expansion
  // animation reveals the per-marker glyph that identifies the network.
  cluster = L.markerClusterGroup({
    chunkedLoading: true,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    maxClusterRadius: 60,
  });
  map.addLayer(cluster);

  stationLayer = L.layerGroup();

  installFilters();
  installPanel();
  installClickMode();
  installStationFilter();
  installKioskFilter();
  installInpostFilter();
  installQuadientFilter();
  installYeepFilter();

  await Promise.all([loadBaseline(), loadStations(), loadKiosks(), loadInpost(), loadQuadient(), loadYeep()]);
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
    rebuildAllMarkers();
  });
}

async function loadInpost() {
  const setCount = (sel, n) => {
    const el = document.querySelector(sel);
    if (el) el.textContent = (n || 0).toLocaleString();
  };
  try {
    const r = await fetch('/data/inpost_lockers.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    inpostPoints = data.lockers || [];
    inpostById.clear();
    for (const p of inpostPoints) {
      if (p.id) inpostById.set(String(p.id), p);
    }
    setCount('#inpost-count', inpostPoints.length);
    const counts = (data.countByType) || {};
    setCount('[data-inpost-type-count="parcel_locker"]', counts.parcel_locker);
    setCount('[data-inpost-type-count="pok"]', (counts.pok || 0) + (counts.pop || 0));
  } catch (e) {
    console.warn('Could not load InPost:', e);
    inpostPoints = [];
    const cb = document.getElementById('show-inpost');
    if (cb) cb.disabled = true;
  }
}

function installInpostFilter() {
  const cb = document.getElementById('show-inpost');
  if (cb) {
    cb.addEventListener('change', () => {
      showInpost = cb.checked;
      rebuildAllMarkers();
    });
  }
  document.querySelectorAll('input[data-inpost-type]').forEach(c => {
    c.addEventListener('change', () => {
      const t = c.dataset.inpostType;
      if (c.checked) activeInpostTypes.add(t); else activeInpostTypes.delete(t);
      // 'pok' checkbox controls both 'pok' and 'pop' (treated as one).
      if (t === 'pok') {
        if (c.checked) activeInpostTypes.add('pop'); else activeInpostTypes.delete('pop');
      }
      rebuildAllMarkers();
    });
  });
}

async function loadQuadient() {
  const countEl = document.getElementById('quadient-count');
  const cb = document.getElementById('show-quadient');
  try {
    const r = await fetch('/data/quadient_lockers.json');
    if (!r.ok) {
      // Read whatever body the server sent (the project's own 404
      // response is JSON with an `error` key; an old server without
      // the route returns HTML — capture either).
      const body = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}${body ? ' — ' + body.slice(0, 120) : ''}`);
    }
    const data = await r.json();
    quadientPoints = data.lockers || [];
    quadientById.clear();
    for (const p of quadientPoints) {
      if (p.id) quadientById.set(String(p.id), p);
    }
    if (countEl) countEl.textContent = quadientPoints.length.toLocaleString();
  } catch (e) {
    console.warn('Could not load Quadient:', e);
    quadientPoints = [];
    if (cb) {
      cb.disabled = true;
      // Surface the reason on hover so the failure isn't silent.
      const lbl = cb.closest('label');
      if (lbl) lbl.title = `Quadient data unavailable: ${e.message || e}`;
    }
    // Use the same em-dash placeholder as the other counts use before
    // load — easier to spot than a misleading "0".
    if (countEl) countEl.textContent = '–';
  }
}

function installQuadientFilter() {
  const cb = document.getElementById('show-quadient');
  if (!cb) return;
  cb.addEventListener('change', () => {
    showQuadient = cb.checked;
    rebuildAllMarkers();
  });
}

async function loadYeep() {
  const countEl = document.getElementById('yeep-count');
  const cb = document.getElementById('show-yeep');
  try {
    const r = await fetch('/data/yeep_lockers.json');
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}${body ? ' — ' + body.slice(0, 120) : ''}`);
    }
    const data = await r.json();
    yeepPoints = data.lockers || [];
    yeepById.clear();
    for (const p of yeepPoints) {
      if (p.id) yeepById.set(String(p.id), p);
    }
    if (countEl) countEl.textContent = yeepPoints.length.toLocaleString();
  } catch (e) {
    console.warn('Could not load Yeep:', e);
    yeepPoints = [];
    if (cb) {
      cb.disabled = true;
      const lbl = cb.closest('label');
      if (lbl) lbl.title = `Yeep data unavailable: ${e.message || e}`;
    }
    if (countEl) countEl.textContent = '–';
  }
}

function installYeepFilter() {
  const cb = document.getElementById('show-yeep');
  if (!cb) return;
  cb.addEventListener('change', () => {
    showYeep = cb.checked;
    rebuildAllMarkers();
  });
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

// Network-agnostic station filter. Returns true when the marker should be
// drawn — either the filter is off, or the point sits within radius of an
// active-kind station. Replaces an Amazon-only precompute that produced
// `nearLockerIds`; we now check inline so InPost / Quadient / Yeep /
// Morrisons obey the filter too.
function passesStationFilter(lat, lng) {
  if (!nearStationOn) return true;
  return lockerNearStation(lat, lng, stationRadiusM, activeStationKinds);
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
  // Default off — user opts in via the per-row checkboxes or the
  // "all · none" toggle next to the section header.
  activeTypes.clear();
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
  // Default off — user opts in via the per-row checkboxes or the
  // "all · none" toggle next to the section header.
  activeProviders.clear();
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
      `<input type="checkbox" data-provider="${escAttr(p)}" />` +
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
      `<input type="checkbox" data-type="${escAttr(t)}" />` +
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

// Unified marker glyph. One letter, one colour, same shape across every
// network — colour disambiguates subtype (provider, locker variant) and the
// glyph disambiguates the network family.
//   A = Amazon Locker, C = Amazon Counter, R = Returns Kiosk,
//   L = InPost Locker, S = InPost Shop
function makeGlyphIcon(glyph, kindClass, colorClass) {
  return L.divIcon({
    className: 'glyph-marker',
    html: `<span class="glyph ${kindClass} ${colorClass}">${glyph}</span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function makeAmazonIcon(l) {
  const t = l.apisAccessPointType;
  if (PROVIDER_TYPES.has(t)) {
    return makeGlyphIcon('C', 'k-counter', `prov-${cssId(providerOf(l))}`);
  }
  return makeGlyphIcon('A', 'k-locker', `lt-${cssId(t || 'unknown')}`);
}

// Rebuild every marker from every source. Replaces the three previously
// independent rebuild functions; called whenever any filter changes.
function rebuildAllMarkers() {
  cluster.clearLayers();
  // Phase 1: collect every visible item with its render and open metadata.
  // Phase 2 below buckets co-located items so the same physical site (e.g.
  // a Post Office hosting both an Amazon Counter and an InPost machine)
  // collapses to one marker. Most cross-network "duplicates" are actually
  // distinct services at the same address, so we preserve them in a chooser.
  const items = [];
  let amazonShown = 0, amazonPlotable = 0;

  // Amazon lockers / counters
  for (const l of lockers) {
    if (!hasValidCoords(l)) continue;
    amazonPlotable++;
    const t = l.apisAccessPointType;
    if (PROVIDER_TYPES.has(t)) {
      if (!activeProviders.has(providerOf(l))) continue;
    } else if (!activeTypes.has(t)) {
      continue;
    }
    if (!passesStationFilter(l.location.latitude, l.location.longitude)) continue;
    const id = lockerId(l);
    items.push({
      lat: l.location.latitude, lng: l.location.longitude,
      icon: makeAmazonIcon(l),
      label: l.name || 'Amazon access point',
      kindLabel: PROVIDER_TYPES.has(t) ? 'Amazon Counter' : 'Amazon Locker',
      open: () => openPanel(id),
    });
    amazonShown++;
  }

  // Morrisons returns kiosks
  let kioskShown = 0;
  if (showKiosks) {
    for (const k of kiosks) {
      const lat = k.location && k.location.latitude;
      const lng = k.location && k.location.longitude;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      if (!passesStationFilter(lat, lng)) continue;
      const id = String(k.id);
      items.push({
        lat, lng,
        icon: makeGlyphIcon('R', 'k-kiosk', ''),
        label: k.storeName || 'Morrisons kiosk',
        kindLabel: 'Morrisons returns kiosk',
        open: () => openKioskPanel(id),
      });
      kioskShown++;
    }
  }

  // InPost
  let inpostShown = 0;
  if (showInpost) {
    for (const p of inpostPoints) {
      const t = p.type || 'parcel_locker';
      const filterKey = (t === 'pop') ? 'pok' : t;
      if (!activeInpostTypes.has(filterKey)) continue;
      const lat = p.location && p.location.latitude;
      const lng = p.location && p.location.longitude;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      if (!passesStationFilter(lat, lng)) continue;
      const glyph = filterKey === 'parcel_locker' ? 'L' : 'S';
      const kindCls = filterKey === 'parcel_locker' ? 'k-inpost-locker' : 'k-inpost-shop';
      const id = String(p.id);
      items.push({
        lat, lng,
        icon: makeGlyphIcon(glyph, kindCls, ''),
        label: p.addressLine1 || p.id || 'InPost point',
        kindLabel: filterKey === 'parcel_locker' ? 'InPost locker' : 'InPost partner shop',
        open: () => openInpostPanel(id),
      });
      inpostShown++;
    }
  }

  // Quadient (Parcel Pending) open locker network
  let quadientShown = 0;
  if (showQuadient) {
    for (const p of quadientPoints) {
      const lat = p.location && p.location.latitude;
      const lng = p.location && p.location.longitude;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      if (!passesStationFilter(lat, lng)) continue;
      const id = String(p.id);
      items.push({
        lat, lng,
        icon: makeGlyphIcon('Q', 'k-quadient', ''),
        label: p.host || p.name || 'Parcel Pending locker',
        kindLabel: 'Quadient locker',
        open: () => openQuadientPanel(id),
      });
      quadientShown++;
    }
  }

  // Yeep — UK DPD/UPS locker network
  let yeepShown = 0;
  if (showYeep) {
    for (const p of yeepPoints) {
      const lat = p.location && p.location.latitude;
      const lng = p.location && p.location.longitude;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      if (!passesStationFilter(lat, lng)) continue;
      const id = String(p.id);
      items.push({
        lat, lng,
        icon: makeGlyphIcon('Y', 'k-yeep', ''),
        label: p.name || p.title || 'Yeep locker',
        kindLabel: 'Yeep locker',
        open: () => openYeepPanel(id),
      });
      yeepShown++;
    }
  }

  // Phase 2: spatial bucket. ~11m at UK latitudes, which is small enough to
  // only collapse markers that share an address while leaving distinct
  // sites separate. A multi-cell merge below catches points that straddle
  // a bucket boundary.
  const BUCKET_DEG = 0.0001;
  const buckets = new Map();
  for (const it of items) {
    const key = Math.round(it.lat / BUCKET_DEG) + ',' + Math.round(it.lng / BUCKET_DEG);
    let b = buckets.get(key);
    if (!b) { b = []; buckets.set(key, b); }
    b.push(it);
  }

  const batch = [];
  let mergedGroups = 0;
  for (const [, group] of buckets) {
    if (group.length === 1) {
      const it = group[0];
      const m = L.marker([it.lat, it.lng], { icon: it.icon });
      m.bindTooltip(it.label, { direction: 'top', offset: [0, -6] });
      m.on('click', it.open);
      batch.push(m);
    } else {
      mergedGroups++;
      // Average the cluster's coordinates so the merged pin sits in the middle.
      const lat = group.reduce((s, x) => s + x.lat, 0) / group.length;
      const lng = group.reduce((s, x) => s + x.lng, 0) / group.length;
      const text = group.length >= 10 ? '9+' : String(group.length);
      const m = L.marker([lat, lng], {
        icon: makeGlyphIcon(text, 'k-merged', ''),
      });
      m.bindTooltip(`${group.length} services at this location`,
                    { direction: 'top', offset: [0, -6] });
      m.on('click', () => openMergedPanel(group));
      batch.push(m);
    }
  }
  cluster.addLayers(batch);

  // Refresh the dedicated station-summary line in the sidebar — now reflects
  // every visible network, not just Amazon.
  const stationSummaryEl = document.getElementById('station-summary');
  if (stationSummaryEl) {
    if (nearStationOn) {
      const total = items.length;
      stationSummaryEl.textContent =
        `${total.toLocaleString()} location${total === 1 ? '' : 's'} ` +
        `within ${formatDist(stationRadiusM)} of a matching station.`;
    } else {
      stationSummaryEl.textContent = '';
    }
  }

  const totalShown = amazonShown + kioskShown + inpostShown + quadientShown + yeepShown;
  const parts = [];
  if (amazonShown) parts.push(`${amazonShown.toLocaleString()} Amazon`);
  if (kioskShown) parts.push(`${kioskShown.toLocaleString()} Morrisons`);
  if (inpostShown) parts.push(`${inpostShown.toLocaleString()} InPost`);
  if (quadientShown) parts.push(`${quadientShown.toLocaleString()} Quadient`);
  if (yeepShown) parts.push(`${yeepShown.toLocaleString()} Yeep`);
  let msg = totalShown === 0
    ? 'No locations shown — pick a filter on the left'
    : `${totalShown.toLocaleString()} shown · ${parts.join(' + ')}`;
  if (mergedGroups) {
    msg += ` · ${mergedGroups.toLocaleString()} co-located groups merged`;
  }
  if (nearStationOn) {
    msg += ` · within ${formatDist(stationRadiusM)} of station`;
  }
  if (lockers.length !== amazonPlotable) {
    msg += ` · ${(lockers.length - amazonPlotable).toLocaleString()} dropped (bad coords)`;
  }
  setStats(msg);
}

// Merged-panel chooser: lists every service at the clicked spot. Clicking a
// row jumps to that service's regular panel via its existing open handler.
function openMergedPanel(group) {
  const el = document.getElementById('panel-content');
  document.getElementById('panel-refresh').hidden = true;
  currentPanelKind = 'merged';
  currentPanelId = null;
  setPanelStatus('');
  let html = `<h2>${group.length} services at this location</h2>`;
  html += `<p class="hint">Different operators sometimes co-locate hardware ` +
          `at the same site. Click an entry to see its details.</p>`;
  html += `<ul class="merged-list">`;
  for (let i = 0; i < group.length; i++) {
    html += `<li><button data-i="${i}" class="merged-row">` +
            `<span class="merged-kind">${escHtml(group[i].kindLabel)}</span>` +
            `<span class="merged-label">${escHtml(group[i].label)}</span>` +
            `</button></li>`;
  }
  html += `</ul>`;
  el.innerHTML = html;
  el.querySelectorAll('button.merged-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.i);
      const it = group[idx];
      if (it && typeof it.open === 'function') it.open();
    });
  });
  document.getElementById('panel').hidden = false;
}

// Backwards-compatible alias — many callers (filter handlers, station
// filter, bulk toggle) still call rebuildMarkers() by name.
const rebuildMarkers = rebuildAllMarkers;

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
  // Bulk "all / none" toggles for the Amazon filter groups. Static HTML
  // hooks (data-target=type|provider, data-act=all|none) so we don't have
  // to re-bind on every render.
  document.querySelectorAll('.toggle-all').forEach(span => {
    span.addEventListener('click', e => {
      const a = e.target.closest('a[data-act]');
      if (!a) return;
      const checked = a.dataset.act === 'all';
      const target = span.dataset.target;
      if (target === 'type') setAllAmazonTypes(checked);
      else if (target === 'provider') setAllProviders(checked);
    });
  });
}

function setAllAmazonTypes(checked) {
  document.querySelectorAll('input[data-type]').forEach(cb => { cb.checked = checked; });
  activeTypes.clear();
  if (checked) for (const t of amazonTypes) activeTypes.add(t);
  rebuildMarkers();
}

function setAllProviders(checked) {
  document.querySelectorAll('input[data-provider]').forEach(cb => { cb.checked = checked; });
  activeProviders.clear();
  if (checked) for (const p of providers) activeProviders.add(p);
  rebuildMarkers();
}

// ---------- station filter ----------------------------------------------
function installStationFilter() {
  document.getElementById('near-station').addEventListener('change', e => {
    nearStationOn = e.target.checked;
    rebuildMarkers();
  });
  document.getElementById('station-radius').addEventListener('change', e => {
    stationRadiusM = Number(e.target.value);
    rebuildMarkers();
  });
  document.querySelectorAll('input[data-station-kind]').forEach(cb => {
    cb.addEventListener('change', () => {
      const k = cb.dataset.stationKind;
      if (cb.checked) activeStationKinds.add(k); else activeStationKinds.delete(k);
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

function openInpostPanel(id) {
  const p = inpostById.get(id);
  if (!p) return;
  currentPanelId = id;
  currentPanelKind = 'inpost';
  document.getElementById('panel-refresh').hidden = true;
  renderInpostPanel(p);
  setPanelStatus('');
  document.getElementById('panel').hidden = false;
  if (p.type === 'parcel_locker') fetchInpostLive(id);
}

function openQuadientPanel(id) {
  const p = quadientById.get(id);
  if (!p) return;
  currentPanelId = id;
  currentPanelKind = 'quadient';
  document.getElementById('panel-refresh').hidden = true;
  renderQuadientPanel(p);
  setPanelStatus('');
  document.getElementById('panel').hidden = false;
}

function openYeepPanel(id) {
  const p = yeepById.get(id);
  if (!p) return;
  currentPanelId = id;
  currentPanelKind = 'yeep';
  document.getElementById('panel-refresh').hidden = true;
  renderYeepPanel(p);
  setPanelStatus('');
  document.getElementById('panel').hidden = false;
}

// InPost compartment status (A=Small, B=Medium, C=Large) and an overall
// reading. Hits a server-side proxy that calls the InPost API per click.
async function fetchInpostLive(id) {
  let res;
  try {
    const r = await fetch(`/api/inpost/${encodeURIComponent(id)}/refresh`);
    res = await r.json();
    if (!r.ok) throw new Error(res.error || `HTTP ${r.status}`);
  } catch (e) {
    // The panel may have moved on to a different locker by the time the
    // fetch resolves — only paint into the slot if it's still ours.
    if (currentPanelKind !== 'inpost' || currentPanelId !== id) return;
    const slot = document.getElementById('inpost-live-val');
    if (slot) slot.innerHTML = `<span class="err">Live fetch failed: ${escHtml(e.message)}</span>`;
    return;
  }
  if (currentPanelKind !== 'inpost' || currentPanelId !== id) return;
  const slot = document.getElementById('inpost-live-val');
  if (!slot) return;
  // The InPost API exposes coarse fill levels per compartment size. We map
  // each code to a colour + plain-English word so users don't need to learn
  // InPost's vocabulary — green = lots free, yellow = some, red = full.
  const STATUS_LABEL = {
    NORMAL:   'Available',
    LOW:      'Limited',
    VERY_LOW: 'Full',
    NO_DATA:  'No data',
  };
  const SIZES = [
    ['A', 'Small'],
    ['B', 'Medium'],
    ['C', 'Large'],
  ];
  const pills = SIZES.map(([k, label]) => {
    const code = (res.compartments || {})[k] || 'NO_DATA';
    const status = STATUS_LABEL[code] || STATUS_LABEL.NO_DATA;
    return `<div class="avail-pill avail-${cssId(code)}">` +
           `<div class="avail-size">${escHtml(label)}</div>` +
           `<div class="avail-status">${escHtml(status)}</div></div>`;
  }).join('');
  slot.innerHTML = `<div class="avail-row">${pills}</div>`;
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

function renderInpostPanel(p) {
  const el = document.getElementById('panel-content');
  const lat = p.location && p.location.latitude;
  const lng = p.location && p.location.longitude;
  const dirHref = (typeof lat === 'number' && typeof lng === 'number')
    ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : null;
  const typeLabel = p.type === 'parcel_locker' ? 'Parcel locker'
                  : (p.type === 'pok' || p.type === 'pop') ? 'Partner shop' : (p.type || 'InPost');
  let html = `<h2>${escHtml(p.addressLine1 || p.id || 'InPost point')}</h2>`;
  html += `<div><span class="badge">${escHtml(typeLabel)}</span>`;
  if (p.is247) html += ` <span class="badge">24/7</span>`;
  if (p.locationType) html += ` <span class="badge">${escHtml(p.locationType)}</span>`;
  if (p.easyAccess) html += ` <span class="badge">Easy access</span>`;
  html += `</div>`;
  const addrLines = [p.addressLine2, p.city, p.province, p.postcode]
    .filter(Boolean).map(escHtml).join('<br>');
  if (addrLines) {
    html += `<div class="field"><div class="field-key">Address</div>` +
            `<div class="field-val">${addrLines}</div></div>`;
  }
  if (p.locationDescription) {
    html += `<div class="field"><div class="field-key">Where to find it</div>` +
            `<div class="field-val">${escHtml(p.locationDescription)}</div></div>`;
  }
  if (p.openingHours) {
    html += `<div class="field"><div class="field-key">Opening hours</div>` +
            `<div class="field-val">${escHtml(p.openingHours)}</div></div>`;
  }
  const flags = [];
  if (p.supportsCollect) flags.push('Collect');
  if (p.supportsSend) flags.push('Send');
  if (p.supportsReturn) flags.push('Return');
  if (flags.length) {
    html += `<div class="field"><div class="field-key">Functions</div>` +
            `<div class="field-val">${flags.join(', ')}</div></div>`;
  }
  // Live compartment availability is fetched per-locker on demand. We render
  // a placeholder slot here and fill it in when openInpostPanel() finishes
  // its /api/inpost/{id}/refresh call. Partner shops (pok/pop) don't have
  // compartments, so skip the section for them.
  if (p.type === 'parcel_locker') {
    html += `<div class="field" id="inpost-live-slot">` +
            `<div class="field-key">Live availability</div>` +
            `<div class="field-val" id="inpost-live-val">` +
            `<em>Fetching live data…</em></div></div>`;
  }
  if (p.imageUrl) {
    html += `<div class="field"><div class="field-key">Photo</div>` +
            `<div class="field-val"><a href="${escAttr(p.imageUrl)}" target="_blank" rel="noopener">view</a></div></div>`;
  }
  html += `<div class="field"><div class="field-key">ID</div>` +
          `<div class="field-val">${escHtml(p.id || '')}</div></div>`;
  if (dirHref) {
    html += `<div class="field"><div class="field-key">Directions</div>` +
            `<div class="field-val"><a href="${escAttr(dirHref)}" target="_blank" rel="noopener">Open in Google Maps</a></div></div>`;
  }
  el.innerHTML = html;
}

function renderQuadientPanel(p) {
  const el = document.getElementById('panel-content');
  const a = p.address || {};
  const addrLines = [...(a.lines || []), a.city, a.county, a.postcode]
    .filter(Boolean).map(escHtml).join('<br>');
  const lat = p.location && p.location.latitude;
  const lng = p.location && p.location.longitude;
  const dirHref = (typeof lat === 'number' && typeof lng === 'number')
    ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : null;
  const oh = p.openingHours || {};
  const stasher = p.stasher || {};

  let html = `<h2>${escHtml(p.host || p.name || 'Parcel Pending locker')}</h2>`;
  html += `<div>`;
  html += `<span class="badge">Parcel Pending</span>`;
  if (oh.open24_7) html += ` <span class="badge">24/7</span>`;
  else if (oh.openLate) html += ` <span class="badge">Open late</span>`;
  if (stasher.featured) html += ` <span class="badge">Featured</span>`;
  if (stasher.premium) html += ` <span class="badge">Premium</span>`;
  if (stasher.new) html += ` <span class="badge">New</span>`;
  if (stasher.stepFreeAccess) html += ` <span class="badge">Step-free</span>`;
  html += `</div>`;

  if (stasher.alert) {
    html += `<p class="bad-coord-warn">${escHtml(stasher.alert)}</p>`;
  }

  if (addrLines) {
    html += `<div class="field"><div class="field-key">Address</div>` +
            `<div class="field-val">${addrLines}</div></div>`;
  }
  if (stasher.nearestLandmark) {
    html += `<div class="field"><div class="field-key">Nearest landmark</div>` +
            `<div class="field-val">${escHtml(stasher.nearestLandmark)}</div></div>`;
  }
  if (stasher.capacity != null && stasher.capacity > 0) {
    const sizeBit = stasher.sizeRestrictions ? ` (${escHtml(stasher.sizeRestrictions)} only)` : '';
    html += `<div class="field"><div class="field-key">Capacity</div>` +
            `<div class="field-val">${stasher.capacity} compartments${sizeBit}</div></div>`;
  } else if (stasher.sizeRestrictions) {
    html += `<div class="field"><div class="field-key">Size</div>` +
            `<div class="field-val">${escHtml(stasher.sizeRestrictions)}</div></div>`;
  }
  if (stasher.ratingCount && stasher.rating != null) {
    html += `<div class="field"><div class="field-key">Rating</div>` +
            `<div class="field-val">${stasher.rating}/5 (${stasher.ratingCount} reviews)</div></div>`;
  }

  // Legacy per-day opening hours from the old Apps Script feed. Keep the
  // table when present so existing manually-curated records still render.
  const DAYS = [['mon','Mon'],['tue','Tue'],['wed','Wed'],['thu','Thu'],['fri','Fri'],['sat','Sat'],['sun','Sun']];
  if (DAYS.some(([k]) => typeof oh[k] === 'string' && oh[k])) {
    const ohRows = DAYS.map(([k, label]) =>
      `<tr><td>${escHtml(label)}</td><td>${escHtml(oh[k] || '—')}</td></tr>`
    ).join('');
    html += `<div class="field"><div class="field-key">Hours</div>` +
            `<div class="field-val"><table class="hours">${ohRows}</table></div></div>`;
  }

  if (Array.isArray(p.services) && p.services.length) {
    html += `<div class="field"><div class="field-key">Carriers</div>` +
            `<div class="field-val">${p.services.map(escHtml).join(', ')}</div></div>`;
  }
  if (p.url) {
    html += `<div class="field"><div class="field-key">Stasher page</div>` +
            `<div class="field-val"><a href="${escAttr(p.url)}" target="_blank" rel="noopener">Open in Stasher</a></div></div>`;
  }
  if (dirHref) {
    html += `<div class="field"><div class="field-key">Directions</div>` +
            `<div class="field-val"><a href="${escAttr(dirHref)}" target="_blank" rel="noopener">Open in Google Maps</a></div></div>`;
  }
  el.innerHTML = html;
}

function renderYeepPanel(p) {
  const el = document.getElementById('panel-content');
  const lat = p.location && p.location.latitude;
  const lng = p.location && p.location.longitude;
  const dirHref = (typeof lat === 'number' && typeof lng === 'number')
    ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : null;
  let html = `<h2>${escHtml(p.title || p.name || 'Yeep locker')}</h2>`;
  html += `<div><span class="badge">Yeep</span>`;
  for (const c of p.carriers || []) html += ` <span class="badge">${escHtml(c)}</span>`;
  html += `</div>`;
  if (p.address) {
    html += `<div class="field"><div class="field-key">Address</div>` +
            `<div class="field-val">${escHtml(p.address)}</div></div>`;
  }
  if (p.postcode) {
    html += `<div class="field"><div class="field-key">Postcode</div>` +
            `<div class="field-val">${escHtml(p.postcode)}</div></div>`;
  }
  if (p.what3words) {
    const url = p.what3wordsUrl || `https://w3w.co/${encodeURIComponent(p.what3words)}`;
    html += `<div class="field"><div class="field-key">what3words</div>` +
            `<div class="field-val"><a href="${escAttr(url)}" target="_blank" rel="noopener">///${escHtml(p.what3words)}</a></div></div>`;
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
