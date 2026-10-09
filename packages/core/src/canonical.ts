/**
 * @file canonical.ts
 * Deterministic JSON stringifier with recursively sorted keys.
 * Ensures identical cryptographic hashes across devices and runtimes.
 */

export function canonicalJsonStringify(val: unknown): string {
  if (val && typeof (val as any).toJSON === "function") {
    val = (val as any).toJSON();
  }
  if (val === null || typeof val !== "object") {
    const s = JSON.stringify(val);
    if (s === undefined) throw new TypeError("non-serializable value");
    return s;
  }
  if (Array.isArray(val)) {
    return "[" + val.map((v) => canonicalJsonStringify(v === undefined ? null : v)).join(",") + "]";
  }
  const o = val as Record<string, unknown>;
  const sortedKeys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" + sortedKeys.map((k) => JSON.stringify(k) + ":" + canonicalJsonStringify(o[k])).join(",") + "}";
}
