import { describe, expect, it } from "vitest";
import { calmLinkAlpha, hideDetails, isDetailType, loadHideDocs, saveHideDocs, shouldShowLabel } from "./brainView";

const nodes = [
  { id: "p1", type: "PERSON" },
  { id: "proj", type: "PROJECT" },
  { id: "d1", type: "DOC" },
  { id: "t1", type: "topic" },
  { id: "dev", type: "DEVICE" },
];
const links = [
  { sourceId: "p1", targetId: "proj" },
  { sourceId: "p1", targetId: "d1" },
  { sourceId: "t1", targetId: "proj" },
  { sourceId: "dev", targetId: "p1" },
];

describe("hideDetails", () => {
  it("removes documents and topics and every link touching them", () => {
    const out = hideDetails(nodes, links);
    expect(out.nodes.map((n) => n.id)).toEqual(["p1", "proj", "dev"]);
    expect(out.links).toEqual([
      { sourceId: "p1", targetId: "proj" },
      { sourceId: "dev", targetId: "p1" },
    ]);
  });
  it("is the identity when there are no details", () => {
    expect(hideDetails([nodes[0]!], [])).toEqual({ nodes: [nodes[0]], links: [] });
  });
});

describe("label rule", () => {
  it("always labels people and projects", () => {
    for (const role of [null, "inhibited", "hop2", "hop1", "initiator"] as const) {
      expect(shouldShowLabel("PERSON", role)).toBe(true);
      expect(shouldShowLabel("project", role)).toBe(true);
    }
  });
  it("labels documents and topics only for the selected node and its hop1 neighbors", () => {
    expect(shouldShowLabel("DOC", null)).toBe(false);
    expect(shouldShowLabel("DOC", "inhibited")).toBe(false);
    expect(shouldShowLabel("TOPIC", "hop2")).toBe(false);
    expect(shouldShowLabel("DOC", "hop1")).toBe(true);
    expect(shouldShowLabel("TOPIC", "initiator")).toBe(true);
  });
});

describe("calm links and detail types", () => {
  it("uses alpha 0.10 for links touching a document or topic and 0.25 otherwise", () => {
    expect(calmLinkAlpha("DOC", "PERSON")).toBe(0.1);
    expect(calmLinkAlpha("PERSON", "TOPIC")).toBe(0.1);
    expect(calmLinkAlpha("PERSON", "PROJECT")).toBe(0.25);
    expect(calmLinkAlpha(undefined, undefined)).toBe(0.25);
  });
  it("classifies detail types case-insensitively", () => {
    expect(isDetailType("doc")).toBe(true);
    expect(isDetailType("Topic")).toBe(true);
    expect(isDetailType("PERSON")).toBe(false);
  });
});

describe("hide-documents persistence", () => {
  it("round-trips and survives a storage that throws", () => {
    const mem = new Map<string, string>();
    const ok = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(loadHideDocs(ok)).toBe(false);
    saveHideDocs(true, ok);
    expect(loadHideDocs(ok)).toBe(true);
    saveHideDocs(false, ok);
    expect(loadHideDocs(ok)).toBe(false);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadHideDocs(broken)).toBe(false);
    expect(() => saveHideDocs(true, broken)).not.toThrow();
  });
});
