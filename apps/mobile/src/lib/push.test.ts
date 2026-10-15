vi.mock("./proposals", () => ({
  proposalManager: {
    get: vi.fn(),
    labelWanted: vi.fn(),
    labelNotWanted: vi.fn(),
  },
}));
import { describe, it, expect, vi, beforeEach } from "vitest";

type Handler = (arg: any) => void;
const handlers: Record<string, Handler> = {};

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: {
    addListener: vi.fn(async (name: string, fn: Handler) => {
      handlers[name] = fn;
      return { remove: vi.fn() };
    }),
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    register: vi.fn(),
  },
}));
vi.mock("./api", () => ({ postPushToken: vi.fn() }));

import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import * as api from "./api";
import { registerPush, isProposalPush, __resetPushState } from "./push";

beforeEach(() => {
  vi.clearAllMocks();
  __resetPushState();
  for (const k of Object.keys(handlers)) delete handlers[k];
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  vi.mocked(PushNotifications.checkPermissions).mockResolvedValue({ receive: "granted" });
  vi.mocked(PushNotifications.register).mockResolvedValue(undefined);
  vi.mocked(api.postPushToken).mockResolvedValue(undefined);
});

describe("push (P6b)", () => {
  it("does nothing on web", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await registerPush(vi.fn());
    expect(PushNotifications.register).not.toHaveBeenCalled();
  });

  it("requests permission when prompted, registers, and posts the FCM token once", async () => {
    vi.mocked(PushNotifications.checkPermissions).mockResolvedValue({ receive: "prompt" });
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({ receive: "granted" });
    await registerPush(vi.fn());
    expect(PushNotifications.requestPermissions).toHaveBeenCalled();
    expect(PushNotifications.register).toHaveBeenCalled();
    handlers.registration({ value: "fcm-token" });
    handlers.registration({ value: "fcm-token" });
    await Promise.resolve();
    await Promise.resolve();
    expect(api.postPushToken).toHaveBeenCalledTimes(1);
    expect(api.postPushToken).toHaveBeenCalledWith("fcm-token");
  });

  it("does not register when permission is denied", async () => {
    vi.mocked(PushNotifications.checkPermissions).mockResolvedValue({ receive: "denied" });
    await registerPush(vi.fn());
    expect(PushNotifications.register).not.toHaveBeenCalled();
  });

  it("triggers an immediate poll for a foreground {type:'proposal'} message only", async () => {
    const onProposal = vi.fn();
    await registerPush(onProposal);
    handlers.pushNotificationReceived({ data: { type: "other" } });
    expect(onProposal).not.toHaveBeenCalled();
    handlers.pushNotificationReceived({ data: { type: "proposal", proposal_id: "p1" } });
    expect(onProposal).toHaveBeenCalledTimes(1);
    handlers.pushNotificationActionPerformed({ notification: { data: { type: "proposal", proposal_id: "p1" } } });
    expect(onProposal).toHaveBeenCalledTimes(2);
  });

  it("retries a failed token upload on the next registerPush()", async () => {
    vi.mocked(api.postPushToken).mockRejectedValueOnce(new Error("offline"));
    await registerPush(vi.fn());
    handlers.registration({ value: "tok" });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.postPushToken).toHaveBeenCalledTimes(1);
    await registerPush(vi.fn());
    expect(api.postPushToken).toHaveBeenCalledTimes(2);
  });

  it("swallows FCM-unconfigured failures", async () => {
    vi.mocked(PushNotifications.register).mockRejectedValue(new Error("Default FirebaseApp is not initialized"));
    await expect(registerPush(vi.fn())).resolves.toBeUndefined();
  });

  it("isProposalPush validates the payload type", () => {
    expect(isProposalPush({ type: "proposal" })).toBe(true);
    expect(isProposalPush({ type: "x" })).toBe(false);
    expect(isProposalPush(undefined)).toBe(false);
  });

  it("triggers labelWanted or labelNotWanted on notification quick action", async () => {
    const { proposalManager } = await import("./proposals");
    const onProposal = vi.fn();
    await registerPush(onProposal);

    handlers.pushNotificationActionPerformed({
      actionId: "wanted",
      notification: { data: { type: "proposal", proposal_id: "p_quick_1" } },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(proposalManager.labelWanted).toHaveBeenCalledWith("p_quick_1");
    expect(onProposal).toHaveBeenCalled();

    handlers.pushNotificationActionPerformed({
      actionId: "not_wanted",
      notification: { data: { type: "proposal", proposal_id: "p_quick_2" } },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(proposalManager.labelNotWanted).toHaveBeenCalledWith("p_quick_2", expect.any(String));
  });
});
