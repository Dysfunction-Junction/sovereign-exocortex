/**
 * @file provenance.ts
 * Provenance registry for ledger events (PLAN_WORLD_MODEL_STORE_2026-10-31 §4.1).
 *
 * The class of an event is a pure function of fields already inside the hashed row (kind, payload source/origin,
 * device_id). `events` is append-only, so a stored column could never be backfilled for old rows. Bump
 * PROVENANCE_REGISTRY_VERSION whenever a mapping changes: projections built under another version are stale.
 */

export const PROVENANCE_REGISTRY_VERSION = 1;

export type ProvenanceClass = "observed" | "user_label" | "derived" | "system_emitted" | "unclassified";

export interface Provenance {
  class: ProvenanceClass;
  /** Content came from an external, unverified source (e.g. an Obsidian vault) or inherits from one. */
  untrusted: boolean;
  /** Historical data replayed into the ledger by a backfill rather than observed live. */
  imported: boolean;
  /** For user_label: the user intent was verified (signed tap, or an admin command on the host). */
  attested: boolean;
  /** Payload fields a projection must never read (e.g. a query's model-generated `result`). */
  redactedFields: readonly string[];
  /** Registry rule that matched, for counters and debugging. */
  rule: string;
}

export interface ProvenanceEvent {
  event_id?: string;
  kind: string;
  device_id: string;
  payload: unknown;
}

export interface ProvenanceOptions {
  /** Result of the label attestation check (`labelSource`), when the caller verified it. */
  labelAttestation?: "tap" | "inferred";
  /** Resolves `input_event_ids` of a derived event to their provenance. Unresolvable inputs are unclassified. */
  resolveInput?: (eventId: string) => Provenance | undefined;
}

/** Consumers that read the ledger declare which classes they accept. Unclassified events project nowhere. */
export const CONSUMER_CLASSES = {
  "world-model-graph": ["observed", "user_label", "derived"],
  "world-model-learner": ["observed", "derived"],
  precognitive: ["observed"],
  prediction: ["observed"],
  triage: ["observed"],
  "shadow-labels": ["user_label"],
} as const satisfies Record<string, readonly ProvenanceClass[]>;

export type ProvenanceConsumer = keyof typeof CONSUMER_CLASSES;

/** An unattested user_label (e.g. a tap label whose signature was not verified) is accepted by no consumer. */
export function consumerAccepts(consumer: ProvenanceConsumer, provenance: Provenance): boolean {
  if (provenance.class === "user_label" && !provenance.attested) return false;
  return (CONSUMER_CLASSES[consumer] as readonly ProvenanceClass[]).includes(provenance.class);
}

/** The daemon's own device. Enrollment rejects client-chosen `host:` ids, so only the daemon writes as it. */
export const HOST_DEVICE_ID = "host:exocortexd";

const NO_REDACTION: readonly string[] = Object.freeze([]);
const QUERY_REDACTION: readonly string[] = Object.freeze(["result"]);

// Higher is worse. A derived event takes the worst class among its inputs, and at least `derived`.
const CLASS_RANK: Record<ProvenanceClass, number> = {
  user_label: 0,
  observed: 1,
  derived: 2,
  system_emitted: 3,
  unclassified: 4,
};

function parsePayload(payload: unknown): Record<string, unknown> {
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

function result(
  cls: ProvenanceClass,
  rule: string,
  extra: Partial<Omit<Provenance, "class" | "rule">> = {},
): Provenance {
  return {
    class: cls,
    untrusted: extra.untrusted ?? false,
    imported: extra.imported ?? false,
    attested: extra.attested ?? false,
    redactedFields: extra.redactedFields ?? NO_REDACTION,
    rule,
  };
}

const isHostDevice = (deviceId: string): boolean => deviceId === HOST_DEVICE_ID;

export function provenanceOf(event: ProvenanceEvent, opts: ProvenanceOptions = {}): Provenance {
  const kind = event.kind;
  const payload = parsePayload(event.payload);
  const source = typeof payload.source === "string" ? payload.source : undefined;
  const origin = typeof payload.origin === "string" ? payload.origin : undefined;

  if (kind.startsWith("channel.")) return result("observed", "channel-sync", { untrusted: true });

  switch (kind) {
    case "telemetry":
    case "touch":
    case "wake":
      return result("observed", kind);
    case "observation":
      return result("observed", source ? `observation:${source}` : "observation");
    case "channel_ingest":
      return result("observed", "channel_ingest", { untrusted: true });
    case "query":
      return result("observed", "query", { redactedFields: QUERY_REDACTION });
    case "past":
      if (origin === "comms-backfill" || origin === "pieces-backfill") {
        return result("observed", `past:${origin}`, { imported: true });
      }
      return result("unclassified", "past:unknown-origin");
    case "proposal":
      return result("system_emitted", "proposal");
    case "label":
      if (source === "tap") {
        return result("user_label", "label:tap", { attested: opts.labelAttestation === "tap" });
      }
      // Labels without a source predate the tap/inferred split and were never attested.
      return result("system_emitted", source === "inferred" ? "label:inferred" : "label:unsourced");
    case "vision_observation":
      return result("derived", source ? `vision_observation:${source}` : "vision_observation");
    case "curation_import":
      if (!isHostDevice(event.device_id)) return result("unclassified", "curation_import:off-host");
      return typeof payload.rule_source === "string"
        ? result("derived", "curation_import:rule-links")
        : result("user_label", "curation_import:vocabulary", { attested: true });
    case "entity_merge":
    case "assertion_retract":
      if (!isHostDevice(event.device_id)) return result("unclassified", `${kind}:off-host`);
      return result("user_label", kind, { attested: true });
    case "derived_assertion":
      return deriveFromInputs(payload, opts);
    default:
      return result("unclassified", `unknown-kind:${kind}`);
  }
}

function deriveFromInputs(payload: Record<string, unknown>, opts: ProvenanceOptions): Provenance {
  const ids = Array.isArray(payload.input_event_ids)
    ? payload.input_event_ids.filter((id): id is string => typeof id === "string")
    : [];
  if (ids.length === 0 || !opts.resolveInput) return result("unclassified", "derived_assertion:no-inputs");
  let worst: ProvenanceClass = "derived";
  let untrusted = false;
  for (const id of ids) {
    const input = opts.resolveInput(id);
    if (!input) return result("unclassified", "derived_assertion:unresolved-input");
    if (CLASS_RANK[input.class] > CLASS_RANK[worst]) worst = input.class;
    untrusted ||= input.untrusted;
  }
  return result(worst, "derived_assertion", { untrusted });
}

/** Copy of the payload without the fields a projection must not read. Returns the input when nothing is redacted. */
export function redactPayload<T>(payload: T, provenance: Provenance): T {
  if (provenance.redactedFields.length === 0) return payload;
  const obj = parsePayload(payload);
  const copy: Record<string, unknown> = { ...obj };
  for (const field of provenance.redactedFields) delete copy[field];
  return (typeof payload === "string" ? JSON.stringify(copy) : copy) as T;
}
