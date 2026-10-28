// In-memory token bucket, one bucket per key. Not persisted: a restart refills every bucket.

export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one token for `key`; false means the caller is over the limit. */
  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + (t - b.at) * this.refillPerMs);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.prune(t);
    return ok;
  }

  private prune(t: number): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.at) * this.refillPerMs >= this.capacity) this.buckets.delete(k);
    }
  }
}

/** 30 per minute per device. */
export const classifyBucket = new TokenBucket(30, 30 / 60_000);
