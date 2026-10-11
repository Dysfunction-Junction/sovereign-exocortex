/**
 * @file vectors.ts
 * int8 vector quantisation and an in-memory brute-force index.
 * A unit vector is stored as Int8 with a per-vector scale (768 bytes + 4 for nomic-embed-text).
 */

export function normalize(v: number[]): Float32Array | null {
  let n = 0;
  for (const x of v) n += x * x;
  if (!(n > 0) || !Number.isFinite(n)) return null;
  const inv = 1 / Math.sqrt(n);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

export function quantize(unit: Float32Array): { q8: Buffer; scale: number } {
  let max = 0;
  for (const x of unit) max = Math.max(max, Math.abs(x));
  const scale = max > 0 ? max / 127 : 1;
  const q = new Int8Array(unit.length);
  for (let i = 0; i < unit.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(unit[i] / scale)));
  return { q8: Buffer.from(q.buffer, q.byteOffset, q.byteLength), scale };
}

export interface VectorRow {
  chunk_id: number;
  scale: number;
  q8: Uint8Array;
}

/** Contiguous Int8 store for one (model, dim). Rebuilt when the row count changes. */
export class VectorIndex {
  readonly ids: number[] = [];
  private scales: Float32Array;
  private data: Int8Array;

  constructor(readonly dim: number, rows: VectorRow[]) {
    this.scales = new Float32Array(rows.length);
    this.data = new Int8Array(rows.length * dim);
    let i = 0;
    for (const r of rows) {
      if (r.q8.byteLength !== dim) continue;
      this.ids.push(r.chunk_id);
      this.scales[i] = r.scale;
      this.data.set(new Int8Array(r.q8.buffer, r.q8.byteOffset, dim), i * dim);
      i++;
    }
  }

  get size(): number {
    return this.ids.length;
  }

  /** Top `k` chunk IDs by cosine to the unit query; `allowed` restricts the candidate set. */
  top(query: Float32Array, k: number, allowed?: Set<number>): Array<{ chunkId: number; cosine: number }> {
    if (query.length !== this.dim) return [];
    const best: Array<{ chunkId: number; cosine: number }> = [];
    let floor = -Infinity;
    for (let i = 0; i < this.ids.length; i++) {
      const id = this.ids[i];
      if (allowed && !allowed.has(id)) continue;
      let dot = 0;
      const base = i * this.dim;
      for (let j = 0; j < this.dim; j++) dot += this.data[base + j] * query[j];
      const cos = dot * this.scales[i];
      if (best.length < k || cos > floor) {
        best.push({ chunkId: id, cosine: cos });
        best.sort((a, b) => b.cosine - a.cosine);
        if (best.length > k) best.pop();
        floor = best.length === k ? best[best.length - 1].cosine : -Infinity;
      }
    }
    return best;
  }
}
