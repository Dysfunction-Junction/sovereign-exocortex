import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PhoneLinkWatchdog, type PhoneStatus } from "./phone-link-watchdog.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

function setup(overrides: { phones?: PhoneStatus[]; sent?: number } = {}) {
  let t = 1_000 * HOUR;
  let phones: PhoneStatus[] = overrides.phones ?? [{ deviceId: "p1", name: "S26 Ultra", lastSeenMs: t }];
  const notices: Array<{ title: string; body: string }> = [];
  const dog = new PhoneLinkWatchdog({
    listPhones: () => phones,
    notify: async (title, body) => {
      notices.push({ title, body });
      return { sent: overrides.sent ?? 1 };
    },
    now: () => t,
    log: () => {},
    silenceMs: 4 * HOUR,
    tickMs: MIN,
  });
  return {
    dog,
    notices,
    advance: (ms: number) => void (t += ms),
    now: () => t,
    setPhones: (p: PhoneStatus[]) => void (phones = p),
  };
}

/** Run one tick per minute for `ms`, the way the real interval does while the PC is awake. */
async function awake(s: ReturnType<typeof setup>, ms: number) {
  for (let i = 0; i < ms / MIN; i++) {
    s.advance(MIN);
    await s.dog.tick();
  }
}

describe("PhoneLinkWatchdog", () => {
  it("stays quiet while the phone keeps checking in", async () => {
    const s = setup();
    for (let i = 0; i < 10; i++) {
      await awake(s, HOUR);
      s.setPhones([{ deviceId: "p1", name: "S26 Ultra", lastSeenMs: s.now() }]);
    }
    assert.equal(s.notices.length, 0);
  });

  it("sends exactly one plain-English notice per silence episode", async () => {
    const s = setup();
    await awake(s, 10 * HOUR);
    assert.equal(s.notices.length, 1);
    assert.match(s.notices[0].title, /phone/i);
    assert.match(s.notices[0].body, /S26 Ultra/);
    assert.match(s.notices[0].body, /4 hours/);
    assert.doesNotMatch(s.notices[0].body, /websocket|homeostasis|invariant|inv_/i);
  });

  it("does not blame the phone for time the PC itself was asleep", async () => {
    const s = setup();
    await awake(s, 30 * MIN);
    s.advance(10 * HOUR); // PC suspended: no ticks fire
    await s.dog.tick(); // first tick after wake
    assert.equal(s.notices.length, 0);
    await awake(s, 3 * HOUR); // phone has had under 4 awake hours to check in
    assert.equal(s.notices.length, 0);
    await awake(s, 2 * HOUR); // now silent for over 4 awake hours
    assert.equal(s.notices.length, 1);
  });

  it("alerts again only after the phone has recovered and then gone silent again", async () => {
    const s = setup();
    await awake(s, 5 * HOUR);
    assert.equal(s.notices.length, 1);
    s.setPhones([{ deviceId: "p1", name: "S26 Ultra", lastSeenMs: s.now() }]);
    await awake(s, 3 * HOUR);
    assert.equal(s.notices.length, 1);
    await awake(s, 2 * HOUR);
    assert.equal(s.notices.length, 2);
  });

  it("retries next tick when the notice could not be delivered", async () => {
    const s = setup({ sent: 0 });
    await awake(s, 4 * HOUR + 3 * MIN);
    assert.ok(s.notices.length > 1);
  });

  it("ignores phones that went quiet more than a week ago", async () => {
    const s = setup({ phones: [{ deviceId: "old", name: "--", lastSeenMs: 1_000 * HOUR - 14 * 24 * HOUR }] });
    await awake(s, 6 * HOUR);
    assert.equal(s.notices.length, 0);
  });
});
