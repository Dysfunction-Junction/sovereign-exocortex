import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { MESH_SKILLS_VERSION, meshSkillCatalog } from "./mesh-skills.js";


const NODE = "agent-mesh-mcp";

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function envelope(body: Record<string, unknown>, result: Record<string, unknown>) {
  return {
    v: 1,
    inReplyTo: body.id,
    from: NODE,
    to: body.from,
    ok: true,
    result,
  };
}

const HASH_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_QUARANTINE_ENTRIES = 1000;
const quarantinedPlaybooks = new Set<string>();
let quarantineSaturated = false;

export function _resetQuarantineForTest(): void {
  quarantinedPlaybooks.clear();
  quarantineSaturated = false;
}

function addAllToQuarantine(keys: string[]): boolean {
  const fresh = keys.filter((k) => !quarantinedPlaybooks.has(k));
  if (quarantinedPlaybooks.size + fresh.length > MAX_QUARANTINE_ENTRIES) {
    quarantineSaturated = true;
    return false;
  }
  for (const k of fresh) {
    quarantinedPlaybooks.add(k);
  }
  return true;
}

function extractPlaybookId(p: Record<string, unknown>): { id?: string; error?: string } {
  if ("playbookId" in p && typeof p.playbookId !== "string") {
    return { error: "playbookId must be a string" };
  }
  if ("playbook_id" in p && typeof p.playbook_id !== "string") {
    return { error: "playbook_id must be a string" };
  }
  const c1 = typeof p.playbookId === "string" && p.playbookId.trim().length > 0 ? p.playbookId.trim() : undefined;
  const c2 = typeof p.playbook_id === "string" && p.playbook_id.trim().length > 0 ? p.playbook_id.trim() : undefined;
  if (c1 && c2 && c1.toLowerCase() !== c2.toLowerCase()) {
    return { error: "conflicting playbookId and playbook_id values provided" };
  }
  const id = c1 ?? c2;
  if (id && !ID_RE.test(id)) {
    return { error: "invalid playbook id format (must be 1-128 chars alphanumeric/-/_/./:)" };
  }
  return { id };
}

function extractPbHash(p: Record<string, unknown>): { hash?: string; error?: string } {
  if ("pb_hash" in p && typeof p.pb_hash !== "string") {
    return { error: "pb_hash must be a string" };
  }
  if ("pbHash" in p && typeof p.pbHash !== "string") {
    return { error: "pbHash must be a string" };
  }
  const c1 = typeof p.pb_hash === "string" && p.pb_hash.trim().length > 0 ? p.pb_hash.trim().toLowerCase() : undefined;
  const c2 = typeof p.pbHash === "string" && p.pbHash.trim().length > 0 ? p.pbHash.trim().toLowerCase() : undefined;
  if (c1 && c2 && c1 !== c2) {
    return { error: "conflicting pb_hash and pbHash values provided" };
  }
  const candidate = c1 ?? c2;
  if (!candidate) return {};
  if (!HASH_RE.test(candidate)) {
    return { error: "invalid pb_hash format (must be 64-char hex sha256)" };
  }
  return { hash: candidate };
}

function isQuarantined(playbookId?: string, pbHash?: string): boolean {
  if (quarantineSaturated) {
    return true;
  }
  if (playbookId && quarantinedPlaybooks.has(`name:${playbookId.toLowerCase()}`)) {
    return true;
  }
  if (pbHash && quarantinedPlaybooks.has(`hash:${pbHash.toLowerCase()}`)) {
    return true;
  }
  return false;
}

export function handleMeshDelegate(body: unknown): { status: number; body: Record<string, unknown> } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "envelope must be a JSON object" } };
  }
  const record = body as Record<string, unknown>;
  if (record.to !== NODE || record.v !== 1) {
    return { status: 400, body: { error: "envelope is not addressed to agent-mesh-mcp" } };
  }
  if (record.action === "ping") {
    return {
      status: 200,
      body: envelope(record, { node: NODE, action: "ping", version: MESH_SKILLS_VERSION }),
    };
  }
  if (record.action === "skills") {
    const skills = meshSkillCatalog().map(({ id, title, tier }) => ({ id, title, tier }));
    return {
      status: 200,
      body: envelope(record, { node: NODE, action: "skills", version: MESH_SKILLS_VERSION, skills }),
    };
  }
  if (record.action === "dispatch") {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const skillId = String(payload.skillId || payload.action || "mesh-do");
    const catalog = meshSkillCatalog();
    const matched = catalog.find((s) => s.id === skillId) ?? catalog[0] ?? {
      id: "mesh-do",
      title: "Mesh Execution",
      tier: 1,
    };
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      status: 200,
      body: envelope(record, {
        node: NODE,
        action: "dispatch",
        version: MESH_SKILLS_VERSION,
        executionId,
        skill: {
          id: matched.id,
          title: matched.title,
          tier: matched.tier,
        },
        status: "dispatched",
        receivedPayload: payload,
      }),
    };
  }
  if (record.action === "playbook") {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const idRes = extractPlaybookId(payload);
    if (idRes.error) {
      return {
        status: 400,
        body: envelope(record, {
          node: NODE,
          action: "playbook",
          ok: false,
          error: idRes.error,
        }),
      };
    }
    const hashRes = extractPbHash(payload);
    if (hashRes.error) {
      return {
        status: 400,
        body: envelope(record, {
          node: NODE,
          action: "playbook",
          ok: false,
          error: hashRes.error,
        }),
      };
    }
    const playbookId = idRes.id ?? "ambient_sync";
    const pbHash = hashRes.hash;

    if (isQuarantined(playbookId, pbHash)) {
      return {
        status: 403,
        body: envelope(record, {
          node: NODE,
          action: "playbook",
          ok: false,
          error: `playbook ${playbookId} is quarantined and cannot be executed`,
          playbookId,
        }),
      };
    }

    // No playbook controller is wired to this HTTP endpoint: never report a run that did not happen.
    return {
      status: 501,
      body: {
        ...envelope(record, {
          node: NODE,
          action: "playbook",
          ok: false,
          error: "HTTP playbook execution is not implemented",
          playbookId,
        }),
        ok: false,
      },
    };
  }
  if (record.action === "synthesize") {
    const payload = (record.payload ?? {}) as Record<string, unknown>;

    // B1: Strict supportCount validation (no default bypass, integer >= 3)
    const sc = payload.supportCount;
    if (typeof sc !== "number" || !Number.isInteger(sc) || sc < 3) {
      return {
        status: 400,
        body: envelope(record, {
          node: NODE,
          action: "synthesize",
          ok: false,
          error: "supportCount must be an integer >= 3",
        }),
      };
    }

    // H3: Strict packageName validation (no Chrome default bypass)
    const PKG_REGEX = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
    if (typeof payload.packageName !== "string" || !PKG_REGEX.test(payload.packageName)) {
      return {
        status: 400,
        body: envelope(record, {
          node: NODE,
          action: "synthesize",
          ok: false,
          error: "valid packageName is required (e.g. com.example.app)",
        }),
      };
    }
    const packageName = payload.packageName;

    // H4: candidateId string validation
    if (typeof payload.candidateId !== "string" || !payload.candidateId.trim()) {
      return {
        status: 400,
        body: envelope(record, {
          node: NODE,
          action: "synthesize",
          ok: false,
          error: "candidateId string is required",
        }),
      };
    }
    const candidateId = payload.candidateId.trim();

    // B3: Safe type-guarding on sensitiveSurfaces
    const rawSurfaces = payload.sensitiveSurfaces ?? [];
    if (!Array.isArray(rawSurfaces) || !rawSurfaces.every((s): s is string => typeof s === "string")) {
      return {
        status: 400,
        body: envelope(record, {
          node: NODE,
          action: "synthesize",
          ok: false,
          error: "sensitiveSurfaces must be an array of strings",
        }),
      };
    }

    // B4: Steps validation and cap length <= 16
    const rawSteps = payload.sequence ?? payload.steps;
    const steps: string[] = Array.isArray(rawSteps) && rawSteps.length > 0 ? rawSteps : ["mesh-do"];
    if (!steps.every((s): s is string => typeof s === "string") || steps.length > 16) {
      return {
        status: 400,
        body: envelope(record, {
          node: NODE,
          action: "synthesize",
          ok: false,
          error: "steps must be an array of strings with length between 1 and 16",
        }),
      };
    }

    // B2: Comprehensive sensitive surface check across packageName, candidateId, steps, and sensitiveSurfaces
    const SENSITIVE_REGEX = /(?:bank|auth|login|password|credential|finance|token|otp|2fa|mfa|\bpin\b|wallet|payment|card|secret|vault|keystore|biometric|oauth|sso|passcode|sign[_\s-]?in)/i;
    const targetsToCheck = [packageName, candidateId, ...rawSurfaces, ...steps];
    const foundSensitive = targetsToCheck.filter((s) => SENSITIVE_REGEX.test(s));
    if (foundSensitive.length > 0) {
      return {
        status: 422,
        body: envelope(record, {
          node: NODE,
          action: "synthesize",
          ok: false,
          error: "sensitive surface denylisted: cannot synthesize playbook for security-sensitive screens or steps",
          rejectedSurfaces: Array.from(new Set(foundSensitive)),
        }),
      };
    }

    // B4: Enforce max tier <= 1 against meshSkillCatalog
    const catalog = meshSkillCatalog();
    for (const step of steps) {
      const matched = catalog.find((c) => c.id === step);
      if (matched && matched.tier > 1) {
        return {
          status: 403,
          body: envelope(record, {
            node: NODE,
            action: "synthesize",
            ok: false,
            error: `self-escalation prohibited: step '${step}' requires tier ${matched.tier}, but synthesized playbooks are restricted to tier 1`,
          }),
        };
      }
    }

    // B5 & H1: Deterministic DAG content hash; autonomousAllowed MUST be false before human approval
    const cleanPkg = packageName.replace(/[^a-zA-Z0-9]/g, "_");
    const dagBody = {
      packageName,
      candidateId,
      steps,
      tier: 1,
      autonomousAllowed: false,
    };
    const pb_hash = createHash("sha256").update(JSON.stringify(dagBody)).digest("hex").toLowerCase();
    const playbookId = `synth_${cleanPkg}_${pb_hash.slice(0, 12)}`;

    // Quarantine check
    if (isQuarantined(playbookId, pb_hash)) {
      return {
        status: 403,
        body: envelope(record, {
          node: NODE,
          action: "synthesize",
          ok: false,
          error: `playbook ${playbookId} is quarantined and cannot be synthesized`,
        }),
      };
    }

    return {
      status: 200,
      body: envelope(record, {
        node: NODE,
        action: "synthesize",
        status: "synthesized",
        playbookId,
        pb_hash,
        tier: 1,
        steps,
        autonomousAllowed: false,
        requiresBiometricApproval: true,
        summary: `Synthesized playbook ${playbookId} for ${packageName} across ${sc} observed events`,
      }),
    };
  }
  if (record.action === "demote") {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const idRes = extractPlaybookId(payload);
    if (idRes.error) {
      return {
        status: 400,
        body: envelope(record, { node: NODE, action: "demote", ok: false, error: idRes.error }),
      };
    }
    if (!idRes.id) {
      return {
        status: 400,
        body: envelope(record, {
          node: NODE,
          action: "demote",
          ok: false,
          error: "playbookId string is required for demote",
        }),
      };
    }
    const playbookId = idRes.id;

    const hashRes = extractPbHash(payload);
    if (hashRes.error) {
      return {
        status: 400,
        body: envelope(record, { node: NODE, action: "demote", ok: false, error: hashRes.error }),
      };
    }

    // H2: reason enum validation
    const ALLOWED_REASONS = ["execution_error", "user_undo", "drift", "manual"];
    const reason = typeof payload.reason === "string" && ALLOWED_REASONS.includes(payload.reason)
      ? payload.reason
      : "execution_error";

    const keysToAdd = [`name:${playbookId.toLowerCase()}`];
    if (hashRes.hash) {
      keysToAdd.push(`hash:${hashRes.hash.toLowerCase()}`);
    }

    if (!addAllToQuarantine(keysToAdd)) {
      return {
        status: 507,
        body: envelope(record, {
          node: NODE,
          action: "demote",
          ok: false,
          error: "quarantine capacity exceeded; cannot demote",
        }),
      };
    }

    return {
      status: 200,
      body: envelope(record, {
        node: NODE,
        action: "demote",
        status: "quarantined",
        playbookId,
        reason,
        autonomousAllowed: false,
        summary: `Playbook ${playbookId} demoted to quarantine following ${reason}`,
      }),
    };
  }
  return { status: 400, body: { error: "agent-mesh-mcp accepts ping, skills, dispatch, playbook, synthesize, or demote" } };
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("delegate body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(new Error("body stream failed")));
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * A loopback socket does not prove the caller is local software: any web page
 * can make the browser POST here (CSRF), and a rebound DNS name reaches it with
 * a loopback peer address. Browsers always attach Origin to POSTs and the Host
 * header carries the name that was resolved, so both are checked.
 */
export function isTrustedDelegateRequest(
  headers: IncomingMessage["headers"],
  port: number,
): boolean {
  if (headers.origin !== undefined) return false;
  const host = headers.host;
  return (
    typeof host === "string" &&
    [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(
      host.toLowerCase(),
    )
  );
}

export function startMeshDelegate(port: number) {
  const server = createServer(async (req, res) => {
    const address = server.address();
    if (
      !address ||
      typeof address === "string" ||
      !isTrustedDelegateRequest(req.headers, address.port)
    ) {
      send(res, 403, { error: "delegate rejects browser-origin or rebound-host requests" });
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      send(res, 200, { ok: true, node: NODE });
      return;
    }
    if (req.method !== "POST" || path !== "/mishmash/delegate") {
      send(res, 404, { error: "Not Found" });
      return;
    }
    if (!isLoopback(req.socket.remoteAddress)) {
      send(res, 403, { error: "delegate is only accepted from this PC" });
      return;
    }

    const token = (process.env.GATEWAY_TOKEN ?? process.env.MESH_DELEGATE_TOKEN ?? "").trim();
    if (token) {
      const auth = req.headers.authorization ?? "";
      const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const expectedBuf = Buffer.from(token, "utf8");
      const presentedBuf = Buffer.from(presented, "utf8");
      if (
        expectedBuf.length !== presentedBuf.length ||
        !timingSafeEqual(expectedBuf, presentedBuf)
      ) {
        send(res, 401, { error: "Unauthorized: invalid or missing delegate bearer token" });
        return;
      }
    }
    try {
      const raw = await readBody(req, 64 * 1024);
      const decoded = raw ? JSON.parse(raw) : {};
      const outcome = handleMeshDelegate(decoded);
      send(res, outcome.status, outcome.body);
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : "bad body" });
    }
  });
  // listen() reports EADDRINUSE/EACCES as an 'error' event, not a thrown
  // exception, so without this the promise never rejects and the caller's
  // .catch can't fire.
  return new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

const invoked = process.argv.some((arg) => {
  const base = arg.split(/[/\\]/).pop();
  return base === "mishmash-delegate.ts" || base === "mishmash-delegate.js";
});
if (invoked) {
  const port = Number(process.env.MISHMASH_PORT || 39401);
  startMeshDelegate(port).then(() => {
    console.log(`agent-mesh-mcp mishmash on 127.0.0.1:${port}`);
  }).catch((err) => {
    console.error(`agent-mesh-mcp mishmash failed to start:`, err);
    process.exitCode = 1;
  });
}
