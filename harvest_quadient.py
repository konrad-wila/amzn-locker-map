#!/usr/bin/env python3
"""Harvest the UK Quadient (Parcel Pending) locker network via Stasher.

Stasher (the luggage-storage marketplace) integrates the Quadient locker
operator under the codename "quadralink" and exposes the full network via
their public REST API. Per their JS bundle the path constant for that
operator is `/v2/quadralink`; in practice the bulk listing is served from
`/v3/stashpoints` with a `size_standard=quadralink` discriminator on each
record. This is a much richer source than Quadient's own brand-curated
Apps Script feed (which only publishes ~200 sites; Stasher exposes ~1,400
across the UK including the ones missing from the Apps Script feed —
Homebase, Co-op, Penny Petroleum, the post-2024 Northern Rail rollout etc.)

Pipeline:
  1. Paginate `/v3/stashpoints?country_code=GBR&page=N&page_size=20`
     (page_size is server-capped to 20).
  2. Keep records where `size_standard == "quadralink"`.
  3. Normalise into the schema the frontend already expects.

Output: quadient_lockers.json
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

API_BASE = "https://api.stasher.com"
LIST_PATH = "/v3/stashpoints"
COUNTRY_CODE = "GBR"
PAGE_SIZE = 20            # Stasher caps page_size at 20 server-side.
QUADIENT_KEY = "quadralink"

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "quadient_lockers.json")

HEADERS = {
    "Accept": "application/json",
    "Origin": "https://stasher.com",
    "Referer": "https://stasher.com/",
    "User-Agent": "amzn-locker-map/harvest_quadient.py",
}


def fetch_page(page: int) -> dict:
    url = (f"{API_BASE}{LIST_PATH}"
           f"?country_code={COUNTRY_CODE}&page={page}&page_size={PAGE_SIZE}")
    req = urllib.request.Request(url, headers=HEADERS)
    last: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"Stasher page {page} failed: {last!r}")


def normalize(item: dict) -> dict | None:
    if item.get("size_standard") != QUADIENT_KEY:
        return None
    lat = item.get("latitude")
    lng = item.get("longitude")
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        return None

    features = item.get("features") or {}
    nearest_city = item.get("nearest_city") or {}
    nearest_landmark = item.get("nearest_landmark") or {}

    name = (item.get("name") or "").strip()
    return {
        # Use the name as the display id for consistency with the previous
        # schema; Stasher's stashpoint id is preserved for cross-referencing.
        "id": name or item.get("id"),
        "stashpointId": item.get("id"),
        "name": name,
        "host": (item.get("location_name") or "").strip(),
        "address": {
            "lines": [],
            "city": nearest_city.get("name"),
            "county": None,
            "postcode": item.get("postal_code"),
            "country": "GB",
        },
        "location": {"latitude": lat, "longitude": lng},
        "phone": None,
        "url": (f"https://stasher.com/lockers/{item.get('id')}"
                if item.get("id") else None),
        # Stasher doesn't expose carrier lists; keep the field for schema
        # compatibility but leave it empty.
        "services": [],
        "openingHours": {
            "open24_7": bool(item.get("open_twentyfour_seven")),
            "openLate": bool(item.get("open_late")),
        },
        "lockerType": "Package Locker",
        "servicesDescription": None,
        "stasher": {
            "capacity": item.get("capacity"),
            "sizeRestrictions": item.get("size_restrictions"),
            "rating": item.get("rating"),
            "ratingCount": item.get("rating_count"),
            "featured": features.get("featured_stashpoint"),
            "premium": features.get("premium_stashpoint"),
            "new": features.get("new_stashpoint"),
            "stepFreeAccess": features.get("step_free_access"),
            "alert": features.get("alert"),
            "nearestLandmark": nearest_landmark.get("name"),
            "activatedAt": item.get("activated_at"),
        },
    }


def main() -> None:
    print("Fetching Quadient UK lockers via Stasher API…")
    started = time.time()
    first = fetch_page(1)
    total = first.get("total", 0)
    pages = first.get("pages", 0)
    print(f"  reported {total} UK stashpoints across {pages} pages "
          f"(page_size={PAGE_SIZE})")

    out: list[dict] = []
    seen: set[str] = set()
    skipped_non_quadient = 0
    skipped_dupes = 0

    def absorb(items: list[dict]) -> None:
        nonlocal skipped_non_quadient, skipped_dupes
        for item in items:
            if item.get("size_standard") != QUADIENT_KEY:
                skipped_non_quadient += 1
                continue
            rec = normalize(item)
            if not rec:
                continue
            sid = rec["stashpointId"]
            if sid and sid in seen:
                skipped_dupes += 1
                continue
            if sid:
                seen.add(sid)
            out.append(rec)

    absorb(first.get("items") or [])
    for p in range(2, pages + 1):
        d = fetch_page(p)
        absorb(d.get("items") or [])
        if p % 20 == 0 or p == pages:
            print(f"  page {p}/{pages}: {len(out)} Quadient kept, "
                  f"{skipped_non_quadient} non-Quadient skipped")

    out.sort(key=lambda r: ((r["address"].get("postcode") or ""), r.get("name") or ""))

    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": f"{API_BASE}{LIST_PATH}",
        "filter": f"country_code={COUNTRY_CODE} && size_standard={QUADIENT_KEY}",
        "totalSurveyed": total,
        "skippedNonQuadient": skipped_non_quadient,
        "skippedDupes": skipped_dupes,
        "count": len(out),
        "lockers": out,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - started
    print(f"Wrote {OUT_PATH}: {len(out)} Quadient lockers in {elapsed:.1f}s")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
