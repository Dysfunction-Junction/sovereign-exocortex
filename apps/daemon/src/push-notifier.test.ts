import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PushNotifier } from "./push-notifier.js";
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ACCOUNT = JSON.stringify({ client_email: "svc@example.iam", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });

function make(tokens: Array<{ device_id: string; token: string }>, statuses: number[]) {
  const sent: any[] = [];
  const deleted: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: any) => {
    if (String(url).includes("oauth")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    sent.push(JSON.parse(init.body).message);
    const status = statuses[i++] ?? 200;
    return new Response(status === 200 ? "{}" : "UNREGISTERED", { status });
  }) as unknown as typeof fetch;
  const notifier = new PushNotifier({
    getDb: () => ({ listActivePushTokens: () => tokens, deleteDevicePushToken: (d: string) => deleted.push(d) }) as never,
    env: { FCM_PROJECT_ID: "proj", GOOGLE_APPLICATION_CREDENTIALS: "x.json" } as never,
    readFile: () => ACCOUNT,
    fetchImpl,
    log: () => {},
  });
  return { notifier, sent, deleted };
}

describe("PushNotifier.sendNotice", () => {
  it("sends the given text to every registered device with no proposal attached", async () => {
    const { notifier, sent } = make([{ device_id: "a", token: "t1" }, { device_id: "b", token: "t2" }], []);
    const r = await notifier.sendNotice("Title", "Body text");
    assert.equal(r.sent, 2);
    assert.deepEqual(sent[0].notification, { title: "Title", body: "Body text" });
    assert.equal(sent[0].data.type, "notice");
    assert.equal(sent[0].data.proposal_id, undefined);
  });

  it("reports zero sent when there are no registered devices", async () => {
    const { notifier } = make([], []);
    assert.equal((await notifier.sendNotice("T", "B")).sent, 0);
  });

  it("drops a token FCM says is no longer registered", async () => {
    const { notifier, deleted } = make([{ device_id: "a", token: "t1" }], [404]);
    const r = await notifier.sendNotice("T", "B");
    assert.equal(r.sent, 0);
    assert.deepEqual(deleted, ["a"]);
  });
});
