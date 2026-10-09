import { request } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ControlDashboard,
  DASHBOARD_API_PATHS,
  DASHBOARD_SESSION_COOKIE,
  DASHBOARD_SESSION_SNAPSHOT_PROTOCOL,
  startDashboard,
  type DashboardHandle,
  type DashboardSnapshotSources,
} from "../src/dashboard.js";

const cleanupPaths: string[] = [];
const dashboards: DashboardHandle[] = [];

afterEach(async () => {
  await Promise.all(
    dashboards.splice(0).map((dashboard) => dashboard.close().catch(() => undefined)),
  );
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function snapshotSources(
  overrides: Partial<DashboardSnapshotSources> = {},
): DashboardSnapshotSources {
  return {
    tasks: () => [
      {
        id: "task-1",
        provider: "codex",
        description: "Review api_key=sk-abcdefghijklmnop",
        status: "running",
        prompt: "must never be exposed",
        resultPath: "/private/result.json",
      },
    ],
    sessions: () => [
      {
        provider: "codex",
        sessionId: "session-1",
        name: "Review session",
        status: "running",
        taskCount: 1,
      },
    ],
    questions: () => [
      {
        id: "question-1",
        taskId: "task-1",
        provider: "codex",
        question: "Which database?",
        options: ["Postgres", "SQLite"],
        status: "pending",
        answer: "hidden answer",
      },
    ],
    usage: () => [
      {
        provider: "codex",
        rateLimits: {
          status: "available",
          value: [{ id: "codex", usedPercent: 25 }],
        },
      },
    ],
    workers: () => [
      {
        id: "worker-1",
        name: "Local Worker",
        transport: {
          kind: "local",
          alias: "internal-alias",
        },
        controlEndpoint: "https://private-worker.example.test",
        status: "online",
        enabled: true,
        tokenHash: "sha256:must-never-appear",
      },
    ],
    traffic: () => ({
      protocol: "agent-mesh-traffic-dashboard/v1",
      controller: {
        active: true,
        ownerInstanceId: "private-controller-instance",
        ownerPid: 123,
        tokenHash: "sha256:traffic-secret",
      },
      agents: [
        {
          id: "traffic-agent-1",
          lane: "sdk-local",
          name: "SDK Worker",
          status: "running",
          repoLabel: "safe-repo",
          worktreeLabel: "task-worktree",
          meshOwned: true,
          cwd: "/private/traffic/worktree",
          prompt: "traffic prompt must never appear",
        },
      ],
      participants: [
        {
          id: "participant-1",
          displayName: "Mailbox Chat",
          trust: "mailbox-unverified",
          status: "online",
          repoLabel: "safe-repo",
          worktreeLabel: "task-worktree",
        },
      ],
      runs: [
        {
          id: "traffic-run-1",
          agentId: "traffic-agent-1",
          status: "running",
          generation: 1,
        },
      ],
    }),
    peers: () => ({
      protocol: "agent-mesh-peer-dashboard/v1",
      channels: [
        {
          id: "peer-channel-1",
          kind: "repository",
          label: "Runtime coordination",
          status: "open",
          wakePolicy: "coordination",
          policyVersion: 2,
          messageCount: 4,
          byteCount: 512,
          repoPath: "/private/repository",
          messageBody: "must never appear",
        },
      ],
      members: [
        {
          id: "peer-member-1",
          channelId: "peer-channel-1",
          agentId: "traffic-agent-1",
          generation: 1,
          status: "active",
          role: "reviewer",
          capability: "peer-secret",
        },
      ],
      deliveries: 1,
      wakes: [
        {
          id: "peer-wake-1",
          channelId: "peer-channel-1",
          recipientMemberId: "peer-member-1",
          state: "pending",
          messageCount: 1,
          policyVersion: 2,
        },
      ],
    }),
    ...overrides,
  };
}

async function start(
  options: {
    sources?: DashboardSnapshotSources;
    sseKeepAliveMs?: number;
  } = {},
): Promise<{ dashboard: DashboardHandle; token: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "mesh-dashboard-"));
  cleanupPaths.push(root);
  const dashboard = await startDashboard({
    sources: options.sources ?? snapshotSources(),
    tokenFile: join(root, "dashboard.token"),
    sseKeepAliveMs: options.sseKeepAliveMs,
  });
  dashboards.push(dashboard);
  const token = (await readFile(dashboard.tokenFile, "utf8")).trim();
  return { dashboard, token, root };
}

function authorization(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function exchangeBootstrapCode(
  dashboard: DashboardHandle,
): Promise<{ cookie: string; response: Response }> {
  const response = await fetch(dashboard.bootstrapUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: dashboard.origin,
    },
    body: new URLSearchParams({ code: dashboard.bootstrapCode }).toString(),
    redirect: "manual",
  });
  const setCookie = response.headers.get("set-cookie") ?? "";
  return {
    cookie: setCookie.split(";", 1)[0] ?? "",
    response,
  };
}

function rawGet(
  dashboard: DashboardHandle,
  path: string,
  token: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const outgoing = request(
      {
        host: dashboard.host,
        port: dashboard.port,
        path,
        method: "GET",
        headers: authorization(token),
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("end", () =>
          resolvePromise({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

describe("dashboard authentication and binding", () => {
  it("binds only to loopback and writes a private random bearer token", async () => {
    const { dashboard, token } = await start();
    expect(dashboard.host).toBe("127.0.0.1");
    expect(dashboard.server.address()).toMatchObject({
      address: "127.0.0.1",
      port: dashboard.port,
    });
    expect(token).toMatch(/^meshd_[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThan(40);
    expect((await stat(dashboard.tokenFile)).mode & 0o777).toBe(
      process.platform === "win32" ? 0o666 : 0o600,
    );
    expect(() =>
      new ControlDashboard({
        sources: snapshotSources(),
        host: "0.0.0.0" as "127.0.0.1",
      }),
    ).toThrow(/loopback-only/);
  });

  it("safely replaces a stale token file owned by a closed dashboard", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-dashboard-restart-"));
    cleanupPaths.push(root);
    const tokenFile = join(root, "dashboard.token");
    const first = await startDashboard({
      sources: snapshotSources(),
      tokenFile,
      removeTokenFileOnClose: false,
    });
    dashboards.push(first);
    const firstToken = (await readFile(tokenFile, "utf8")).trim();
    await expect(
      startDashboard({
        sources: snapshotSources(),
        tokenFile,
      }),
    ).rejects.toThrow(/owned by an active dashboard/);
    expect((await readFile(tokenFile, "utf8")).trim()).toBe(firstToken);

    await first.close();
    expect((await readFile(tokenFile, "utf8")).trim()).toBe(firstToken);

    const replacement = await startDashboard({
      sources: snapshotSources(),
      tokenFile,
    });
    dashboards.push(replacement);
    const replacementToken = (await readFile(tokenFile, "utf8")).trim();
    expect(replacementToken).toMatch(/^meshd_[A-Za-z0-9_-]+$/);
    expect(replacementToken).not.toBe(firstToken);
    expect(
      await fetch(`${replacement.origin}${DASHBOARD_API_PATHS.tasks}`, {
        headers: authorization(replacementToken),
      }),
    ).toMatchObject({ status: 200 });
  });

  it("requires the bearer header and never accepts query-string credentials", async () => {
    const { dashboard, token } = await start();
    const missing = await fetch(`${dashboard.origin}${DASHBOARD_API_PATHS.tasks}`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");

    const wrong = await fetch(`${dashboard.origin}${DASHBOARD_API_PATHS.tasks}`, {
      headers: authorization("wrong-token-value"),
    });
    expect(wrong.status).toBe(401);

    const query = await fetch(
      `${dashboard.origin}${DASHBOARD_API_PATHS.tasks}?token=${encodeURIComponent(token)}`,
    );
    expect(query.status).toBe(400);

    const allowed = await fetch(
      `${dashboard.origin}${DASHBOARD_API_PATHS.tasks}`,
      { headers: authorization(token) },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
  });

  it("exchanges a one-time body code for an HttpOnly cookie", async () => {
    const { dashboard, token } = await start();
    expect(dashboard.bootstrapUrl).toBe(
      `${dashboard.origin}${DASHBOARD_API_PATHS.bootstrap}`,
    );
    expect(dashboard.bootstrapUrl).not.toContain(token);
    expect(dashboard.bootstrapUrl).not.toContain(dashboard.bootstrapCode);
    expect(Object.keys(dashboard)).not.toContain("bootstrapCode");

    const page = await fetch(dashboard.bootstrapUrl);
    const pageBody = await page.text();
    expect(page.status).toBe(200);
    expect(pageBody).toContain('method="post"');
    expect(pageBody).not.toContain(token);
    expect(pageBody).not.toContain(dashboard.bootstrapCode);

    const queryAttempt = await fetch(
      `${dashboard.bootstrapUrl}?code=${encodeURIComponent(
        dashboard.bootstrapCode,
      )}`,
    );
    expect(queryAttempt.status).toBe(400);

    const { cookie, response } = await exchangeBootstrapCode(dashboard);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain(
      `${DASHBOARD_SESSION_COOKIE}=`,
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(response.headers.get("set-cookie")).not.toContain(token);

    const cookieAccess = await fetch(
      `${dashboard.origin}${DASHBOARD_API_PATHS.tasks}`,
      { headers: { Cookie: cookie } },
    );
    expect(cookieAccess.status).toBe(200);

    const reused = await fetch(dashboard.bootstrapUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: dashboard.origin,
      },
      body: new URLSearchParams({ code: dashboard.bootstrapCode }).toString(),
      redirect: "manual",
    });
    expect(reused.status).toBe(410);
  });
});

describe("read-only safe snapshots", () => {
  it("serves dependency-injected snapshots without prompt, path, token, or answer data", async () => {
    const { dashboard, token } = await start();
    const tasksResponse = await fetch(
      `${dashboard.origin}${DASHBOARD_API_PATHS.tasks}`,
      { headers: authorization(token) },
    );
    const tasksBody = await tasksResponse.text();
    expect(tasksResponse.status).toBe(200);
    expect(tasksBody).toContain("task-1");
    expect(tasksBody).toContain("[REDACTED]");
    expect(tasksBody).not.toContain("sk-abcdefghijklmnop");
    expect(tasksBody).not.toContain("must never be exposed");
    expect(tasksBody).not.toContain("/private/result.json");

    const aggregate = await fetch(
      `${dashboard.origin}${DASHBOARD_API_PATHS.snapshot}`,
      { headers: authorization(token) },
    );
    const aggregateBody = await aggregate.text();
    expect(aggregate.status).toBe(200);
    expect(aggregateBody).toContain("Which database?");
    expect(aggregateBody).not.toContain("hidden answer");
    expect(aggregateBody).not.toContain("sha256:must-never-appear");
    expect(aggregateBody).not.toContain("private-worker.example.test");
    expect(aggregateBody).not.toContain("internal-alias");
    expect(aggregateBody).toContain("traffic-agent-1");
    expect(aggregateBody).toContain("safe-repo");
    expect(aggregateBody).not.toContain("private-controller-instance");
    expect(aggregateBody).not.toContain("sha256:traffic-secret");
    expect(aggregateBody).not.toContain("/private/traffic/worktree");
    expect(aggregateBody).not.toContain("traffic prompt must never appear");

    const trafficResponse = await fetch(
      `${dashboard.origin}${DASHBOARD_API_PATHS.traffic}`,
      { headers: authorization(token) },
    );
    const trafficBody = await trafficResponse.text();
    expect(trafficResponse.status).toBe(200);
    expect(trafficBody).toContain("mailbox-unverified");
    expect(trafficBody).not.toContain("ownerInstanceId");
    expect(trafficBody).not.toContain("cwd");

    const peersResponse = await fetch(
      `${dashboard.origin}${DASHBOARD_API_PATHS.peers}`,
      { headers: authorization(token) },
    );
    const peersBody = await peersResponse.text();
    expect(peersResponse.status).toBe(200);
    expect(peersBody).toContain("peer-channel-1");
    expect(peersBody).toContain("coordination");
    expect(peersBody).not.toContain("/private/repository");
    expect(peersBody).not.toContain("must never appear");
    expect(peersBody).not.toContain("peer-secret");
  });

  it("serves a versioned session contract instead of duplicating task rows", async () => {
    const { dashboard, token } = await start({
      sources: snapshotSources({
        sessions: () => [
          {
            id: "task-a",
            provider: "codex",
            sessionId: "session-1",
            description: "First task",
            status: "completed",
            createdAt: "2026-07-12T19:00:00.000Z",
            updatedAt: "2026-07-12T19:10:00.000Z",
            completedAt: "2026-07-12T19:10:00.000Z",
            cwd: "/private/project",
          },
          {
            id: "task-b",
            provider: "codex",
            sessionId: "session-1",
            description: "Current task",
            status: "running",
            createdAt: "2026-07-12T20:00:00.000Z",
            updatedAt: "2026-07-12T20:05:00.000Z",
            prompt: "never expose",
          },
          {
            id: "task-without-session",
            provider: "cursor",
            sessionId: null,
            status: "running",
          },
        ],
      }),
    });
    const response = await fetch(
      `${dashboard.origin}${DASHBOARD_API_PATHS.sessions}`,
      { headers: authorization(token) },
    );
    const body = (await response.json()) as {
      data: {
        protocol: string;
        sessions: Array<Record<string, unknown>>;
      };
    };
    expect(response.status).toBe(200);
    expect(body.data.protocol).toBe(DASHBOARD_SESSION_SNAPSHOT_PROTOCOL);
    expect(body.data.sessions).toEqual([
      {
        provider: "codex",
        sessionId: "session-1",
        name: "Current task",
        status: "running",
        taskCount: 2,
        createdAt: "2026-07-12T19:00:00.000Z",
        updatedAt: "2026-07-12T20:05:00.000Z",
        completedAt: "2026-07-12T19:10:00.000Z",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("task-a");
    expect(JSON.stringify(body)).not.toContain("/private/project");
    expect(JSON.stringify(body)).not.toContain("never expose");
  });

  it("has no HTTP mutation route and serves self-contained responsive HTML", async () => {
    const { dashboard, token } = await start();
    const mutation = await fetch(
      `${dashboard.origin}${DASHBOARD_API_PATHS.workers}`,
      {
        method: "POST",
        headers: authorization(token),
      },
    );
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get("allow")).toBe("GET, HEAD");

    const page = await fetch(`${dashboard.origin}/`, {
      headers: authorization(token),
    });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("Agent Mesh");
    expect(html).not.toMatch(/<(?:script|link)\b/iu);
    expect(html).not.toMatch(/(?:src|href)=["']https?:/iu);
    expect(html).not.toContain(token);
  });
});

describe("request target and SSE hardening", () => {
  it.each([
    "/%2e%2e/package.json",
    "/%252e%252e/package.json",
    "/api%2f..%2fpackage.json",
    "/api\\..\\package.json",
  ])("rejects traversal target %s", async (path) => {
    const { dashboard, token } = await start();
    const response = await rawGet(dashboard, path, token);
    expect(response.status).toBe(400);
    expect(response.body).not.toContain("agent-mesh-mcp");
  });

  it("streams cookie-authenticated, sanitized progress over SSE", async () => {
    const { dashboard } = await start({ sseKeepAliveMs: 1_000 });
    const { cookie } = await exchangeBootstrapCode(dashboard);
    const body = await new Promise<string>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for SSE progress.")),
        2_000,
      );
      const outgoing = request(
        {
          host: dashboard.host,
          port: dashboard.port,
          path: DASHBOARD_API_PATHS.progress,
          method: "GET",
          headers: { Cookie: cookie },
        },
        (response) => {
          expect(response.statusCode).toBe(200);
          expect(response.headers["content-type"]).toContain("text/event-stream");
          response.setEncoding("utf8");
          let content = "";
          let published = false;
          response.on("data", (chunk: string) => {
            content += chunk;
            if (!published && content.includes("event: ready")) {
              published = true;
              dashboard.publishProgress({
                type: "task_status",
                taskId: "task-1",
                status: "running",
                message: "authorization=ghp_abcdefghijklmnop",
                progress: 0.5,
              });
            }
            if (content.includes("event: progress")) {
              clearTimeout(timeout);
              response.destroy();
              outgoing.destroy();
              resolvePromise(content);
            }
          });
        },
      );
      outgoing.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      outgoing.end();
    });

    expect(body).toContain("event: ready");
    expect(body).toContain("event: progress");
    expect(body).toContain('"taskId":"task-1"');
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain("ghp_abcdefghijklmnop");
  });
});
