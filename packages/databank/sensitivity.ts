/** Rule-only sensitivity classification. No network or model calls. */
export const SENSITIVITIES = ["public", "personal", "private", "secret", "clinical", "child"] as const;
export type Sensitivity = typeof SENSITIVITIES[number];
export const SENSITIVITY_SQL = SENSITIVITIES.map(s => `'${s}'`).join(",");

export function isSensitivity(value: unknown): value is Sensitivity {
  return typeof value === "string" && (SENSITIVITIES as readonly string[]).includes(value);
}

interface ClassificationInput {
  source: string;
  title: string;
  path?: string;
  text?: string;
  sensitivity?: Sensitivity;
  meta?: Record<string, unknown>;
}

// Priority order from §4.4. Migration supplies names/paths/source only (§5).
const SECRET_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["credentials", /password|passwd/i],
  ["ssn-ein", /(?:^|[^a-z0-9])(?:ssn|ein)(?:$|[^a-z0-9])|\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b|social[\s_-]*security[\s_-]*(?:number|card)|employer[\s_-]*identification[\s_-]*number/i],
  ["tax-return", /(?:^|[^a-z0-9])(?:1040(?:[ -]?sr)?|w[\s_-]?[29])(?:$|[^a-z0-9])|tax[\s_-]*return/i],
  ["insurance-card", /insurance[\s_-]*card|(?:member|subscriber|policy|group)[\s_-]*(?:id|number|no\.?)[\s:#_-]*\S+/i],
];

// Explicit source/path allowlist for the child collections named in §4.4.
const CHILD_SOURCES = new Set(["youtube-kids", "mana-youtube-kids", "school-forms"]);
const CHILD_PATH = /(?:^|\/)(?:youtube[ _-]*kids|school[ _-]*forms)(?:\/|$)|(?:^|\/)mana(?:\/|[ _-])(?:youtube[ _-]*kids|school[ _-]*forms)(?:\/|$)/i;

export function classifySensitivity(input: ClassificationInput): { sensitivity: Sensitivity; rule: string } {
  const hint = input.sensitivity ?? input.meta?.sensitivity;
  if (hint !== undefined && !isSensitivity(hint)) throw new Error("invalid sensitivity");
  const fields = [input.title, input.path ?? "", input.text ?? ""];
  for (const [rule, pattern] of SECRET_RULES) {
    if (fields.some(field => pattern.test(field))) return { sensitivity: "secret", rule };
  }
  if (hint === "secret") return { sensitivity: hint, rule: "hint" };
  // Hints cannot downgrade the source rule for Gwen's archive.
  if (input.source === "gwen-messenger") {
    return { sensitivity: hint === "clinical" || hint === "child" ? hint : "private", rule: "gwen-messenger" };
  }
  if (CHILD_SOURCES.has(input.source) || CHILD_PATH.test((input.path ?? "").replace(/\\/g, "/"))) {
    return { sensitivity: "child", rule: "child-collection" };
  }
  if (hint !== undefined) return { sensitivity: hint as Sensitivity, rule: "hint" };
  return { sensitivity: "personal", rule: "default" };
}
