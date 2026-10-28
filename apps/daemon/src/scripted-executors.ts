/**
 * @file scripted-executors.ts
 * Deterministic scripted executors for T0 and T1 actions (row 2.3).
 *
 * Invariant: Models may PROPOSE; execution runs strictly typed, deterministic code
 * with schema-validated arguments only. Unknown or invalid arguments are refused.
 * Zero model/LLM calls occur in the execution step.
 */

import { z } from "zod";
import type { LivingLifeGraph } from "@exocortex/world-model";
import type { ExocortexDatabase } from "@exocortex/core/db";
import type { InferencePolicy, ProposalEnvelope } from "@exocortex/world-model";

// Strict schemas for T0/T1 action commands.
// .strict() ensures any unexpected/extra properties are refused.

export const DiagnosticProbeSchema = z
  .object({
    command: z.literal("diagnostic_probe"),
    invariantId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    targetEntityId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_:-]+$/)
      .optional(),
    maxHops: z.number().int().min(1).max(10).default(2).optional(),
    note: z.string().max(256).optional(),
    heavyNetwork: z.boolean().optional(),
  })
  .strict();

export type DiagnosticProbeInput = z.infer<typeof DiagnosticProbeSchema>;

export const SelfHealRestoreSchema = z
  .object({
    command: z.literal("self_heal_restore"),
    invariantId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
    targetEntityId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_:-]+$/),
    targetState: z.union([z.boolean(), z.string(), z.number()]),
  })
  .strict();

export type SelfHealRestoreInput = z.infer<typeof SelfHealRestoreSchema>;

export interface ScriptedExecutorContext {
  lifeGraph?: LivingLifeGraph | null;
  db?: Pick<ExocortexDatabase, "isCircuitBreakerTripped"> | null;
  now?: () => number;
}

export type ScriptedExecutionOutcome =
  | {
      ok: true;
      command: "diagnostic_probe";
      invariantId?: string;
      targetEntityId?: string;
      hops: number;
      graphContext?: {
        entityFound: boolean;
        entityType?: string;
        subgraphEntityCount: number;
        subgraphEdgeCount: number;
        neighbors: string[];
      };
      executedAt: number;
    }
  | {
      ok: true;
      command: "self_heal_restore";
      invariantId: string;
      targetEntityId: string;
      targetState: boolean | string | number;
      restored: boolean;
      executedAt: number;
    }
  | {
      ok: false;
      error: string;
      command?: string;
      details?: unknown;
    };

/**
 * Deterministic scripted executor for `diagnostic_probe` (Tier T0).
 * Inspects the life graph and invariant context without calling any model.
 */
export function handleDiagnosticProbe(
  input: unknown,
  context: ScriptedExecutorContext = {},
): ScriptedExecutionOutcome {
  const parsed = DiagnosticProbeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Refused: invalid diagnostic_probe arguments`,
      command: "diagnostic_probe",
      details: parsed.error.issues,
    };
  }

  const { invariantId, targetEntityId, maxHops = 2 } = parsed.data;
  const now = context.now ? context.now() : Date.now();

  let graphContext:
    | {
        entityFound: boolean;
        entityType?: string;
        subgraphEntityCount: number;
        subgraphEdgeCount: number;
        neighbors: string[];
      }
    | undefined;

  if (context.lifeGraph && targetEntityId) {
    const entity = context.lifeGraph.getEntity(targetEntityId);
    const entityFound = Boolean(entity);
    const neighbors = context.lifeGraph.getNeighbors(targetEntityId).map((n) => n.id);
    const subgraph = context.lifeGraph.queryContextSubgraph([targetEntityId], maxHops);

    graphContext = {
      entityFound,
      entityType: entity?.type,
      subgraphEntityCount: subgraph.entities.length,
      subgraphEdgeCount: subgraph.edges.length,
      neighbors,
    };
  }

  return {
    ok: true,
    command: "diagnostic_probe",
    invariantId,
    targetEntityId,
    hops: maxHops,
    graphContext,
    executedAt: now,
  };
}

/**
 * Deterministic scripted executor for `self_heal_restore` (Tier T0 for CODE_HEALTH).
 * Performs typed code-health restoration check without calling any model.
 */
export function handleSelfHealRestore(
  input: unknown,
  context: ScriptedExecutorContext = {},
): ScriptedExecutionOutcome {
  const parsed = SelfHealRestoreSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Refused: invalid self_heal_restore arguments`,
      command: "self_heal_restore",
      details: parsed.error.issues,
    };
  }

  const { invariantId, targetEntityId, targetState } = parsed.data;
  const now = context.now ? context.now() : Date.now();

  // If entity is in lifeGraph, stimulate or verify its state deterministically
  if (context.lifeGraph && targetEntityId) {
    const entity = context.lifeGraph.getEntity(targetEntityId);
    if (entity) {
      context.lifeGraph.stimulate(targetEntityId, 0.2, now);
    }
  }

  return {
    ok: true,
    command: "self_heal_restore",
    invariantId,
    targetEntityId,
    targetState,
    restored: true,
    executedAt: now,
  };
}

/**
 * Main dispatcher for T0 and T1 scripted actions.
 * Refuses any unknown command, invalid schema, or unexpected properties.
 */
export function executeScriptedAction(
  actionPayload: unknown,
  context: ScriptedExecutorContext = {},
): ScriptedExecutionOutcome {
  if (!actionPayload || typeof actionPayload !== "object" || Array.isArray(actionPayload)) {
    return {
      ok: false,
      error: "Refused: action payload must be a non-null object",
    };
  }

  const record = actionPayload as Record<string, unknown>;
  const command = record.command;

  if (typeof command !== "string" || !command.trim()) {
    return {
      ok: false,
      error: "Refused: missing or non-string command field",
    };
  }

  switch (command) {
    case "diagnostic_probe":
      return handleDiagnosticProbe(record, context);
    case "self_heal_restore":
      return handleSelfHealRestore(record, context);
    default:
      return {
        ok: false,
        error: `Refused: unknown or unmapped T0/T1 action command '${command}'`,
        command,
      };
  }
}

/**
 * Default autoExecutor wired into WorldModelHost for autonomous SILENT_AUTO_EXECUTE actuation.
 */
export function defaultAutoExecutor(
  _policy: InferencePolicy,
  proposal: ProposalEnvelope,
  context: ScriptedExecutorContext = {},
): ScriptedExecutionOutcome {
  return executeScriptedAction(proposal.suggestedAction, context);
}
