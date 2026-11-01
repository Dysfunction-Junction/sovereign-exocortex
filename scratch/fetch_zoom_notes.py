#!/usr/bin/env python3
"""Hermetic fetcher for clinical Zoom notes.
Strict privacy: Prints ONLY byte counts and status; NEVER prints clinical text.
"""
import os, sys
from playwright.sync_api import sync_playwright

URL = "https://mynotes.zoom.us/5L037ZYkTPCKcwY4R490OA"
OUT_DIR = os.path.join(os.path.dirname(__file__), "clinical_staging")
os.makedirs(OUT_DIR, exist_ok=True)

HTML_OUT = os.path.join(OUT_DIR, "zoom_note_raw.html")
TXT_OUT = os.path.join(OUT_DIR, "zoom_note.txt")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(URL, wait_until="networkidle", timeout=30000)
    
    # Give any dynamic SPA rendering a few seconds
    page.wait_for_timeout(5000)
    
    final_url = page.url
    html_content = page.content()
    
    # Save raw HTML
    with open(HTML_OUT, "w", encoding="utf-8") as f:
        f.write(html_content)
        
    # Extract inner text of body
    body_text = page.inner_text("body")
    with open(TXT_OUT, "w", encoding="utf-8") as f:
        f.write(body_text)
        
    browser.close()

# Only report metadata
is_login = "signin" in final_url.lower() or "login" in final_url.lower()
print(f"Fetch completed.")
print(f"Final URL domain: {final_url.split('/')[2] if '/' in final_url else final_url}")
print(f"Login redirect: {is_login}")
print(f"HTML size: {os.path.getsize(HTML_OUT)} bytes")
print(f"Text size: {os.path.getsize(TXT_OUT)} bytes")
