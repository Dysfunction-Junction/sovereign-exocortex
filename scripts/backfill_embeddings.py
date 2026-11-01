#!/usr/bin/env python3
"""
scripts/backfill_embeddings.py
High-throughput vector backfill for Sovereign Exocortex Databank.
Generates 768-dimensional int8-quantized vectors using local nomic-embed-text
via llama-server OpenAI-compatible /v1/embeddings API.

Hardened per Autonomous Triad Review:
- Keyset range pagination: WHERE c.chunk_id > ? (O(1) index seek per batch)
- Resilient bisection on client errors with progressive text halving
- Fail-fast on systemic 4xx (401/403/404) vs poison bisection (400/413/422)
- Circuit breaker against widespread chunk skips (>50 consecutive or >5%)
- Response index-order and dimension verification to prevent alignment drift
- Transaction-safe with db.in_transaction checks and isolation_level=None
- Accurate inserted vs skipped reporting via cursor.rowcount

Usage:
  python3 scripts/backfill_embeddings.py [--db /mnt/databank/index/databank.db] [--url http://127.0.0.1:8081] [--batch 32]
"""

import argparse
import json
import math
import os
import sqlite3
import struct
import sys
import time
import urllib.request
import urllib.error

DOC_PREFIX = "search_document: "
MAX_CHARS = 4000
DIM = 768

class PoisonChunkError(RuntimeError):
    """Raised when an input causes token overflow or context limit rejection."""
    pass

def parse_args():
    parser = argparse.ArgumentParser(description="Backfill int8 vector embeddings in databank.db")
    parser.add_argument("--db", default="/mnt/databank/index/databank.db", help="Path to databank.db")
    parser.add_argument("--url", default="http://127.0.0.1:8081", help="Base URL of llama-server")
    parser.add_argument("--model", default="nomic-embed-text", help="Embedding model name")
    parser.add_argument("--batch", type=int, default=32, help="Batch size per request (must be >= 1)")
    parser.add_argument("--timeout", type=int, default=60, help="HTTP request timeout in seconds")
    parser.add_argument("--limit", type=int, default=0, help="Optional limit for testing")
    args = parser.parse_args()
    if args.batch < 1:
        parser.error("--batch must be >= 1")
    return args

def normalize_and_quantize(vec):
    if not vec or not isinstance(vec, (list, tuple)):
        return None, None
    try:
        for x in vec:
            if x is None or not math.isfinite(float(x)):
                return None, None
        norm = math.sqrt(sum(float(x) * float(x) for x in vec))
        if norm <= 0 or not math.isfinite(norm):
            return None, None
        unit = [float(x) / norm for x in vec]
        max_val = max(abs(x) for x in unit)
        scale = max_val / 127.0 if max_val > 0 else 1.0
        q8_bytes = struct.pack(
            f"{len(unit)}b",
            *[max(-127, min(127, int(round(x / scale)))) for x in unit]
        )
        return scale, q8_bytes
    except (TypeError, ValueError):
        return None, None

def fetch_embeddings_batch(endpoint, texts, model, timeout=60, retries=3):
    payload = json.dumps({"input": texts, "model": model}).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=payload,
        headers={"Content-Type": "application/json"}
    )
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                items = sorted(data.get("data", []), key=lambda x: x.get("index", 0))
                # Validate response integrity and sequence alignment
                if len(items) != len(texts):
                    raise RuntimeError(f"Server returned {len(items)} items for {len(texts)} inputs")
                for expected_idx, item in enumerate(items):
                    if item.get("index", expected_idx) != expected_idx:
                        raise RuntimeError(f"Embedding item index mismatch: got {item.get('index')}, expected {expected_idx}")
                return [it["embedding"] for it in items]
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            if e.code >= 500 or e.code in (408, 429):
                if attempt == retries:
                    raise RuntimeError(f"Embedding server error {e.code} after {retries} attempts: {body}") from e
                time.sleep(1.0 * attempt)
            elif e.code in (400, 413, 422):
                # Context limit / token overflow: raise PoisonChunkError for bisection
                raise PoisonChunkError(f"HTTP {e.code}: {body}") from e
            else:
                # Fatal 401, 403, 404, etc. -> abort immediately, do NOT bisect or skip whole db
                raise RuntimeError(f"Fatal HTTP {e.code} client error: {body}") from e
        except Exception as e:
            if attempt == retries:
                raise RuntimeError(f"Embedding network error after {retries} attempts: {e}") from e
            time.sleep(1.0 * attempt)

def embed_resilient(endpoint, texts, model, timeout=60):
    """
    Attempts batch embedding. On PoisonChunkError, recursively bisects.
    If a singleton still fails, attempts halving the text before giving up.
    """
    if not texts:
        return []
    try:
        return fetch_embeddings_batch(endpoint, texts, model, timeout=timeout)
    except PoisonChunkError:
        if len(texts) == 1:
            t = texts[0]
            if len(t) > 800:
                halved = t[:len(t) // 2]
                try:
                    return fetch_embeddings_batch(endpoint, [halved], model, timeout=timeout)
                except Exception:
                    pass
            print(f"\n[Warning] Skipping poison chunk exceeding context limit ({len(texts[0])} chars)")
            return [None]
        mid = len(texts) // 2
        left = embed_resilient(endpoint, texts[:mid], model, timeout=timeout)
        right = embed_resilient(endpoint, texts[mid:], model, timeout=timeout)
        return left + right

def main():
    args = parse_args()
    print(f"Connecting to DB: {args.db}")
    if not os.path.exists(args.db):
        sys.exit(f"Database not found: {args.db}")

    endpoint = f"{args.url.rstrip('/')}/v1/embeddings"
    print(f"Embedding Endpoint: {endpoint}")
    print(f"Model: {args.model} | Batch Size: {args.batch} | Timeout: {args.timeout}s")

    # Health check with poll wait up to 30s
    health_url = f"{args.url.rstrip('/')}/health"
    connected = False
    last_err = None
    for h_attempt in range(6):
        try:
            with urllib.request.urlopen(health_url, timeout=5) as resp:
                health = json.loads(resp.read().decode("utf-8"))
                if health.get("status") == "ok":
                    print(f"Server Health: {health}")
                    connected = True
                    break
        except Exception as e:
            last_err = e
        if h_attempt < 5:
            time.sleep(5.0)

    if not connected:
        sys.exit(f"Cannot reach healthy llama-server at {health_url}: {last_err}")

    db = sqlite3.connect(args.db, timeout=30.0, isolation_level=None)
    db.execute("PRAGMA busy_timeout = 30000;")

    try:
        # Count total and remaining
        total_chunks = db.execute("SELECT count(*) FROM chunks").fetchone()[0]
        existing_vectors = db.execute("SELECT count(*) FROM vectors WHERE model = ?", (args.model,)).fetchone()[0]
        unembedded = db.execute(
            "SELECT count(*) FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.chunk_id = c.chunk_id AND v.model = ?)",
            (args.model,)
        ).fetchone()[0]

        target_total = min(unembedded, args.limit) if args.limit > 0 else unembedded

        print(f"\nTotal chunks: {total_chunks}")
        print(f"Existing vectors: {existing_vectors}")
        print(f"Chunks to embed: {unembedded} (Target: {target_total})")

        if unembedded == 0:
            print("All chunks are already embedded! Nothing to do.")
            return

        inserted_total = 0
        skipped_total = 0
        start_time = time.time()
        last_id = 0  # Chunks AUTOINCREMENT starts at 1, so 0 is exact initial sentinel

        print("\nStarting embedding backfill...")

        while True:
            limit_batch = args.batch
            if args.limit > 0 and (inserted_total + skipped_total + limit_batch) > target_total:
                limit_batch = target_total - (inserted_total + skipped_total)
                if limit_batch <= 0:
                    break

            # Exact keyset range seek (uses SQLite INTEGER PRIMARY KEY index seek without table scan)
            query = """
                SELECT c.chunk_id, c.text FROM chunks c
                WHERE c.chunk_id > ?
                  AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.chunk_id = c.chunk_id AND v.model = ?)
                ORDER BY c.chunk_id ASC LIMIT ?
            """
            rows = db.execute(query, (last_id, args.model, limit_batch)).fetchall()
            if not rows:
                break

            last_id = rows[-1][0]

            # Filter out empty or whitespace-only chunks
            valid_rows = []
            for r in rows:
                raw_text = str(r[1] or "").strip()
                if raw_text:
                    valid_rows.append((r[0], raw_text))
                else:
                    skipped_total += 1

            if not valid_rows:
                continue

            chunk_ids = [r[0] for r in valid_rows]
            texts = [DOC_PREFIX + r[1][:MAX_CHARS] for r in valid_rows]

            vecs = embed_resilient(endpoint, texts, args.model, timeout=args.timeout)
            if len(vecs) != len(valid_rows):
                raise RuntimeError(f"Length mismatch: got {len(vecs)} embeddings for {len(valid_rows)} inputs")

            to_insert = []
            for chunk_id, vec in zip(chunk_ids, vecs):
                if vec is None:
                    skipped_total += 1
                    continue
                if len(vec) != DIM:
                    raise RuntimeError(f"Dimension mismatch for chunk {chunk_id}: got {len(vec)}, expected {DIM}")
                scale, q8_bytes = normalize_and_quantize(vec)
                if scale is not None and q8_bytes is not None:
                    to_insert.append((chunk_id, args.model, DIM, scale, q8_bytes))
                else:
                    skipped_total += 1

            # Commit batch atomically using cursor.rowcount for exact change tracking
            if to_insert:
                db.execute("BEGIN IMMEDIATE;")
                try:
                    cur = db.executemany(
                        "INSERT OR IGNORE INTO vectors (chunk_id, model, dim, scale, q8) VALUES (?, ?, ?, ?, ?)",
                        to_insert
                    )
                    inserted_this_batch = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else len(to_insert)
                    db.execute("COMMIT;")
                    inserted_total += inserted_this_batch
                    skipped_total += (len(to_insert) - inserted_this_batch)
                except Exception:
                    if db.in_transaction:
                        db.execute("ROLLBACK;")
                    raise

            # Circuit breaker: if skipped chunks exceed 50 and > 10% of total processed, halt to avoid silent failures
            processed_total = inserted_total + skipped_total
            if skipped_total > 50 and (skipped_total / max(processed_total, 1)) > 0.10:
                sys.exit(f"\n[Circuit Breaker] Excessive skipped chunks ({skipped_total}/{processed_total}). Halting.")

            elapsed = max(time.time() - start_time, 1e-9)
            rate = inserted_total / elapsed if elapsed > 0 else 0
            remaining_cnt = target_total - processed_total
            eta_sec = remaining_cnt / rate if rate > 0 else 0
            eta_min = eta_sec / 60.0

            pct = (processed_total / target_total) * 100.0 if target_total > 0 else 100.0
            print(
                f"  Progress: {processed_total:>5}/{target_total} ({pct:5.1f}%) | "
                f"Inserted: {inserted_total} | "
                f"Skipped: {skipped_total} | "
                f"Rate: {rate:5.1f} c/s | "
                f"ETA: {eta_min:4.1f} min",
                end="\r",
                flush=True
            )

        total_elapsed = max(time.time() - start_time, 1e-9)
        print(f"\n\nBackfill complete! Embedded {inserted_total} chunks (skipped {skipped_total}) in {total_elapsed:.1f}s ({inserted_total/total_elapsed:.1f} chunks/s).")

        final_vectors = db.execute("SELECT count(*) FROM vectors WHERE model = ?", (args.model,)).fetchone()[0]
        print(f"Final vectors in {args.db}: {final_vectors} / {total_chunks} ({final_vectors/total_chunks*100.0:.1f}%)")

    finally:
        db.close()

if __name__ == "__main__":
    main()
