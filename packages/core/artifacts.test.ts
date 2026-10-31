import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { ExocortexDatabase } from "./db.js";

describe("artifacts table", () => {
  let db: ExocortexDatabase;

  beforeEach(() => {
    db = new ExocortexDatabase({ path: ":memory:" });
    db.registerDevice({
      device_id: "host:exocortexd",
      name: "host",
      platform: "windows",
      pubkey_spki: new Uint8Array([1]),
      key_attested: 0,
      scopes: ["admin:write"],
      enrolled_at: 1,
      revoked_at: null,
    });
  });

  afterEach(() => db.close());

  const importEvent = (sha: string) =>
    db.ingestEvent("host:exocortexd", {
      event_id: `curation:${sha}`,
      kind: "curation_import",
      ts_device: 1_700_000_000_000,
      schema_ver: 1,
      payload: { artifact_sha256: sha, media_type: "application/vnd.exocortex.vocabulary+json", count: 2 },
    });

  it("stores canonical JSON keyed by its SHA-256, independent of key order", () => {
    const a = db.putArtifact("application/json", { b: 1, a: [2, { d: 3, c: 4 }] });
    const b = db.putArtifact("application/json", { a: [2, { c: 4, d: 3 }], b: 1 });
    expect(a.sha256).toBe(b.sha256);
    const bytes = Buffer.from('{"a":[2,{"c":4,"d":3}],"b":1}', "utf8");
    expect(a.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(db.getArtifact(a.sha256)?.bytes.equals(bytes)).toBe(true);
    expect(db.getArtifact("0".repeat(64))).toBeNull();
  });

  it("is insert-only", () => {
    const { sha256 } = db.putArtifact("application/json", { x: 1 });
    expect(() => db.raw.prepare("UPDATE artifacts SET media_type = 'x'").run()).toThrow(/insert-only/);
    expect(() => db.raw.prepare("DELETE FROM artifacts").run()).toThrow(/insert-only/);
    expect(db.getArtifact(sha256)).not.toBeNull();
  });

  it("passes the curation check when every referenced artifact exists", () => {
    const { sha256 } = db.putArtifact("application/json", { topics: ["a", "b"] });
    importEvent(sha256);
    expect(db.verifyCurationArtifacts()).toEqual({ ok: true, checked: 1, missing: [], altered: [] });
  });

  it("ignores curation imports from other devices, which are never projected", () => {
    db.registerDevice({
      device_id: "phone",
      name: "phone",
      platform: "android",
      pubkey_spki: new Uint8Array([1]),
      key_attested: 0,
      scopes: ["telemetry:write"],
      enrolled_at: 1,
      revoked_at: null,
    });
    db.ingestEvent("phone", {
      event_id: "curation:forged",
      kind: "curation_import",
      ts_device: 1,
      schema_ver: 1,
      payload: { artifact_sha256: "ef".repeat(32) },
    });
    expect(db.verifyCurationArtifacts()).toEqual({ ok: true, checked: 0, missing: [], altered: [] });
  });

  it("names a missing artifact", () => {
    const sha = "ab".repeat(32);
    importEvent(sha);
    expect(db.verifyCurationArtifacts()).toMatchObject({ ok: false, missing: [sha], altered: [] });
  });

  it("names an artifact whose bytes no longer match its hash", () => {
    const { sha256 } = db.putArtifact("application/json", { topics: ["a"] });
    importEvent(sha256);
    db.raw.exec("DROP TRIGGER artifacts_no_update");
    db.raw.prepare("UPDATE artifacts SET bytes = ?").run(Buffer.from('{"topics":["evil"]}'));
    expect(() => db.getArtifact(sha256)).toThrow(/does not match/);
    expect(db.verifyCurationArtifacts()).toMatchObject({ ok: false, missing: [], altered: [sha256] });
  });
});
