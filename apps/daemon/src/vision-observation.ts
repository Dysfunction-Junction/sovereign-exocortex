import { randomUUID } from "node:crypto";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { defaultWorldModelHost } from "./world-model-host.js";
import { HOST_DEVICE_ID, ShadowRecorder } from "./shadow-recorder.js";
import { isConfidentTestClassification, type TestScreenshotClassification } from "./vision-adapter.js";

export function recordTestScreenshotClassification(
  result: TestScreenshotClassification,
  db: ExocortexDatabase,
): { eventId: string; generatedPoliciesCount: number; proposalIds: string[] } {
  const observedAt = Date.now();
  const confident = isConfidentTestClassification(result);
  const eventId = `vision-test:${randomUUID()}`;
  const recorder = new ShadowRecorder(db, { shadow: true });
  recorder.ensureHostDevice();
  const payload = confident
    ? {
        invariantId: "inv_clean_test_suite",
        observedState: result.status === "passed",
        observedAt,
        confidence: result.confidence,
        source: "local_vision",
        factor: "repo_health",
        observation: result.status === "passed" ? "tests_pass" : "tests_fail",
      }
    : {
        source: "local_vision",
        classification: result.status,
        confidence: result.confidence,
      };

  const { event } = db.ingestEvent(HOST_DEVICE_ID, {
    event_id: eventId,
    kind: confident ? "observation" : "vision_observation",
    ts_device: observedAt,
    schema_ver: 1,
    payload,
  });

  if (!confident) {
    return { eventId, generatedPoliciesCount: 0, proposalIds: [] };
  }

  defaultWorldModelHost.setShadowRecorder(recorder);
  const evaluated = defaultWorldModelHost.ingestObservation({
    invariantId: "inv_clean_test_suite",
    observedState: result.status === "passed",
    observedAt,
    confidence: result.confidence,
    metadata: { source: "local_vision" },
  }, { allowAutoExecute: false });

  return {
    eventId,
    generatedPoliciesCount: evaluated.generatedPoliciesCount,
    proposalIds: evaluated.proposals.map((proposal) => proposal.id),
  };
}
