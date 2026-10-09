import type { Provider, TaskMode } from "./types.js";

export const ORCHESTRATION_PRESETS = [
  "max_plan",
  "max_adversarial_review",
  "max_implementation",
  "productionize",
  "cursor_cost_offset",
] as const;
export type OrchestrationPresetName = (typeof ORCHESTRATION_PRESETS)[number];
export type WorkspaceStrategy =
  | "shared_readonly"
  | "single_writer_initiative"
  | "competing_worktrees";

export interface PresetAgent {
  id: string;
  provider: Provider;
  role: "planner" | "builder" | "reviewer" | "judge" | "tester";
  model: string;
  effort: string;
  mode: TaskMode;
  independent: boolean;
}

export interface PresetWave {
  id: string;
  agents: string[];
  waitsFor: string[];
  revealPriorOutputs: boolean;
  completion: "all" | "first_success";
}

export interface OrchestrationPreset {
  name: OrchestrationPresetName;
  description: string;
  workspaceStrategy: WorkspaceStrategy;
  singleWriter: boolean;
  maxConcurrency: number;
  agents: PresetAgent[];
  waves: PresetWave[];
  modelPolicy: {
    cursor: { model: string; effort: string };
    codex: { model: string; effort: string };
    claude: { model: string; effort: string; fallbackModel: string };
    grok: { model: string; effort: string };
    antigravity: { model: string; effort: string };
  };
}

const MODEL_POLICY: OrchestrationPreset["modelPolicy"] = {
  cursor: { model: "gpt-5.6-sol-max", effort: "max" },
  codex: { model: "gpt-5.6-sol", effort: "ultra" },
  claude: {
    model: "claude-opus-5",
    effort: "max",
    fallbackModel: "claude-fable-5",
  },
  grok: { model: "grok-4.5", effort: "high" },
  antigravity: { model: "gemini-3.6-flash-high", effort: "high" },
};

function agent(
  id: string,
  provider: Provider,
  role: PresetAgent["role"],
  mode: TaskMode,
  independent = true,
): PresetAgent {
  const policy = MODEL_POLICY[provider];
  return {
    id,
    provider,
    role,
    mode,
    model: policy.model,
    effort: policy.effort,
    independent,
  };
}

const PRESETS: Record<OrchestrationPresetName, OrchestrationPreset> = {
  max_plan: {
    name: "max_plan",
    description:
      "Independent maximum-quality Codex, Claude, Grok, and Antigravity plans followed by a parent synthesis.",
    workspaceStrategy: "shared_readonly",
    singleWriter: true,
    maxConcurrency: 4,
    agents: [
      agent("codex-planner", "codex", "planner", "plan"),
      agent("claude-planner", "claude", "planner", "plan"),
      agent("grok-planner", "grok", "planner", "plan"),
      agent("antigravity-planner", "antigravity", "planner", "plan"),
    ],
    waves: [
      {
        id: "independent-plans",
        agents: [
          "codex-planner",
          "claude-planner",
          "grok-planner",
          "antigravity-planner",
        ],
        waitsFor: [],
        revealPriorOutputs: false,
        completion: "all",
      },
    ],
    modelPolicy: MODEL_POLICY,
  },
  max_adversarial_review: {
    name: "max_adversarial_review",
    description:
      "Independent maximum-quality Codex, Claude, Grok, and Antigravity reviews hidden until all submit.",
    workspaceStrategy: "shared_readonly",
    singleWriter: true,
    maxConcurrency: 4,
    agents: [
      agent("codex-reviewer", "codex", "reviewer", "review"),
      agent("claude-reviewer", "claude", "reviewer", "review"),
      agent("grok-reviewer", "grok", "reviewer", "review"),
      agent("antigravity-reviewer", "antigravity", "reviewer", "review"),
    ],
    waves: [
      {
        id: "blind-review",
        agents: [
          "codex-reviewer",
          "claude-reviewer",
          "grok-reviewer",
          "antigravity-reviewer",
        ],
        waitsFor: [],
        revealPriorOutputs: false,
        completion: "all",
      },
    ],
    modelPolicy: MODEL_POLICY,
  },
  max_implementation: {
    name: "max_implementation",
    description:
      "One maximum-quality Codex writer in an initiative worktree followed by Claude, Grok, and Antigravity review.",
    workspaceStrategy: "single_writer_initiative",
    singleWriter: true,
    maxConcurrency: 3,
    agents: [
      agent("codex-builder", "codex", "builder", "implement", false),
      agent("claude-reviewer", "claude", "reviewer", "review"),
      agent("grok-reviewer", "grok", "reviewer", "review"),
      agent("antigravity-reviewer", "antigravity", "reviewer", "review"),
    ],
    waves: [
      {
        id: "build",
        agents: ["codex-builder"],
        waitsFor: [],
        revealPriorOutputs: true,
        completion: "all",
      },
      {
        id: "review",
        agents: ["claude-reviewer", "grok-reviewer", "antigravity-reviewer"],
        waitsFor: ["build"],
        revealPriorOutputs: true,
        completion: "all",
      },
    ],
    modelPolicy: MODEL_POLICY,
  },
  productionize: {
    name: "productionize",
    // MESH[2026-07-25T22:15Z][agent:cursor-parent][direction:user/12]
    // What: drops the Codex reviewer and stops promising waves this preset lacks.
    // Why: the builder is Codex, so keeping a Codex reviewer let a provider review
    //   its own work, which every tier doctrine forbids. The description also
    //   advertised fix and audit waves that do not exist; the waves are plan,
    //   implement, adversarial-review, test-and-finalize.
    // Aligns-with: direction user revision 12 (coherence review findings).
    // Status: complete
    description:
      "Plan, single-writer implementation, blind adversarial review by three other providers, then a test wave.",
    workspaceStrategy: "single_writer_initiative",
    singleWriter: true,
    maxConcurrency: 4,
    agents: [
      agent("codex-planner", "codex", "planner", "plan"),
      agent("claude-planner", "claude", "planner", "plan"),
      agent("grok-planner", "grok", "planner", "plan"),
      agent("antigravity-planner", "antigravity", "planner", "plan"),
      agent("codex-builder", "codex", "builder", "implement", false),
      agent("claude-reviewer", "claude", "reviewer", "review"),
      agent("grok-reviewer", "grok", "reviewer", "review"),
      agent("antigravity-reviewer", "antigravity", "reviewer", "review"),
      agent("claude-tester", "claude", "tester", "review"),
    ],
    waves: [
      {
        id: "plan",
        agents: [
          "codex-planner",
          "claude-planner",
          "grok-planner",
          "antigravity-planner",
        ],
        waitsFor: [],
        revealPriorOutputs: false,
        completion: "all",
      },
      {
        id: "implement",
        agents: ["codex-builder"],
        waitsFor: ["plan"],
        revealPriorOutputs: true,
        completion: "all",
      },
      {
        id: "adversarial-review",
        agents: ["claude-reviewer", "grok-reviewer", "antigravity-reviewer"],
        waitsFor: ["implement"],
        revealPriorOutputs: false,
        completion: "all",
      },
      {
        id: "test-and-finalize",
        agents: ["claude-tester"],
        waitsFor: ["adversarial-review"],
        revealPriorOutputs: true,
        completion: "all",
      },
    ],
    modelPolicy: MODEL_POLICY,
  },
  cursor_cost_offset: {
    name: "cursor_cost_offset",
    description:
      "Keep Cursor as coordinator while Codex, Claude, Grok, and Antigravity perform maximum-effort reasoning.",
    workspaceStrategy: "shared_readonly",
    singleWriter: true,
    maxConcurrency: 4,
    agents: [
      agent("codex-heavy", "codex", "reviewer", "review"),
      agent("claude-heavy", "claude", "reviewer", "review"),
      agent("grok-heavy", "grok", "reviewer", "review"),
      agent("antigravity-heavy", "antigravity", "reviewer", "review"),
    ],
    waves: [
      {
        id: "external-heavy-reasoning",
        agents: [
          "codex-heavy",
          "claude-heavy",
          "grok-heavy",
          "antigravity-heavy",
        ],
        waitsFor: [],
        revealPriorOutputs: false,
        completion: "all",
      },
    ],
    modelPolicy: MODEL_POLICY,
  },
};

export function listOrchestrationPresets(): OrchestrationPreset[] {
  return ORCHESTRATION_PRESETS.map((name) => structuredClone(PRESETS[name]));
}

export function getOrchestrationPreset(name: string): OrchestrationPreset {
  if (!(ORCHESTRATION_PRESETS as readonly string[]).includes(name)) {
    throw new Error(`Unknown orchestration preset: ${name}`);
  }
  return structuredClone(PRESETS[name as OrchestrationPresetName]);
}

export function maximumModelPolicy(): OrchestrationPreset["modelPolicy"] {
  return structuredClone(MODEL_POLICY);
}
