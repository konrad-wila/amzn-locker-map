#!/usr/bin/env python3
"""
Harvest every Amazon locker / counter in the UK from the
amazon.co.uk location_selector/fetch_locations endpoint.

The endpoint has two hard limits that drove the design:
  * Returns at most 20 results per call (closest-first).
  * Will not return anything more than ~15 km from the query point.

So we sweep an adaptive grid across the UK bounding box. Whenever a tile
returns a saturated 20 results whose furthest locker is closer than the tile
itself spans, we subdivide that tile into four quadrants. Sparse tiles are
left alone. Results are deduplicated by locker id.

Usage:
    python3 harvest_uk.py            # full run, writes lockers.jsonl + lockers.json
    python3 harvest_uk.py --resume   # skip tiles already recorded in progress.jsonl
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import math
import os
import queue
import random
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

# --- UK bounding box (rough; the per-call radius cap clips the rest) -------
UK_LAT_MIN, UK_LAT_MAX = 49.85, 61.00   # Scilly to Shetland
UK_LNG_MIN, UK_LNG_MAX = -8.65, 1.85    # West Ireland edge to East Anglia

# --- Tile sizing -----------------------------------------------------------
# API radius is ~15 km. A tile of side S covers its corners only if
# S*sqrt(2)/2 <= 15  =>  S <= ~21 km. We use 15 km to leave headroom.
BASE_STEP_KM = 15.0
# Don't subdivide finer than this. Below ~0.5 km even London is exhausted.
MIN_HALF_KM = 0.30
# A tile is "saturated" when it returns SATURATION_COUNT results.
SATURATION_COUNT = 20
# Skip base tiles whose centre is more than this far from any UK landmass.
# Tile half-side (7.5 km) + API search radius (~15 km) gives ~22 km of useful
# reach from a tile centre to a coastal locker, so 20 km is the right buffer.
LANDMASS_BUFFER_KM = 20.0

# --- HTTP ------------------------------------------------------------------
ENDPOINT = "https://www.amazon.co.uk/location_selector/fetch_locations"
STATIC_PARAMS = {
    "clientId": "amazon_gb_add_to_addressbook_desktop",
    "countryCode": "GB",
    "lowerSlotPreference": "false",
    "sortType": "RECOMMENDED",
    "userBenefit": "true",
    "showFreeShippingLabel": "true",
    "showPromotionDetail": "true",
    "showAvailableLocations": "false",
}
HEADERS = {
    "Accept": "application/json",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "en-GB,en;q=0.9",
    "Referer": "https://www.amazon.co.uk/a/addresses/add?ref=ya_address_book_add_button",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
}

MAX_WORKERS = 3
PER_REQUEST_SLEEP = 0.4   # extra jitter on top of natural latency
MAX_RETRIES = 5
# Reject a result whose `location` is more than this many km from the
# stated `distance` field, or more than this multiple of stated distance.
LOC_SLACK_KM = 5.0
LOC_SLACK_MULT = 2.0

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
LOCKERS_JSONL = os.path.join(OUT_DIR, "lockers.jsonl")
LOCKERS_JSON = os.path.join(OUT_DIR, "lockers.json")
PROGRESS_LOG = os.path.join(OUT_DIR, "progress.jsonl")


@dataclass(frozen=True)
class Tile:
    lat: float
    lng: float
    half_km: float  # half the side length, in km

    @property
    def diagonal_km(self) -> float:
        return self.half_km * math.sqrt(2)


# --- Geometry helpers ------------------------------------------------------
def km_per_deg_lng(lat_deg: float) -> float:
    return 111.320 * math.cos(math.radians(lat_deg))


def km_per_deg_lat() -> float:
    return 110.574


def parse_distance_to_km(s: str | None) -> float | None:
    """Parses distance strings the API returns: '217 ft', '0.7 mi', '4.9 mi'."""
    if not s:
        return None
    m = re.match(r"\s*([0-9]*\.?[0-9]+)\s*(mi|ft|km|m)\s*$", s, re.I)
    if not m:
        return None
    val = float(m.group(1))
    unit = m.group(2).lower()
    return {
        "mi": val * 1.609344,
        "ft": val * 0.0003048,
        "km": val,
        "m": val * 0.001,
    }[unit]


# --- Networking ------------------------------------------------------------
class APIError(RuntimeError):
    pass


USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
]


def fetch_locations(lat: float, lng: float) -> dict:
    params = dict(STATIC_PARAMS, latitude=f"{lat:.6f}", longitude=f"{lng:.6f}")
    url = f"{ENDPOINT}?{urllib.parse.urlencode(params)}"
    headers = dict(HEADERS, **{"User-Agent": random.choice(USER_AGENTS)})
    req = urllib.request.Request(url, headers=headers)
    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding", "").lower() == "gzip":
                    raw = gzip.decompress(raw)
                body = raw.decode("utf-8", errors="replace")
                # Bot-detection response is HTML. Treat as a 503-ish.
                if body.lstrip().startswith("<"):
                    last_err = APIError("bot-detection HTML body")
                    time.sleep(min(60, (2 ** attempt) * 5) + random.random() * 2)
                    continue
                return json.loads(body)
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 500, 502, 503, 504):
                backoff = min(60, (2 ** attempt) * 5) + random.random() * 2
                time.sleep(backoff)
                continue
            raise APIError(f"HTTP {e.code} for {lat},{lng}") from e
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_err = e
            time.sleep((2 ** attempt) + random.random())
    raise APIError(f"giving up on {lat},{lng}: {last_err!r}")


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def looks_real(loc: dict, q_lat: float, q_lng: float) -> bool:
    """Drop results whose returned coords contradict the stated distance.

    The API will sometimes return junk records when the query point is far
    from any locker (e.g. queries placed over the open sea). In those cases
    the `location` field doesn't match the postcode, and the haversine
    distance from the query to that location wildly disagrees with the
    string in `distance`. Also clip to the UK bbox as a backstop.
    """
    g = loc.get("location") or {}
    rlat, rlng = g.get("latitude"), g.get("longitude")
    if rlat is None or rlng is None:
        return False
    if not (UK_LAT_MIN - 0.5 <= rlat <= UK_LAT_MAX + 0.5):
        return False
    if not (UK_LNG_MIN - 0.5 <= rlng <= UK_LNG_MAX + 0.5):
        return False
    stated_km = parse_distance_to_km(loc.get("distance"))
    actual_km = haversine_km(q_lat, q_lng, rlat, rlng)
    if stated_km is None:
        # No way to validate; require it's at least within the API's radius.
        return actual_km <= 20.0
    if actual_km > stated_km * LOC_SLACK_MULT + LOC_SLACK_KM:
        return False
    return True


# --- Adaptive harvest ------------------------------------------------------
class Harvester:
    def __init__(self, resume: bool):
        self.lock = threading.Lock()
        self.lockers: dict[str, dict] = {}
        self.tiles_done: set[tuple[float, float, float]] = set()
        self.tiles_meta: dict[tuple[float, float, float], dict] = {}
        self.requests_made = 0
        self.empty_tiles = 0

        # Open append-only logs. JSONL gives crash-safe progress.
        self._lockers_fp = open(LOCKERS_JSONL, "a", encoding="utf-8")
        self._progress_fp = open(PROGRESS_LOG, "a", encoding="utf-8")

        if resume:
            self._restore()

    def _restore(self) -> None:
        if os.path.exists(LOCKERS_JSONL):
            with open(LOCKERS_JSONL, encoding="utf-8") as f:
                for line in f:
                    try:
                        rec = json.loads(line)
                        if rec.get("id"):
                            self.lockers[rec["id"]] = rec
                    except json.JSONDecodeError:
                        continue
        if os.path.exists(PROGRESS_LOG):
            with open(PROGRESS_LOG, encoding="utf-8") as f:
                for line in f:
                    try:
                        t = json.loads(line)
                        key = (round(t["lat"], 5), round(t["lng"], 5), round(t["half_km"], 3))
                        self.tiles_done.add(key)
                        self.tiles_meta[key] = t
                    except (json.JSONDecodeError, KeyError):
                        continue
        print(f"[resume] {len(self.lockers)} lockers and {len(self.tiles_done)} tiles loaded")

    def reconcile_subdivisions(self) -> list[Tile]:
        """Walk every saturated tile loaded from progress.jsonl and re-emit any
        children that never got processed.

        Fixes the case where the previous run was interrupted between marking a
        parent tile done and enqueueing/finishing its children. Without this
        pass, --resume only re-queues the base grid, finds it already done, and
        exits — leaving orphaned subdivision branches forever unprocessed.
        """
        out: list[Tile] = []
        for key, rec in self.tiles_meta.items():
            n = rec.get("n", 0)
            if n < SATURATION_COUNT:
                continue
            half_km = rec["half_km"]
            if half_km <= MIN_HALF_KM:
                continue
            max_dist_km = rec.get("max_dist_km")
            diag = half_km * math.sqrt(2)
            # If we have max_dist_km in the log, only re-emit when subdivision
            # is genuinely needed. Legacy entries (no max_dist_km, written by
            # earlier runs) get re-emitted unconditionally — better to spend a
            # few thousand extra calls than to leave gaps like central
            # Leicester unindexed.
            if max_dist_km is not None and max_dist_km >= diag * 0.95:
                continue
            new_half = half_km / 2.0
            d_lat = new_half / km_per_deg_lat()
            d_lng = new_half / km_per_deg_lng(rec["lat"])
            for sy in (+1, -1):
                for sx in (+1, -1):
                    child = Tile(rec["lat"] + sy * d_lat,
                                 rec["lng"] + sx * d_lng,
                                 new_half)
                    ckey = (round(child.lat, 5), round(child.lng, 5), round(child.half_km, 3))
                    if ckey in self.tiles_done:
                        continue
                    out.append(child)
        return out

    def record_lockers(self, raw_list: list[dict], q_lat: float, q_lng: float) -> tuple[int, int]:
        new = 0
        rejected = 0
        with self.lock:
            for loc in raw_list:
                if not looks_real(loc, q_lat, q_lng):
                    rejected += 1
                    continue
                lid = loc.get("id") or loc.get("addressId") or loc.get("storeId")
                if not lid or lid in self.lockers:
                    continue
                self.lockers[lid] = loc
                self._lockers_fp.write(json.dumps(loc, ensure_ascii=False) + "\n")
                new += 1
            if new:
                self._lockers_fp.flush()
        return new, rejected

    def mark_tile(self, t: Tile, count: int, max_dist_km: float | None = None) -> None:
        with self.lock:
            key = (round(t.lat, 5), round(t.lng, 5), round(t.half_km, 3))
            self.tiles_done.add(key)
            entry = {"lat": t.lat, "lng": t.lng, "half_km": t.half_km, "n": count}
            if max_dist_km is not None:
                entry["max_dist_km"] = max_dist_km
            self.tiles_meta[key] = entry
            self._progress_fp.write(json.dumps(entry) + "\n")
            self._progress_fp.flush()

    def already_done(self, t: Tile) -> bool:
        key = (round(t.lat, 5), round(t.lng, 5), round(t.half_km, 3))
        return key in self.tiles_done

    def process_tile(self, t: Tile) -> list[Tile]:
        """Query a tile, record results, return any sub-tiles to enqueue."""
        if self.already_done(t):
            return []
        data = fetch_locations(t.lat, t.lng)
        with self.lock:
            self.requests_made += 1
        locs = data.get("locationList") or []
        new_count, rejected = self.record_lockers(locs, t.lat, t.lng)
        max_dist_km = (max((parse_distance_to_km(l.get("distance")) or 0.0)
                           for l in locs)
                       if locs else None)
        self.mark_tile(t, len(locs), max_dist_km)
        if not locs or rejected == len(locs):
            with self.lock:
                self.empty_tiles += 1
            return []

        # Decide whether to subdivide. We only need to recurse when the API
        # truncated the list AND its furthest hit is closer than the tile
        # corners — meaning unseen lockers may sit beyond that radius but
        # still inside the tile.
        if len(locs) < SATURATION_COUNT:
            return []
        if t.half_km <= MIN_HALF_KM:
            return []
        # Add a small fudge: if the furthest hit is within 95% of the
        # half-diagonal, treat the tile as fully covered.
        if max_dist_km is None or max_dist_km >= t.diagonal_km * 0.95:
            return []

        # Subdivide into 4 quadrants, each half the side.
        new_half = t.half_km / 2.0
        d_lat = (new_half / km_per_deg_lat())
        d_lng = (new_half / km_per_deg_lng(t.lat))
        children = [
            Tile(t.lat + d_lat, t.lng + d_lng, new_half),
            Tile(t.lat + d_lat, t.lng - d_lng, new_half),
            Tile(t.lat - d_lat, t.lng + d_lng, new_half),
            Tile(t.lat - d_lat, t.lng - d_lng, new_half),
        ]
        with self.lock:
            print(
                f"  subdivide @({t.lat:.3f},{t.lng:.3f}) half={t.half_km:.2f}km "
                f"saw 20 within {max_dist_km:.2f}km, +{new_count} new "
                f"(total {len(self.lockers)})"
            )
        return children

    def close(self) -> None:
        self._lockers_fp.close()
        self._progress_fp.close()


def base_grid() -> list[Tile]:
    """Even grid of tile centers covering the UK bbox at BASE_STEP_KM,
    filtered to those within LANDMASS_BUFFER_KM of UK landmass."""
    half = BASE_STEP_KM / 2
    lat_step_deg = BASE_STEP_KM / km_per_deg_lat()
    out: list[Tile] = []
    skipped = 0
    lat = UK_LAT_MIN + lat_step_deg / 2
    while lat <= UK_LAT_MAX:
        lng_step_deg = BASE_STEP_KM / km_per_deg_lng(lat)
        lng = UK_LNG_MIN + lng_step_deg / 2
        while lng <= UK_LNG_MAX:
            if is_near_uk_landmass(lat, lng, LANDMASS_BUFFER_KM):
                out.append(Tile(round(lat, 6), round(lng, 6), half))
            else:
                skipped += 1
            lng += lng_step_deg
        lat += lat_step_deg
    print(f"Landmass mask: {skipped} ocean tiles skipped, {len(out)} kept")
    return out


# --- UK landmass mask ------------------------------------------------------
# Coarse polygons in (lat, lng) order. Buffer ~20 km is generous enough that
# small coastline approximations and offshore lockers are caught.

def _bbox_polygon(lat0: float, lat1: float, lng0: float, lng1: float) -> list[tuple[float, float]]:
    return [(lat0, lng0), (lat0, lng1), (lat1, lng1), (lat1, lng0)]


# Mainland Great Britain — clockwise from Cape Wrath.
# Includes detail for the Bristol Channel (it's too deep to cut across).
GB_MAINLAND = [
    (58.62, -5.00),   # Cape Wrath
    (58.57, -3.99),   # Strathy Point
    (58.67, -3.38),   # Dunnet Head
    (58.64, -3.03),   # Duncansby Head (NE tip)
    (58.12, -3.65),   # Helmsdale (start of east coast)
    (57.70, -2.00),   # Fraserburgh (cuts Moray Firth mouth)
    (57.51, -1.78),   # Peterhead
    (57.15, -2.10),   # Aberdeen
    (56.96, -2.21),   # Stonehaven
    (56.50, -2.71),   # Carnoustie
    (56.34, -2.78),   # St Andrews
    (56.06, -2.71),   # North Berwick (cuts Forth mouth)
    (55.87, -2.10),   # Eyemouth
    (55.77, -2.00),   # Berwick-upon-Tweed
    (55.02, -1.42),   # Tynemouth
    (54.49, -0.62),   # Whitby
    (54.12, -0.08),   # Flamborough Head
    (53.58, 0.10),    # Spurn Head
    (53.15, 0.36),    # Skegness
    (52.97, 0.50),    # (cuts The Wash)
    (52.94, 1.30),    # Cromer
    (52.48, 1.75),    # Lowestoft (easternmost UK point)
    (51.96, 1.35),    # Felixstowe
    (51.39, 1.45),    # North Foreland / Margate
    (51.13, 1.32),    # Dover
    (50.85, 0.57),    # Hastings
    (50.82, -0.14),   # Brighton
    (50.78, -1.10),   # Portsmouth
    (50.61, -2.46),   # Weymouth
    (50.36, -4.14),   # Plymouth
    (49.96, -5.20),   # Lizard Point (southernmost)
    (50.07, -5.72),   # Land's End
    (50.42, -5.10),   # Newquay
    (51.02, -4.53),   # Hartland Point
    (51.21, -4.13),   # Ilfracombe
    (51.21, -3.10),   # Bridgwater Bay (S side of Bristol Channel)
    (51.50, -2.70),   # Avonmouth
    (51.61, -2.65),   # Severn Bridge
    (51.59, -2.99),   # Newport (N side of channel)
    (51.48, -3.18),   # Cardiff
    (51.40, -3.27),   # Barry
    (51.62, -3.94),   # Swansea
    (51.67, -4.70),   # Tenby
    (51.88, -5.32),   # St David's Head
    (52.07, -4.66),   # Cardigan
    (52.41, -4.10),   # Aberystwyth
    (52.89, -4.42),   # Pwllheli (Llyn tip)
    (53.32, -4.66),   # Holyhead (Anglesey tucked into mainland for masking)
    (53.33, -3.83),   # Llandudno
    (53.40, -3.00),   # Liverpool
    (53.82, -3.05),   # Blackpool
    (54.10, -3.27),   # Walney
    (54.50, -3.62),   # St Bees Head
    (54.95, -3.55),   # Solway
    (54.90, -5.07),   # Stranraer
    (54.63, -4.85),   # Mull of Galloway
    (55.30, -5.79),   # Mull of Kintyre
    (56.41, -5.48),   # Oban
    (56.73, -6.20),   # Ardnamurchan Point (westernmost mainland)
    (57.00, -5.83),   # Mallaig
    (57.28, -5.71),   # Kyle of Lochalsh
    (57.90, -5.16),   # Ullapool
    (58.15, -5.25),   # Lochinver
]

NORTHERN_IRELAND = [
    (54.07, -5.85),   # SE near Carlingford Lough
    (54.66, -5.55),   # Bangor
    (54.85, -5.79),   # Larne
    (55.21, -6.04),   # Ballycastle
    (55.20, -6.66),   # Portrush
    (55.20, -7.00),   # Inishowen
    (54.99, -7.31),   # Derry
    (54.36, -7.57),   # Fermanagh border
    (54.18, -6.34),   # Newry
]

# Offshore archipelagos as bboxes (interior accepted; buffer extends outward).
SCILLY = _bbox_polygon(49.86, 49.99, -6.43, -6.18)
ISLE_OF_MAN = _bbox_polygon(54.04, 54.42, -4.83, -4.31)
OUTER_HEBRIDES = _bbox_polygon(56.78, 58.55, -7.65, -6.13)
ORKNEY = _bbox_polygon(58.71, 59.40, -3.43, -2.34)
SHETLAND = _bbox_polygon(59.85, 60.85, -1.78, -0.72)

UK_POLYGONS = [
    GB_MAINLAND,
    NORTHERN_IRELAND,
    SCILLY,
    ISLE_OF_MAN,
    OUTER_HEBRIDES,
    ORKNEY,
    SHETLAND,
]


def _point_in_polygon(lat: float, lng: float, poly: list[tuple[float, float]]) -> bool:
    """Ray casting in (lat, lng) space — fine for small angular extents."""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        yi, xi = poly[i]
        yj, xj = poly[j]
        if ((yi > lat) != (yj > lat)) and \
                (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _point_segment_dist_km(plat: float, plng: float,
                           alat: float, alng: float,
                           blat: float, blng: float) -> float:
    """Distance from point P to segment AB in km (equirectangular projection)."""
    mid_lat = (plat + alat + blat) / 3.0
    kx = math.cos(math.radians(mid_lat)) * 111.32
    ky = 110.574
    px, py = plng * kx, plat * ky
    ax, ay = alng * kx, alat * ky
    bx, by = blng * kx, blat * ky
    abx, aby = bx - ax, by - ay
    ab_sq = abx * abx + aby * aby
    if ab_sq == 0.0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * abx + (py - ay) * aby) / ab_sq))
    cx, cy = ax + t * abx, ay + t * aby
    return math.hypot(px - cx, py - cy)


def _min_dist_to_polygon_km(lat: float, lng: float,
                            poly: list[tuple[float, float]]) -> float:
    n = len(poly)
    return min(
        _point_segment_dist_km(lat, lng,
                               poly[i][0], poly[i][1],
                               poly[(i + 1) % n][0], poly[(i + 1) % n][1])
        for i in range(n)
    )


def is_near_uk_landmass(lat: float, lng: float, buffer_km: float) -> bool:
    for poly in UK_POLYGONS:
        if _point_in_polygon(lat, lng, poly):
            return True
        if _min_dist_to_polygon_km(lat, lng, poly) <= buffer_km:
            return True
    return False


def run(resume: bool, limit: int | None) -> None:
    h = Harvester(resume=resume)
    base = base_grid()
    print(f"Base grid: {len(base)} tiles at {BASE_STEP_KM} km step")

    pending: queue.Queue[Tile] = queue.Queue()

    # Reconcile-first: orphaned children are the most valuable work, and base
    # tiles already in tiles_done would just no-op through already_done().
    # Putting them at the head of the queue means the user sees progress
    # immediately instead of watching N hundred no-ops scroll by.
    recovered: list[Tile] = []
    if resume:
        recovered = h.reconcile_subdivisions()
        if recovered:
            print(f"[reconcile] re-emitting {len(recovered)} subdivision children "
                  f"that prior runs left orphaned")
            for t in recovered:
                pending.put(t)

    skipped_done = 0
    queued_base = 0
    for t in base:
        if h.already_done(t):
            skipped_done += 1
            continue
        pending.put(t)
        queued_base += 1
    if skipped_done:
        print(f"Skipping {skipped_done} base tiles already done in prior runs; "
              f"{queued_base} fresh base tiles + {len(recovered)} reconciled "
              f"= {queued_base + len(recovered)} total to process")

    if limit:
        # rough cap on overall queries (debug)
        print(f"(limit set to {limit} tiles)")

    in_flight = 0
    inflight_lock = threading.Lock()
    seen_total = {"v": 0}

    def worker(t: Tile) -> list[Tile]:
        time.sleep(PER_REQUEST_SLEEP * random.random())
        return h.process_tile(t)

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures: dict = {}
        last_log = time.time()

        def submit(t: Tile) -> None:
            nonlocal in_flight
            with inflight_lock:
                in_flight += 1
            f = pool.submit(worker, t)
            futures[f] = t

        # prime
        while not pending.empty() and len(futures) < MAX_WORKERS * 4:
            submit(pending.get())

        while futures:
            done = next(as_completed(futures))
            tile = futures.pop(done)
            with inflight_lock:
                in_flight -= 1
            try:
                children = done.result()
            except Exception as e:
                print(f"  ! tile {tile} failed: {e}")
                children = []
            for c in children:
                pending.put(c)

            seen_total["v"] += 1
            if limit and seen_total["v"] >= limit:
                break

            # Refill the pool from the pending queue.
            while not pending.empty() and (len(futures) + in_flight) < MAX_WORKERS * 4:
                submit(pending.get())

            now = time.time()
            if now - last_log > 5.0:
                last_log = now
                print(
                    f"  tiles done: {seen_total['v']} | pending: {pending.qsize()} | "
                    f"in-flight: {in_flight} | lockers: {len(h.lockers)} | "
                    f"empty: {h.empty_tiles}"
                )

    # Finalize: write a single consolidated JSON.
    print("Writing consolidated lockers.json …")
    with open(LOCKERS_JSON, "w", encoding="utf-8") as f:
        json.dump(list(h.lockers.values()), f, ensure_ascii=False, indent=2)
    h.close()
    print(
        f"Done. {len(h.lockers)} unique lockers from {h.requests_made} API calls "
        f"({h.empty_tiles} empty tiles)."
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--resume", action="store_true",
                    help="skip tiles already in progress.jsonl, keep prior lockers")
    ap.add_argument("--limit", type=int, default=None,
                    help="stop after this many tile results (for smoke tests)")
    args = ap.parse_args()
    try:
        run(resume=args.resume, limit=args.limit)
    except KeyboardInterrupt:
        print("Interrupted — partial output is in lockers.jsonl / progress.jsonl")
        sys.exit(130)
