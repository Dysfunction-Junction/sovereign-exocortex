/**
 * @file archive.ts
 * Moves old LocalLTM entries (memories.jsonl) into the databank. Entries stay searchable
 * from the databank; with `prune` they are removed from the hot file after a timestamped
 * backup is written. Malformed lines are never touched.
 */

import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import type { Databank } from "./databank.js";

interface MemoryLine {
  title?: unknown;
  body?: unknown;
  createdAt?: unknown;
  source?: unknown;
  tags?: unknown;
}

export interface ArchiveResult {
  scanned: number;
  archived: number;
  alreadyArchived: number;
  kept: number;
  pruned: boolean;
  backup?: string;
}

export async function archiveMemories(
  bank: Databank,
  file: string,
  opts: { olderThanDays: number; prune?: boolean; now?: number },
): Promise<ArchiveResult> {
  const now = opts.now ?? Date.now();
  const cutoff = now - opts.olderThanDays * 86_400_000;
  const raw = await readFile(file, "utf8");
  const lines = raw.split("\n");
  const keep: string[] = [];
  const res: ArchiveResult = { scanned: 0, archived: 0, alreadyArchived: 0, kept: 0, pruned: false };

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: MemoryLine | null = null;
    try {
      entry = JSON.parse(line) as MemoryLine;
    } catch {
      keep.push(line);
      continue;
    }
    res.scanned++;
    const created = typeof entry.createdAt === "string" ? Date.parse(entry.createdAt) : NaN;
    if (typeof entry.body !== "string" || !Number.isFinite(created) || created > cutoff) {
      keep.push(line);
      continue;
    }
    const title = typeof entry.title === "string" ? entry.title : "memory";
    const r = await bank.ingestText({
      source: typeof entry.source === "string" ? entry.source : "ltm",
      kind: "memory",
      title,
      text: `${title}\n\n${entry.body}`,
      path: `ltm/${entry.createdAt as string}`,
      ts: created,
      mime: "text/plain",
      meta: { tags: Array.isArray(entry.tags) ? entry.tags : [] },
    });
    if (r.existed) res.alreadyArchived++;
    else res.archived++;
  }
  res.kept = keep.length;

  if (opts.prune) {
    // Only prune what the databank now holds: ingest above either wrote or found each entry.
    const backup = `${file}.pre-prune-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(file, backup);
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, keep.length ? keep.join("\n") + "\n" : "");
    await rename(tmp, file);
    res.pruned = true;
    res.backup = backup;
  }
  return res;
}
