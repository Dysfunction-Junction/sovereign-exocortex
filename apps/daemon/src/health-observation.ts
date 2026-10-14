import { randomUUID } from "node:crypto";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { defaultWorldModelHost } from "./world-model-host.js";
import { HOST_DEVICE_ID, ShadowRecorder } from "./shadow-recorder.js";

export function recordCodeHealthObservation(
  passed: boolean,
  db: ExocortexDatabase,
): {
  eventId: string;
  generatedPoliciesCount: number;
  proposalIds: string[];
} {
  const observedAt = Date.now();
  const eventId = `local-test:${randomUUID()}`;
  const host = defaultWorldModelHost;
  const recorder = new ShadowRecorder(db, { shadow: true });
  recorder.ensureHostDevice();

  db.ingestEvent(HOST_DEVICE_ID, {
    event_id: eventId,
    kind: "observation",
    ts_device: observedAt,
    schema_ver: 1,
    payload: {
      invariantId: "inv_clean_test_suite",
      observedState: passed,
      observedAt,
      confidence: 1,
      source: "exo_test",
      factor: "repo_health",
      observation: passed ? "tests_pass" : "tests_fail",
    },
  });

  host.setShadowRecorder(recorder);
  let result;
  try {
    result = host.ingestObservation(
      {
        invariantId: "inv_clean_test_suite",
        observedState: passed,
        observedAt,
        confidence: 1,
      },
      { allowAutoExecute: false },
    );
  } finally {
    host.setShadowRecorder(null);
  }

  return {
    eventId,
    generatedPoliciesCount: result.generatedPoliciesCount,
    proposalIds: result.proposals.map((proposal) => proposal.id),
  };
}
