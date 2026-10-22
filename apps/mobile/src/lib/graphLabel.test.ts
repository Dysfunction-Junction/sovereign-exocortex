import { describe, it, expect } from "vitest";
import { buildNodeLabel } from "./graphLabel";

function parse(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

describe("buildNodeLabel", () => {
  it("renders an HTML payload in the node name as inert text", () => {
    const html = buildNodeLabel(
      { name: "<img src=x onerror=alert(1)>", type: "<script>boom()</script>", color: "#38bdf8", activation: 0.5 },
      null,
    );
    const dom = parse(html);
    expect(dom.querySelector("img")).toBeNull();
    expect(dom.querySelector("script")).toBeNull();
    expect(dom.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(dom.textContent).toContain("<script>boom()</script>");
  });

  it("shows the activation percentage", () => {
    const dom = parse(buildNodeLabel({ name: "n", type: "t", color: "#fff", activation: 0.426 }, null));
    expect(dom.textContent).toContain("Activation: 43%");
  });

  it("treats a missing activation as 0%", () => {
    const dom = parse(buildNodeLabel({ name: "n", type: "t" }, null));
    expect(dom.textContent).toContain("Activation: 0%");
  });

  it("rejects a color that tries to break out of the style attribute", () => {
    const html = buildNodeLabel(
      { name: "n", type: "t", color: 'red;background:url(//evil.example/x)" onmouseover="alert(1)' },
      null,
    );
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("onmouseover");
    const dom = parse(html);
    expect(dom.querySelector("[onmouseover]")).toBeNull();
  });

  it("accepts hex and rgb colors", () => {
    // jsdom normalizes hex to rgb(); 0xab,0xc1,0x23
    expect(buildNodeLabel({ name: "n", type: "t", color: "#abc123" }, null)).toContain("rgb(171, 193, 35)");
    expect(buildNodeLabel({ name: "n", type: "t", color: "rgb(1, 2, 3)" }, null)).toContain("rgb(1, 2, 3)");
  });

  it.each([
    ["initiator", "Active Initiator"],
    ["hop1", "1-Hop Synaptic Partner"],
    ["hop2", "2-Hop Cascade Leaf"],
    ["inhibited", "Inhibited Peripheral"],
  ] as const)("shows the %s role badge", (role, text) => {
    expect(parse(buildNodeLabel({ name: "n", type: "t" }, role)).textContent).toContain(text);
  });

  it("shows no role badge when nothing is selected", () => {
    const text = parse(buildNodeLabel({ name: "n", type: "t" }, null)).textContent ?? "";
    expect(text).not.toMatch(/Initiator|Partner|Leaf|Peripheral/);
  });
});
