// Capability map for POST /network/delegate: node x action -> required scope, risk tier, shadow behavior.
// Pure module. Default deny: anything not listed here is refused, admin included.
// Design and review: docs/DELEGATE_CAPABILITIES_DESIGN.md

export type DelegateTier = "T0" | "T1" | "T2" | "T3" | "T4";

export interface DelegateCapability {
  /** Scopes that satisfy this entry. `admin` and `admin:write` always do; an empty list means admin only. */
  scopes: readonly string[];
  tier: DelegateTier;
  /** "block": refused with 423 while SHADOW is on. */
  shadow: "allow" | "block";
}

export const SCOPE_DELEGATE_READ = "delegate:read";
export const SCOPE_DELEGATE_MEMORY_READ = "delegate:memory-read";
export const SCOPE_DELEGATE_WRITE = "delegate:write";
/** Granted to no device by default. T3 and T4 need it in addition to `admin:write`. */
export const SCOPE_DELEGATE_ACTUATE = "delegate:actuate";
export const ADMIN_SCOPES = ["admin", "admin:write"] as const;
/** A device holding none of these may not delegate at all, so the body is not even read for it. */
export const ANY_DELEGATE_SCOPES = [...ADMIN_SCOPES, SCOPE_DELEGATE_READ, SCOPE_DELEGATE_MEMORY_READ, SCOPE_DELEGATE_WRITE] as const;

// `to` and `action` must already be in this form. The resolver never normalizes, so the string it authorizes is the
// string that is forwarded.
const CANONICAL = /^[a-z][a-z0-9_-]*$/;

const T0 = { tier: "T0", shadow: "allow" } as const;
const ping: DelegateCapability = { scopes: [SCOPE_DELEGATE_READ], ...T0 };
const adminOnlyBlocked = (tier: DelegateTier): DelegateCapability => ({ scopes: [], tier, shadow: "block" });

/** Every MISHMASH_LAUNCH node must appear here (asserted in the test). */
export const DELEGATE_MAP: Readonly<Record<string, Readonly<Record<string, DelegateCapability>>>> = {
  "pieces-for-all": {
    ping,
    status: ping,
    // `memory` is resolved by sub-action below.
  },
  "agent-mesh-mcp": {
    ping,
    skills: ping,
    dispatch: adminOnlyBlocked("T3"),
    playbook: adminOnlyBlocked("T3"),
    synthesize: adminOnlyBlocked("T3"),
    demote: adminOnlyBlocked("T3"),
  },
  "pattern-analyzer": {
    ping,
    rank: { scopes: [SCOPE_DELEGATE_READ], tier: "T1", shadow: "allow" },
    feedback: { scopes: [SCOPE_DELEGATE_WRITE], tier: "T2", shadow: "block" },
  },
  "autonomous-triad": {
    ping,
    classify: { scopes: [SCOPE_DELEGATE_READ], tier: "T1", shadow: "allow" },
  },
  // Device and phone tasks: every action, ping included, is resolved in resolveDelegate as admin-only and shadow-blocked.
  "hermes-api": {},
  // Implemented upstream (stage, speculate, release, pending_proposals, cache_status, reject / contract / inventory)
  // but deliberately not delegable: only ping is mapped.
  "registry-app": { ping },
  "gut-instinct": { ping },
  "tool-registry-heartbeat": { ping },
};

const MEMORY_SEARCH: DelegateCapability = { scopes: [SCOPE_DELEGATE_MEMORY_READ], tier: "T0", shadow: "allow" };
const MEMORY_ADD: DelegateCapability = { scopes: [SCOPE_DELEGATE_WRITE], tier: "T2", shadow: "block" };

/** Returns the capability for an envelope, or null to deny. */
export function resolveDelegate(to: string, action: string, payload: Record<string, unknown>): DelegateCapability | null {
  if (!CANONICAL.test(to) || !CANONICAL.test(action)) return null;
  if (!Object.hasOwn(DELEGATE_MAP, to)) return null;
  if (to === "pieces-for-all" && action === "memory") {
    // No sub-action means search (as the memory node does). A present but non-string sub-action is denied.
    if (payload.action !== undefined && typeof payload.action !== "string") return null;
    const sub = typeof payload.action === "string" ? payload.action.toLowerCase() : "search";
    if (sub === "search") return MEMORY_SEARCH;
    if (sub === "add") return MEMORY_ADD;
    return null;
  }
  if (to === "hermes-api") return adminOnlyBlocked("T4");
  const table = DELEGATE_MAP[to]!;
  return Object.hasOwn(table, action) ? table[action]! : null;
}

/** T3 and T4 act on devices or spawn work: they need BOTH `admin:write` and `delegate:actuate`. */
export function needsActuate(capability: DelegateCapability): boolean {
  return capability.tier === "T3" || capability.tier === "T4";
}

export function scopesSatisfy(deviceScopes: readonly string[], capability: DelegateCapability): boolean {
  if (needsActuate(capability)) return deviceScopes.includes("admin:write") && deviceScopes.includes(SCOPE_DELEGATE_ACTUATE);
  return [...ADMIN_SCOPES, ...capability.scopes].some((s) => deviceScopes.includes(s));
}
