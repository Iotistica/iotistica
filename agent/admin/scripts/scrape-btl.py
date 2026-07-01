#!/usr/bin/env python3
"""
Scrapes the BACnet International BTL (BACnet Testing Laboratories) product database
and outputs bacnet-vendors.json to agent/admin/public/.

Usage:
    pip install playwright
    playwright install chromium
    python scrape-btl.py [--output path/to/bacnet-vendors.json]

Runs headless — suitable for CI.
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import date
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
except ImportError:
    print("ERROR: playwright not installed. Run: pip install playwright && playwright install chromium", file=sys.stderr)
    sys.exit(1)

BTL_URL = "https://www.bacnetinternational.net/btl/?s=product_listing&filter_product_listing=1"

PROFILE_LABELS = {
    "B-AWS":   "Workstation",
    "B-OWS":   "Operator Workstation",
    "B-OD":    "Operator Display",
    "B-LOD":   "Lightweight Operator Display",
    "B-BC":    "Building Controller",
    "B-AAC":   "Advanced Application Controller",
    "B-ASC":   "Application Specific Controller",
    "B-LSC":   "Lighting Application Specific Controller",
    "B-SS":    "Smart Sensor",
    "B-SA":    "Smart Actuator",
    "B-RTR":   "Router",
    "B-GW":    "Gateway",
    "B-BBMD":  "BBMD",
    "B-LD":    "Lighting Director",
    "B-GEN":   "Generic",
    "B-SCHUB": "SC Hub",
}


def scrape(headless: bool = True) -> dict:
    vendors: dict[str, list[dict]] = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_page()

        print(f"Loading BTL database: {BTL_URL}")
        page.goto(BTL_URL, timeout=60_000, wait_until="domcontentloaded")

        # Wait for the manufacturer select to be populated
        try:
            page.wait_for_selector("select[name='listing_manufacturer'] option:nth-child(2)", timeout=20_000)
        except PlaywrightTimeout:
            print("WARNING: Manufacturer dropdown did not populate — page may have changed structure", file=sys.stderr)

        # Collect manufacturer names from the dropdown
        manufacturers: list[str] = page.evaluate("""
            () => {
                const sel = document.querySelector("select[name='listing_manufacturer']");
                if (!sel) return [];
                return Array.from(sel.options)
                    .map(o => o.value.trim())
                    .filter(v => v && v !== '');
            }
        """)

        if not manufacturers:
            print("WARNING: No manufacturers found in dropdown — falling back to scraping all products at once", file=sys.stderr)
            manufacturers = [""]  # empty = no filter → all products

        print(f"Found {len(manufacturers)} manufacturers in BTL dropdown")

        for i, mfr in enumerate(manufacturers, 1):
            url = BTL_URL
            if mfr:
                url += f"&listing_manufacturer={mfr.replace(' ', '+')}"

            print(f"  [{i}/{len(manufacturers)}] {mfr or '(all)'}", end="", flush=True)

            try:
                page.goto(url, timeout=30_000, wait_until="domcontentloaded")
                # Small wait for any JS rendering
                page.wait_for_timeout(1500)

                # Try to extract product rows from common table/list structures
                products = page.evaluate("""
                    () => {
                        const results = [];

                        // Strategy 1: look for table rows with product data
                        const tables = document.querySelectorAll('table');
                        for (const table of tables) {
                            const rows = table.querySelectorAll('tr');
                            for (const row of rows) {
                                const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.innerText.trim());
                                if (cells.length >= 2 && cells[0] && !cells[0].match(/^(product|name|model|manufacturer|vendor|type)$/i)) {
                                    results.push({ cells });
                                }
                            }
                        }

                        // Strategy 2: look for divs/list items with BTL product classes
                        const items = document.querySelectorAll(
                            '.product-listing-item, .btl-product, .listing-item, ' +
                            '[class*="product-row"], [class*="listing-row"], ' +
                            '.views-row, .view-row'
                        );
                        for (const item of items) {
                            const text = item.innerText.trim();
                            if (text) results.push({ item: text });
                        }

                        // Strategy 3: look for h2/h3/h4 inside content area (some WP themes render this way)
                        const headings = document.querySelectorAll('.entry-content h2, .entry-content h3, main h3, #content h3');
                        for (const h of headings) {
                            results.push({ heading: h.innerText.trim() });
                        }

                        // Strategy 4: look for any element with data attributes
                        const dataEls = document.querySelectorAll('[data-product], [data-model], [data-vendor]');
                        for (const el of dataEls) {
                            results.push({
                                dataProduct: el.dataset.product,
                                dataModel: el.dataset.model,
                                dataVendor: el.dataset.vendor,
                                text: el.innerText.trim(),
                            });
                        }

                        return results;
                    }
                """)

                if products:
                    print(f" → {len(products)} rows")
                    for p_item in products:
                        _parse_product(p_item, mfr, vendors)
                else:
                    # Last resort: extract all visible text from main content and look for product patterns
                    content = page.inner_text("body")
                    _parse_text_fallback(content, mfr, vendors)
                    print(f" → text fallback")

            except PlaywrightTimeout:
                print(f" → TIMEOUT (skipped)")
            except Exception as e:
                print(f" → ERROR: {e}")

            # Be polite
            time.sleep(0.3)

        browser.close()

    return _build_output(vendors)


def _parse_product(item: dict, mfr: str, vendors: dict) -> None:
    vendor_key = mfr or "Unknown"

    if "cells" in item:
        cells = item["cells"]
        if len(cells) >= 1:
            name = cells[0]
            profile = cells[1] if len(cells) > 1 else ""
            profile = profile.strip().upper()
            if name and len(name) > 2:
                _add_product(vendors, vendor_key, name, profile)

    elif "item" in item:
        text = item["item"]
        lines = [l.strip() for l in text.split("\n") if l.strip()]
        if lines:
            name = lines[0]
            profile = ""
            for line in lines[1:]:
                m = re.search(r'\b(B-[A-Z]+)\b', line)
                if m:
                    profile = m.group(1)
                    break
            _add_product(vendors, vendor_key, name, profile)

    elif "heading" in item:
        name = item["heading"]
        if name and len(name) > 2:
            _add_product(vendors, vendor_key, name, "")

    elif item.get("dataProduct") or item.get("dataModel"):
        name = item.get("dataModel") or item.get("dataProduct") or item.get("text", "")
        _add_product(vendors, vendor_key, name, "")


def _parse_text_fallback(content: str, mfr: str, vendors: dict) -> None:
    vendor_key = mfr or "Unknown"
    # Look for BTL profile codes next to product names
    for line in content.split("\n"):
        line = line.strip()
        if not line or len(line) < 5 or len(line) > 200:
            continue
        m = re.search(r'\b(B-[A-Z]+)\b', line)
        if m:
            profile = m.group(1)
            name = line[:m.start()].strip(" -|·")
            if name and len(name) > 3:
                _add_product(vendors, vendor_key, name, profile)


def _add_product(vendors: dict, vendor: str, name: str, profile: str) -> None:
    if not name or len(name) < 3:
        return
    vendor = vendor.strip()
    if vendor not in vendors:
        vendors[vendor] = []
    entry = {"name": name}
    if profile and profile in PROFILE_LABELS:
        entry["type"] = profile
        entry["typeLabel"] = PROFILE_LABELS[profile]
    elif profile:
        entry["type"] = profile
    # Deduplicate by name
    if not any(p["name"] == name for p in vendors[vendor]):
        vendors[vendor].append(entry)


def _build_output(vendors: dict) -> dict:
    vendor_list = []
    for name, models in sorted(vendors.items()):
        if name and name != "Unknown" and models:
            vendor_list.append({"name": name, "models": sorted(models, key=lambda m: m["name"])})

    return {
        "updated": str(date.today()),
        "source": "BACnet International BTL Database",
        "url": "https://www.bacnetinternational.net/btl/",
        "vendors": vendor_list,
    }


def main():
    parser = argparse.ArgumentParser(description="Scrape BTL BACnet vendor/product database")
    parser.add_argument("--output", default=None, help="Output JSON path (default: auto-detect)")
    parser.add_argument("--no-headless", action="store_true", help="Show browser window")
    args = parser.parse_args()

    if args.output:
        out_path = Path(args.output)
    else:
        script_dir = Path(__file__).parent
        out_path = script_dir.parent / "public" / "bacnet-vendors.json"

    print(f"Output: {out_path}")
    data = scrape(headless=not args.no_headless)

    vendor_count = len(data["vendors"])
    product_count = sum(len(v["models"]) for v in data["vendors"])
    print(f"\nScraped {vendor_count} vendors, {product_count} products")

    if vendor_count == 0:
        print("WARNING: No vendors scraped — BTL page structure may have changed.", file=sys.stderr)
        print("The existing bacnet-vendors.json (seed data) will be preserved.", file=sys.stderr)
        sys.exit(1)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"Written: {out_path}")


if __name__ == "__main__":
    main()
