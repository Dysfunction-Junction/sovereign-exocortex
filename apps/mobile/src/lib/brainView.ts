// Pure rules for how the Living Brain is drawn. Kept out of the component so they can be tested without WebGL.

import type { LabelRole } from "./graphLabel";

/** Documents and topics are details around the people and projects. */
export function isDetailType(type: string): boolean {
  const t = type.toUpperCase();
  return t === "DOC" || t === "TOPIC";
}

/** People and projects are always labelled; everything else only on the selected node and its 1-hop neighbors. */
export function shouldShowLabel(type: string, role: LabelRole | null): boolean {
  const t = type.toUpperCase();
  if (t === "PERSON" || t === "PROJECT") return true;
  return role === "initiator" || role === "hop1";
}

/** Link alpha when nothing is selected: links touching a document or topic are fainter. */
export function calmLinkAlpha(sourceType: string | undefined, targetType: string | undefined): number {
  return (sourceType && isDetailType(sourceType)) || (targetType && isDetailType(targetType)) ? 0.1 : 0.25;
}

/** Drops document and topic nodes and every link that touches a removed node. */
export function hideDetails<N extends { id: string; type: string }, L extends { sourceId: string; targetId: string }>(
  nodes: N[],
  links: L[],
): { nodes: N[]; links: L[] } {
  const kept = nodes.filter((n) => !isDetailType(n.type));
  const ids = new Set(kept.map((n) => n.id));
  return { nodes: kept, links: links.filter((l) => ids.has(l.sourceId) && ids.has(l.targetId)) };
}

export const HIDE_DOCS_KEY = "brain.hideDocs";

export function loadHideDocs(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): boolean {
  try {
    return storage?.getItem(HIDE_DOCS_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveHideDocs(value: boolean, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(HIDE_DOCS_KEY, value ? "1" : "0");
  } catch {
    // Not persisted; the toggle still works for this session.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
