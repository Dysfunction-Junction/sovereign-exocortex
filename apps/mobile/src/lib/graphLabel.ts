/**
 * Tooltip markup for the 3D graph. 3d-force-graph assigns the returned string to innerHTML, so
 * every untrusted value (name, type, color) is placed with textContent / style.setProperty on
 * real DOM nodes and the result is serialized, never concatenated into an HTML string.
 */

export interface LabelNode {
  name?: string;
  type?: string;
  color?: string;
  activation?: number;
}

export type LabelRole = "initiator" | "hop1" | "hop2" | "inhibited";

const ROLE_STYLE: Record<LabelRole, { text: string; color: string; weight: string; italic: boolean }> = {
  initiator: { text: "⚡ Active Initiator", color: "#38bdf8", weight: "700", italic: false },
  hop1: { text: "1-Hop Synaptic Partner", color: "#38bdf8", weight: "600", italic: false },
  hop2: { text: "2-Hop Cascade Leaf", color: "#a78bfa", weight: "600", italic: false },
  inhibited: { text: "Inhibited Peripheral", color: "#64748b", weight: "400", italic: true },
};

const SAFE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*){2,3}\))$/i;

function safeColor(color: string | undefined, fallback: string): string {
  return color && SAFE_COLOR.test(color.trim()) ? color.trim() : fallback;
}

function div(text: string | null, styles: Record<string, string>): HTMLDivElement {
  const el = document.createElement("div");
  if (text !== null) el.textContent = text;
  for (const [prop, value] of Object.entries(styles)) el.style.setProperty(prop, value);
  return el;
}

export function buildNodeLabel(node: LabelNode, role: LabelRole | null): string {
  const act = ((node.activation ?? 0) * 100).toFixed(0);

  const card = div(null, {
    background: "rgba(15, 20, 35, 0.94)",
    border: "1px solid rgba(255,255,255,0.15)",
    padding: "8px 12px",
    "border-radius": "8px",
    "font-family": "sans-serif",
    "box-shadow": "0 4px 20px rgba(0,0,0,0.6)",
  });

  card.append(div(node.name ?? "", { "font-weight": "700", color: "#ffffff", "font-size": "13px" }));
  card.append(
    div(node.type ?? "", {
      "font-size": "11px",
      color: safeColor(node.color, "#94a3b8"),
      "margin-top": "2px",
      "text-transform": "uppercase",
      "font-weight": "600",
    }),
  );

  if (role) {
    const r = ROLE_STYLE[role];
    card.append(
      div(r.text, {
        "font-size": "10px",
        color: r.color,
        "font-weight": r.weight,
        "margin-top": "2px",
        "text-transform": role === "inhibited" ? "none" : "uppercase",
        ...(r.italic ? { "font-style": "italic" } : {}),
      }),
    );
  }

  const activation = div("Activation: ", { "font-size": "11px", color: "#94a3b8", "margin-top": "4px" });
  const value = document.createElement("span");
  value.textContent = `${act}%`;
  value.style.setProperty("color", "#38bdf8");
  value.style.setProperty("font-weight", "700");
  activation.append(value);
  card.append(activation);

  return card.outerHTML;
}
