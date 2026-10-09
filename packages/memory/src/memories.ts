/**
 * Distill raw PiecesOS capture into durable memories and append them to a local log.
 * The log is gitignored. Pieces materials are created only when explicitly enabled.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export const RECENT_CAPTURE_QUERY = "What have I been working on recently?";
export const DEFAULT_MEMORY_LOG = "data/memories.jsonl";
export const MAX_DISTILLED_MEMORIES = 12;

export interface DistilledMemory {
  title: string;
  body: string;
}

export interface LoggedMemory extends DistilledMemory {
  loggedAt: string;
  piecesSaved: boolean;
  piecesError?: string;
  eventCount: number;
}

export function buildMemoryPrompt(formattedNotes: string): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: [
      "You turn raw PiecesOS capture events into durable memories.",
      "Reply with a JSON array only. Each item is {\"title\":\"short factual title\",\"body\":\"one or two sentences of what happened\"}.",
      "Write one memory per distinct event. Merge exact duplicates.",
      "Keep the wording factual. Do not invent details that are not in the notes.",
      "If there are no notes, return [].",
    ].join(" "),
    userPrompt: [
      "Raw capture events:",
      formattedNotes.trim(),
      "",
      "Return the JSON array now.",
    ].join("\n"),
  };
}

export function parseDistilledMemories(answer: string): DistilledMemory[] {
  const start = answer.indexOf("[");
  const end = answer.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const memories: DistilledMemory[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const body = typeof record.body === "string" ? record.body.trim() : "";
    if (!title || !body) continue;
    if (title.length > 200 || body.length > 2000) continue;
    memories.push({ title, body });
    if (memories.length >= MAX_DISTILLED_MEMORIES) break;
  }
  return memories;
}

export async function appendMemoryLog(filePath: string, entry: LoggedMemory): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
}

export function formatPiecesMaterial(memory: DistilledMemory, loggedAt: string): string {
  return `${memory.title}\n\n${memory.body}\n\nLogged ${loggedAt} from local Pieces workstream capture.`;
}
