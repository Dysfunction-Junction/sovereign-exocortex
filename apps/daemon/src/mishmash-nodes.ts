export interface MishmashNodeSpec {
  id: string;
  role: string;
  port: number;
  envKey: string;
  repo: string;
  runner: "node" | "tsx" | "python";
  script: string;
  portVariable: string;
}

// One row per local project. The gateway routes by these ids and ports.
export const MISHMASH_LAUNCH: MishmashNodeSpec[] = [
  {
    id: "hermes-api",
    role: "device and phone tasks",
    port: 3000,
    envKey: "HERMES_UPSTREAM",
    repo: "hermes-api",
    runner: "tsx",
    script: "mishmash/delegate.ts",
    portVariable: "MISHMASH_PORT",
  },
  {
    id: "autonomous-triad",
    role: "intent and review",
    port: 8789,
    envKey: "TRIAD_UPSTREAM",
    repo: "autonomous-triad",
    runner: "python",
    script: "triad.server",
    portVariable: "TRIAD_PORT",
  },
  {
    id: "pieces-for-all",
    role: "local memory gateway",
    port: 39400,
    envKey: "PIECES_FOR_ALL_UPSTREAM",
    repo: "pieces-for-all",
    runner: "tsx",
    script: "src/server.ts",
    portVariable: "PORT",
  },
  {
    id: "agent-mesh-mcp",
    role: "local MCP switchboard",
    port: 39401,
    envKey: "AGENT_MESH_UPSTREAM",
    repo: "agent-mesh-mcp",
    runner: "tsx",
    script: "src/mishmash-delegate.ts",
    portVariable: "MISHMASH_PORT",
  },
  {
    id: "pattern-analyzer",
    role: "pattern lifecycle ranking",
    port: 39402,
    envKey: "PATTERN_ANALYZER_UPSTREAM",
    repo: "pattern-analyzer",
    runner: "tsx",
    script: "src/mishmash-delegate.ts",
    portVariable: "MISHMASH_PORT",
  },
  {
    id: "registry-app",
    role: "SecondGuess staging over the pattern library",
    port: 39403,
    envKey: "REGISTRY_APP_UPSTREAM",
    repo: "registry-app",
    runner: "tsx",
    script: "mishmash/delegate.ts",
    portVariable: "MISHMASH_PORT",
  },
  {
    id: "gut-instinct",
    role: "on-device coach contract",
    port: 39404,
    envKey: "GUT_INSTINCT_UPSTREAM",
    repo: "gut-instinct",
    runner: "node",
    script: "mishmash/delegate.mjs",
    portVariable: "MISHMASH_PORT",
  },
  {
    id: "tool-registry-heartbeat",
    role: "scheduled tool-inventory tasks",
    port: 39405,
    envKey: "TOOL_REGISTRY_UPSTREAM",
    repo: "tool-registry-heartbeat",
    runner: "node",
    script: "mishmash/delegate.mjs",
    portVariable: "MISHMASH_PORT",
  },
];
