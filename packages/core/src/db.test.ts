import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ExocortexDatabase } from "./db.js";
import { canonicalJsonStringify } from "./canonical.js";
import type { DeviceRecord, EventIn } from "./schema-types.js";

describe("ExocortexDatabase (v3 SQLite Event Store Driver)", () => {
  let db: ExocortexDatabase;

  const mockDevice: DeviceRecord = {
    device_id: "dev_phone_galaxy",
    name: "Samsung Galaxy S26 Ultra",
    platform: "android",
    pubkey_spki: new Uint8Array([1, 2, 3, 4, 5]),
    key_attested: 1,
    scopes: ["telemetry:write", "approval:write"],
    enrolled_at: 1728000000,
    revoked_at: null,
  };

  beforeEach(() => {
    db = new ExocortexDatabase({ path: ":memory:" });
    db.registerDevice(mockDevice);
  });

  afterEach(() => {
    db.close();
  });

  it("registers and retrieves enrolled devices", () => {
    const fetched = db.getDevice("dev_phone_galaxy");
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe("Samsung Galaxy S26 Ultra");
    expect(fetched?.platform).toBe("android");
    expect(fetched?.scopes).toEqual(["telemetry:write", "approval:write"]);

    const list = db.listDevices();
    expect(list.length).toBe(1);
    expect(list[0].device_id).toBe("dev_phone_galaxy");
  });

  it("revokes devices and rejects subsequent event ingest", () => {
    db.revokeDevice("dev_phone_galaxy");
    const dev = db.getDevice("dev_phone_galaxy");
    expect(dev?.revoked_at).not.toBeNull();

    const eventIn: EventIn = {
      event_id: "evt_revoked",
      kind: "telemetry",
      ts_device: 1000,
      schema_ver: 1,
      payload: { app: "chrome" },
    };
    expect(() => {
      db.ingestEvent("dev_phone_galaxy", eventIn);
    }).toThrow(/Device has been revoked/);
  });


  it("ingests an initial event with zero prev_hash and valid hash", () => {
    const eventIn: EventIn = {
      event_id: "evt_001",
      kind: "telemetry",
      ts_device: 1000,
      schema_ver: 1,
      payload: { app: "com.android.chrome", duration: 50 },
    };

    const result = db.ingestEvent("dev_phone_galaxy", eventIn);
    expect(result.status).toBe("inserted");
    expect(result.event.seq).toBe(1);
    expect(result.event.event_id).toBe("evt_001");
    expect(result.event.prev_hash.length).toBe(32);
    // All 32 bytes should be 0 for the genesis event
    expect(Array.from(result.event.prev_hash).every((b) => b === 0)).toBe(true);
    expect(result.event.hash.length).toBe(32);
  });

  it("chains subsequent events cryptographically with prev_hash matching previous hash", () => {
    const evt1: EventIn = {
      event_id: "evt_101",
      kind: "telemetry",
      ts_device: 1000,
      schema_ver: 1,
      payload: { step: 1 },
    };
    const evt2: EventIn = {
      event_id: "evt_102",
      kind: "observation",
      ts_device: 1010,
      schema_ver: 1,
      payload: { step: 2 },
    };

    const res1 = db.ingestEvent("dev_phone_galaxy", evt1);
    const res2 = db.ingestEvent("dev_phone_galaxy", evt2);

    expect(res1.event.seq).toBe(1);
    expect(res2.event.seq).toBe(2);
    expect(Array.from(res2.event.prev_hash)).toEqual(Array.from(res1.event.hash));

    // Verify chain integrity
    const chainVerification = db.verifyEventChain();
    expect(chainVerification.valid).toBe(true);
    expect(chainVerification.totalEvents).toBe(2);
  });

  it("guarantees idempotency on duplicate event_id without duplicate insert", () => {
    const eventIn: EventIn = {
      event_id: "evt_idempotent",
      kind: "telemetry",
      ts_device: 2000,
      schema_ver: 1,
      payload: { unique_key: "abc" },
    };

    const first = db.ingestEvent("dev_phone_galaxy", eventIn);
    expect(first.status).toBe("inserted");

    const second = db.ingestEvent("dev_phone_galaxy", eventIn);
    expect(second.status).toBe("duplicate");
    expect(second.event.seq).toBe(first.event.seq);
    expect(second.event.event_id).toBe(first.event.event_id);

    const all = db.listEvents();
    expect(all.length).toBe(1);
  });

  it("ingests batch envelopes atomically", () => {
    const batch = {
      device_id: "dev_phone_galaxy",
      events: [
        {
          event_id: "batch_1",
          kind: "wake",
          ts_device: 3000,
          schema_ver: 1 as const,
          payload: { reason: "screen_on" },
        },
        {
          event_id: "batch_2",
          kind: "touch",
          ts_device: 3005,
          schema_ver: 1 as const,
          payload: { x: 100, y: 200 },
        },
      ],
    };

    const result = db.ingestBatch(batch);
    expect(result.insertedCount).toBe(2);
    expect(result.duplicateCount).toBe(0);
    expect(result.events.length).toBe(2);

    const verify = db.verifyEventChain();
    expect(verify.valid).toBe(true);
    expect(verify.totalEvents).toBe(2);
  });

  it("enforces strict append-only invariants: blocks UPDATE and DELETE via triggers", () => {
    const eventIn: EventIn = {
      event_id: "evt_immutable",
      kind: "telemetry",
      ts_device: 4000,
      schema_ver: 1,
      payload: { immutable: true },
    };
    db.ingestEvent("dev_phone_galaxy", eventIn);

    // Attempted UPDATE must be aborted by SQLite trigger
    expect(() => {
      db.raw.prepare("UPDATE events SET kind = 'hacked' WHERE seq = 1").run();
    }).toThrow(/events are append-only/);

    // Attempted DELETE must be aborted by SQLite trigger
    expect(() => {
      db.raw.prepare("DELETE FROM events WHERE seq = 1").run();
    }).toThrow(/events are append-only/);
  });

  it("records and updates proposals and gate decisions", () => {
    // Need an event first because created_seq has a foreign key to events(seq)
    const eventIn: EventIn = {
      event_id: "evt_for_prop",
      kind: "observation",
      ts_device: 5000,
      schema_ver: 1,
      payload: { invariant: "clean_suite" },
    };
    const ev = db.ingestEvent("dev_phone_galaxy", eventIn);

    db.insertProposal({
      proposal_id: "prop_v3_test",
      created_seq: ev.event.seq,
      invariant_id: null,
      policy_type: "PRAGMATIC",
      tier: 1,
      summary: "Run clean suite check",
      action: JSON.stringify({ cmd: "test" }),
      action_hash: new Uint8Array([10, 20, 30]),
      efe: 1.25,
      risk_term: 0.1,
      ambiguity_term: 0.05,
      state: "STAGED",
      shadow: 1,
      expires_at: Date.now() + 60000,
      updated_at: Date.now(),
    });

    const proposal = db.getProposal("prop_v3_test");
    expect(proposal).not.toBeNull();
    expect(proposal?.state).toBe("STAGED");
    expect(proposal?.shadow).toBe(1);

    db.updateProposalState("prop_v3_test", "APPROVED");
    const updated = db.getProposal("prop_v3_test");
    expect(updated?.state).toBe("APPROVED");

    db.recordGateDecision({
      proposal_id: "prop_v3_test",
      mode: "DEEP_FOCUS",
      decision: "QUEUE",
      reason: "User is in deep focus",
      ts: Date.now(),
    });

    db.recordShadowLabel({
      proposal_id: "prop_v3_test",
      label: "wanted",
      actual: JSON.stringify({ manual_execution: true }),
      latency_ms: 120,
      ts: Date.now(),
    });

    const labels = db.getShadowLabels("prop_v3_test");
    expect(labels.length).toBe(1);
    expect(labels[0].label).toBe("wanted");
    expect(labels[0].latency_ms).toBe(120);
  });

  it("throws DeviceNotEnrolledError when unknown device attempts ingest", () => {
    expect(() => {
      db.ingestEvent("dev_unknown", {
        event_id: "evt_unknown",
        kind: "telemetry",
        ts_device: 1000,
        payload: {},
      });
    }).toThrow("Device not enrolled: dev_unknown");
  });

  it("throws EventIdConflictError when another device attempts cross-device event_id collision", () => {
    db.registerDevice({
      device_id: "dev_laptop",
      name: "Dell XPS",
      platform: "windows",
      pubkey_spki: new Uint8Array([9, 8, 7]),
      key_attested: 0,
      scopes: ["telemetry:write"],
      enrolled_at: 1728000001,
      revoked_at: null,
    });

    db.ingestEvent("dev_phone_galaxy", {
      event_id: "evt_shared_id",
      kind: "telemetry",
      ts_device: 1000,
      payload: { owner: "phone" },
    });

    expect(() => {
      db.ingestEvent("dev_laptop", {
        event_id: "evt_shared_id",
        kind: "telemetry",
        ts_device: 1001,
        payload: { owner: "laptop" },
      });
    }).toThrow("Event ID collision across different devices: evt_shared_id");
  });

  it("filters listEvents by deviceId", () => {
    db.registerDevice({
      device_id: "dev_laptop",
      name: "Dell XPS",
      platform: "windows",
      pubkey_spki: new Uint8Array([9, 8, 7]),
      key_attested: 0,
      scopes: ["telemetry:write"],
      enrolled_at: 1728000001,
      revoked_at: null,
    });

    db.ingestEvent("dev_phone_galaxy", {
      event_id: "evt_phone_1",
      kind: "telemetry",
      ts_device: 1000,
      payload: {},
    });

    db.ingestEvent("dev_laptop", {
      event_id: "evt_laptop_1",
      kind: "telemetry",
      ts_device: 1001,
      payload: {},
    });

    const phoneEvents = db.listEvents({ deviceId: "dev_phone_galaxy" });
    expect(phoneEvents.length).toBe(1);
    expect(phoneEvents[0].event_id).toBe("evt_phone_1");

    const laptopEvents = db.listEvents({ deviceId: "dev_laptop" });
    expect(laptopEvents.length).toBe(1);
    expect(laptopEvents[0].event_id).toBe("evt_laptop_1");
  });
});

