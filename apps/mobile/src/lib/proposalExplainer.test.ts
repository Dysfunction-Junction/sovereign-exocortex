import { describe, it, expect } from "vitest";
import { explainProposal } from "./proposalExplainer";
import type { IncomingProposal } from "./proposals";

const base: IncomingProposal = {
  proposalId: "p1",
  candidateId: "c1",
  summary: "Restore Homeostasis: Clean test suite",
  riskLevel: "low",
  requiresBiometric: false,
  approvalNonce: "n",
  expiresAt: 0,
};

describe("explainProposal", () => {
  it("practice questions change nothing and only save the answer", () => {
    const e = explainProposal({ ...base, shadow: true });
    expect(e.changes).toMatch(/nothing/i);
    expect(e.saved).toMatch(/answer/i);
    expect(e.doesWhat).toMatch(/practice|learn/i);
  });

  it("a diagnostic probe is read-only", () => {
    const e = explainProposal({ ...base, actionPayload: { command: "diagnostic_probe", invariantId: "inv_clean_test_suite", maxHops: 2 } });
    expect(e.changes).toMatch(/nothing is changed|read-only|only looks/i);
    expect(e.doesWhat).toMatch(/your code's tests/i);
  });

  it("a self-heal restore says it will change something and names the area", () => {
    const e = explainProposal({ ...base, actionPayload: { command: "self_heal_restore", invariantId: "inv_bridge_connected" } });
    expect(e.changes).toMatch(/change/i);
    expect(e.doesWhat).toMatch(/link between your phone and PC/i);
  });

  it("an unknown action admits it cannot describe the change and tells the user to be careful", () => {
    const e = explainProposal({ ...base, actionPayload: { command: "mystery" } });
    expect(e.changes).toMatch(/not listed|cannot tell|only say yes if you recognise/i);
  });

  it("never exposes raw ids or internal names", () => {
    const e = explainProposal({ ...base, actionPayload: { command: "self_heal_restore", invariantId: "inv_zero_broken_commits", targetEntityId: "ent:abc123" } });
    const all = Object.values(e).join(" ");
    expect(all).not.toMatch(/inv_|ent:|self_heal|diagnostic_probe|homeostasis/i);
  });

  it("the title says in plain words what is being suggested, not the internal name", () => {
    const heal = explainProposal({ ...base, summary: "Restore Homeostasis: Mobile Sensorium WebSocket Connected", shadow: true, actionPayload: { command: "self_heal_restore", invariantId: "inv_bridge_connected" } });
    expect(heal.title).toMatch(/reconnect|fix|restore/i);
    expect(heal.title).toMatch(/phone and PC/i);
    expect(heal.title).not.toMatch(/homeostasis|websocket|sensorium/i);
    const probe = explainProposal({ ...base, summary: "Device approval test (read-only diagnostic probe)", actionPayload: { command: "diagnostic_probe" } });
    expect(probe.title).toMatch(/check|look/i);
    expect(probe.title).not.toMatch(/diagnostic|probe/i);
  });

  it("a practice question still spells out the specific suggestion being practised", () => {
    const e = explainProposal({ ...base, shadow: true, actionPayload: { command: "self_heal_restore", invariantId: "inv_bridge_connected" } });
    expect(e.doesWhat).toMatch(/link between your phone and PC/i);
    expect(e.doesWhat).toMatch(/practice/i);
  });

  it("an unknown suggestion gets a neutral title instead of leaking the raw summary", () => {
    const e = explainProposal({ ...base, summary: "Quiesce Epistemic Manifold", actionPayload: { command: "mystery" } });
    expect(e.title).not.toMatch(/quiesce|manifold/i);
  });

  it("high-risk or biometric proposals mention the fingerprint or face check", () => {
    const e = explainProposal({ ...base, riskLevel: "high", requiresBiometric: true, actionPayload: { command: "self_heal_restore" } });
    expect(e.saved).toMatch(/fingerprint or face/i);
  });
});
