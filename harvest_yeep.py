#!/usr/bin/env python3
"""Harvest the Yeep UK locker network.

Yeep's locker map at https://yeeplockers.com/lockers/ is built on the
WordPress wp-google-maps plugin, which exposes every marker via an
unauthenticated REST endpoint. One GET, ~2 MB, and we have the full
network — all 2,500+ UK sites on map_id=2.

Output: yeep_lockers.json
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ENDPOINT = "https://yeeplockers.com/wp-json/wpgmza/v1/markers"
# Yeep uses map_id=1 for a single placeholder demo marker (California);
# the real UK locker dataset is on map_id=2.
UK_MAP_ID = "2"

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "yeep_lockers.json")

HEADERS = {
    "Accept": "application/json",
    "User-Agent": "amzn-locker-map/harvest_yeep.py",
}


def fetch_raw() -> list[dict]:
    req = urllib.request.Request(ENDPOINT, headers=HEADERS)
    last: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep(1.0 * (attempt + 1))
    raise RuntimeError(f"Yeep fetch failed: {last!r}")


def parse_carriers(raw: str | None) -> list[str]:
    """Carriers come back as comma-separated free text with a trailing dot,
    e.g. 'DPD.' or 'DPD, UPS.'. Strip and split."""
    if not raw:
        return []
    return [t.strip().rstrip(".").strip() for t in raw.replace(".", ",").split(",")
            if t.strip().rstrip(".").strip()]


# Postcode is at the end of the address string. Pull it out for the panel.
_POSTCODE_RE = re.compile(
    r"\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\s*$", re.I)


def extract_postcode(address: str | None) -> str | None:
    if not address:
        return None
    # Some Yeep addresses end with zero-width / non-breaking whitespace —
    # strip everything that isn't visible before matching the postcode.
    cleaned = re.sub(r"[\s ​‌‍﻿]+$", "", address)
    m = _POSTCODE_RE.search(cleaned)
    return m.group(1).upper() if m else None


def normalize(r: dict) -> dict | None:
    if r.get("map_id") != UK_MAP_ID and str(r.get("map_id")) != UK_MAP_ID:
        return None
    try:
        lat = float(r["lat"])
        lng = float(r["lng"])
    except (TypeError, ValueError, KeyError):
        return None
    # Sanity-clip to UK bbox; Yeep does have some test/demo points outside.
    if not (49 <= lat <= 61.5 and -9 <= lng <= 2.5):
        return None
    custom = {f.get("name"): f.get("value") for f in (r.get("custom_field_data") or [])}
    title = (r.get("title") or "").strip()
    address = (r.get("address") or "").strip()
    return {
        "id": str(r.get("id")),
        "title": title,
        "name": title.removeprefix("YEEP! ").strip() or title,
        "address": address,
        "postcode": extract_postcode(address),
        "location": {"latitude": lat, "longitude": lng},
        "carriers": parse_carriers(custom.get("Carriers")),
        "what3words": (custom.get("What3Words") or "").strip() or None,
        "what3wordsUrl": (r.get("link") or "").strip() or None,
    }


def main() -> None:
    print("Fetching Yeep UK locker network…")
    rows = fetch_raw()
    print(f"  {len(rows)} raw markers across all map_ids")

    out: list[dict] = []
    seen: set[str] = set()
    skipped_outside_uk = skipped_no_coords = 0
    for r in rows:
        rec = normalize(r)
        if not rec:
            mid = str(r.get("map_id"))
            if mid != UK_MAP_ID:
                skipped_outside_uk += 1
            else:
                skipped_no_coords += 1
            continue
        if rec["id"] in seen:
            continue
        seen.add(rec["id"])
        out.append(rec)

    out.sort(key=lambda r: (r.get("postcode") or "", r["title"]))

    by_carrier: dict[str, int] = {}
    for r in out:
        for c in r["carriers"]:
            by_carrier[c] = by_carrier.get(c, 0) + 1

    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": ENDPOINT,
        "filter": f"map_id == {UK_MAP_ID}",
        "count": len(out),
        "skippedOutsideUkMap": skipped_outside_uk,
        "skippedNoCoords": skipped_no_coords,
        "countByCarrier": dict(sorted(by_carrier.items(), key=lambda kv: -kv[1])),
        "lockers": out,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Wrote {OUT_PATH}: {len(out)} lockers")
    print(f"  carriers: {payload['countByCarrier']}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
