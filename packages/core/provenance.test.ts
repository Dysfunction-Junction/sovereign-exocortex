import { describe, it, expect } from "vitest";
import { consumerAccepts, provenanceOf, redactPayload, type Provenance } from "./provenance.js";

const phone = "901bc8d0-e01f-48f0-b5f8-f47119e713e6";
const host = "host:exocortexd";

describe("provenanceOf", () => {
  // One row per (kind, source/origin, device) combination found in the live ledger on 2026-10-31.
  it.each([
    ["channel_ingest", host, { channel: "obsidian" }, "observed", true],
    ["label", phone, { source: "inferred" }, "system_emitted", false],
    ["label", phone, { source: "tap" }, "user_label", false],
    ["label", "pc:dashboard", { source: "inferred" }, "system_emitted", false],
    ["label", host, { source: "inferred" }, "system_emitted", false],
    ["observation", phone, {}, "observed", false],
    ["observation", host, { source: "repo_health_watcher" }, "observed", false],
    ["observation", "pc:dashboard", {}, "observed", false],
    ["past", "comms-backfill", { origin: "comms-backfill" }, "observed", false],
    ["past", "pieces-backfill", { origin: "pieces-backfill" }, "observed", false],
    ["proposal", host, {}, "system_emitted", false],
    ["query", phone, { query: "q", result: "r" }, "observed", false],
    ["telemetry", phone, {}, "observed", false],
    ["touch", phone, {}, "observed", false],
    ["touch", "pc:dashboard", { origin: "diag" }, "observed", false],
    ["vision_observation", host, { source: "local_vision" }, "derived", false],
  ] as const)("classifies %s from %s", (kind, device_id, payload, cls, untrusted) => {
    const p = provenanceOf({ kind, device_id, payload: JSON.stringify(payload) });
    expect(p.class).toBe(cls);
    expect(p.untrusted).toBe(untrusted);
  });

  it("marks backfilled history as imported", () => {
    expect(provenanceOf({ kind: "past", device_id: "comms-backfill", payload: { origin: "comms-backfill" } }).imported).toBe(true);
  });

  it("leaves unknown kinds and unknown past origins unclassified", () => {
    expect(provenanceOf({ kind: "brand_new_kind", device_id: phone, payload: {} }).class).toBe("unclassified");
    expect(provenanceOf({ kind: "past", device_id: "x", payload: { origin: "elsewhere" } }).class).toBe("unclassified");
  });

  it("treats an unparsable payload as empty rather than throwing", () => {
    expect(provenanceOf({ kind: "label", device_id: phone, payload: "{not json" }).class).toBe("system_emitted");
  });

  it("only attests a tap label when the caller verified it", () => {
    const payload = { source: "tap" };
    expect(provenanceOf({ kind: "label", device_id: phone, payload }).attested).toBe(false);
    expect(provenanceOf({ kind: "label", device_id: phone, payload }, { labelAttestation: "tap" }).attested).toBe(true);
  });

  it("trusts only the daemon's exact device id, not any host: prefix", () => {
    const vocab = { artifact_sha256: "a".repeat(64) };
    expect(provenanceOf({ kind: "curation_import", device_id: "host:evil", payload: vocab }).class).toBe("unclassified");
    expect(provenanceOf({ kind: "entity_merge", device_id: "host:exocortexd2", payload: {} }).class).toBe("unclassified");
  });

  it("accepts curation and human graph edits only from the host", () => {
    const vocab = { artifact_sha256: "a".repeat(64), media_type: "application/json", count: 1 };
    expect(provenanceOf({ kind: "curation_import", device_id: host, payload: vocab }).class).toBe("user_label");
    expect(provenanceOf({ kind: "curation_import", device_id: host, payload: { ...vocab, rule_source: "entity-rule" } }).class).toBe("derived");
    expect(provenanceOf({ kind: "curation_import", device_id: phone, payload: vocab }).class).toBe("unclassified");
    expect(provenanceOf({ kind: "entity_merge", device_id: host, payload: {} }).class).toBe("user_label");
    expect(provenanceOf({ kind: "assertion_retract", device_id: phone, payload: {} }).class).toBe("unclassified");
  });

  describe("derived_assertion", () => {
    const table: Record<string, Provenance> = {
      obs: provenanceOf({ kind: "telemetry", device_id: phone, payload: {} }),
      vault: provenanceOf({ kind: "channel_ingest", device_id: host, payload: {} }),
      prop: provenanceOf({ kind: "proposal", device_id: host, payload: {} }),
    };
    const derive = (ids: unknown) =>
      provenanceOf(
        { kind: "derived_assertion", device_id: host, payload: { input_event_ids: ids } },
        { resolveInput: (id) => table[id] },
      );

    it("is derived when every input is observed", () => {
      expect(derive(["obs"]).class).toBe("derived");
    });

    it("inherits the untrusted flag", () => {
      expect(derive(["obs", "vault"]).untrusted).toBe(true);
    });

    it("takes the worst input class", () => {
      expect(derive(["obs", "prop"]).class).toBe("system_emitted");
    });

    it("is unclassified without inputs or with an unresolvable input", () => {
      expect(derive([]).class).toBe("unclassified");
      expect(derive(["obs", "missing"]).class).toBe("unclassified");
      expect(provenanceOf({ kind: "derived_assertion", device_id: host, payload: { input_event_ids: ["obs"] } }).class).toBe("unclassified");
    });
  });
});

describe("consumer allowlists", () => {
  it("keep system-emitted and unclassified events out of the graph and the learner", () => {
    const prop = provenanceOf({ kind: "proposal", device_id: host, payload: {} });
    const unknown = provenanceOf({ kind: "mystery", device_id: host, payload: {} });
    for (const consumer of ["world-model-graph", "world-model-learner"] as const) {
      expect(consumerAccepts(consumer, prop)).toBe(false);
      expect(consumerAccepts(consumer, unknown)).toBe(false);
    }
    expect(consumerAccepts("world-model-graph", provenanceOf({ kind: "telemetry", device_id: phone, payload: {} }))).toBe(true);
  });

  it("reject a user_label whose attestation was not verified", () => {
    const forged = provenanceOf({ kind: "label", device_id: phone, payload: { source: "tap", tags: ["x"] } });
    const verified = provenanceOf({ kind: "label", device_id: phone, payload: { source: "tap" } }, { labelAttestation: "tap" });
    expect(consumerAccepts("world-model-graph", forged)).toBe(false);
    expect(consumerAccepts("world-model-graph", verified)).toBe(true);
  });
});

describe("redactPayload", () => {
  it("drops a query's result for both string and object payloads", () => {
    const p = provenanceOf({ kind: "query", device_id: phone, payload: {} });
    expect(JSON.parse(redactPayload(JSON.stringify({ query: "q", result: { tags: ["x"] } }), p))).toEqual({ query: "q" });
    expect(redactPayload({ query: "q", result: "r" }, p)).toEqual({ query: "q" });
  });

  it("returns the same payload when nothing is redacted", () => {
    const payload = JSON.stringify({ a: 1 });
    expect(redactPayload(payload, provenanceOf({ kind: "telemetry", device_id: phone, payload }))).toBe(payload);
  });
});
