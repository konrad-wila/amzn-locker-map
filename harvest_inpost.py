#!/usr/bin/env python3
"""Harvest every UK InPost parcel locker / partner point.

Source: api-uk-global-points.easypack24.net/v1/points (the same endpoint
inpost.co.uk/lockers calls from the browser — no auth, public CORS).

The endpoint accepts `per_page` up to 5000, so the entire UK estate is
six requests. We keep status=Operating only (the API also returns Created,
Disabled and NonOperating sites — useless on a map). Each record is
normalised to a small subset of fields the frontend needs.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

ENDPOINT = "https://api-uk-global-points.easypack24.net/v1/points"
PER_PAGE = 5000

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "inpost_lockers.json")

HEADERS = {
    "Accept": "application/json",
    "User-Agent": "amzn-locker-map/harvest_inpost.py",
}
MAX_RETRIES = 3


def fetch_page(page: int) -> dict:
    url = f"{ENDPOINT}?per_page={PER_PAGE}&page={page}"
    last: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep(1.0 * (attempt + 1))
    raise RuntimeError(f"page {page} failed: {last!r}")


def normalize(p: dict) -> dict:
    g = p.get("location") or {}
    a = p.get("address") or {}
    ad = p.get("address_details") or {}
    fns = p.get("functions") or []
    return {
        "id": p.get("name"),                       # e.g. "UK00000146"
        "type": (p.get("type") or [None])[0],      # 'parcel_locker' | 'pok' | 'pop'
        "status": p.get("status"),
        "location": {
            "latitude": g.get("latitude"),
            "longitude": g.get("longitude"),
        },
        "addressLine1": a.get("line1"),
        "addressLine2": a.get("line2"),
        "city": ad.get("city"),
        "province": ad.get("province"),
        "postcode": ad.get("post_code"),
        "street": ad.get("street"),
        "buildingNumber": ad.get("building_number"),
        "openingHours": p.get("opening_hours"),
        "is247": bool(p.get("location_247")),
        "locationType": p.get("location_type"),    # 'Outdoor' / 'Indoor'
        "locationDescription": p.get("location_description"),
        "physicalType": p.get("physical_type"),
        "functions": fns,
        "supportsCollect": "parcel_collect" in fns,
        "supportsSend": "parcel_send" in fns,
        "supportsReturn": "parcel_reverse_return_send" in fns,
        "easyAccess": bool(p.get("easy_access_zone")),
        "imageUrl": p.get("image_url"),
        "lockerAvailability": (p.get("locker_availability") or {}).get("status"),
    }


def main() -> None:
    print(f"Fetching InPost UK points (per_page={PER_PAGE})…")
    started = time.time()

    page = 1
    total_pages = None
    operating: list[dict] = []
    skipped_status: dict[str, int] = {}
    raw_total = 0

    while True:
        d = fetch_page(page)
        items = d.get("items") or []
        raw_total += len(items)
        if total_pages is None:
            total_pages = d.get("total_pages") or 1
            print(f"  reported total: {d.get('count')} across {total_pages} pages")
        for p in items:
            status = p.get("status")
            if status != "Operating":
                skipped_status[status] = skipped_status.get(status, 0) + 1
                continue
            g = p.get("location") or {}
            if g.get("latitude") is None or g.get("longitude") is None:
                continue
            operating.append(normalize(p))
        print(f"  page {page}/{total_pages}: +{len(items)} raw, "
              f"running operating={len(operating)}")
        if page >= total_pages:
            break
        page += 1

    by_type: dict[str, int] = {}
    for r in operating:
        by_type[r["type"] or "unknown"] = by_type.get(r["type"] or "unknown", 0) + 1

    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": ENDPOINT,
        "filter": "status == Operating",
        "rawCount": raw_total,
        "skippedByStatus": skipped_status,
        "count": len(operating),
        "countByType": by_type,
        "lockers": operating,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    elapsed = time.time() - started
    print(f"Wrote {OUT_PATH}: {len(operating)} operating points "
          f"(of {raw_total} raw; skipped {skipped_status}) in {elapsed:.1f}s")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
