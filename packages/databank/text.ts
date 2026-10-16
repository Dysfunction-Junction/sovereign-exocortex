/**
 * @file text.ts
 * Chunking, file-kind detection and text extraction. Extraction is fail-soft: a file that
 * cannot be read as text still gets indexed by its name, path and date.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, basename, dirname } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type ItemKind = "memory" | "document" | "photo" | "video" | "audio" | "text" | "other";

const EXT_KIND: Record<string, ItemKind> = {
  jpg: "photo", jpeg: "photo", png: "photo", gif: "photo", heic: "photo", webp: "photo", bmp: "photo", tif: "photo", tiff: "photo",
  mp4: "video", mov: "video", avi: "video", mkv: "video", mpg: "video", mpeg: "video", wmv: "video", "3gp": "video", m4v: "video", webm: "video",
  mp3: "audio", m4a: "audio", wav: "audio", flac: "audio", ogg: "audio", aac: "audio",
  pdf: "document", doc: "document", docx: "document", xls: "document", xlsx: "document", ppt: "document", pptx: "document", odt: "document", rtf: "document",
  txt: "text", md: "text", csv: "text", json: "text", html: "text", htm: "text", log: "text", xml: "text",
};

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", heic: "image/heic", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo", mkv: "video/x-matroska", mpg: "video/mpeg", wmv: "video/x-ms-wmv",
  mp3: "audio/mpeg", wav: "audio/wav", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv",
  json: "application/json", html: "text/html", htm: "text/html",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function extOf(path: string): string {
  return extname(path).slice(1).toLowerCase();
}

export function kindOf(path: string): ItemKind {
  return EXT_KIND[extOf(path)] ?? "other";
}

export function mimeOf(path: string): string {
  return EXT_MIME[extOf(path)] ?? "application/octet-stream";
}

const MAX_EXTRACT_BYTES = 50 * 1024 * 1024;
const MAX_CHUNKS_PER_ITEM = 400;

/** Plain-text view of a file for indexing. Empty string when nothing can be extracted. */
export async function extractText(path: string, size: number): Promise<string> {
  const ext = extOf(path);
  const kind = kindOf(path);
  if (size > MAX_EXTRACT_BYTES && kind !== "document") return "";
  try {
    if (kind === "text") {
      const raw = await readFile(path, "utf8");
      return ext === "html" || ext === "htm" || ext === "xml" ? stripTags(raw) : raw;
    }
    if (ext === "pdf") {
      const { stdout } = await execFileP("pdftotext", ["-q", "-enc", "UTF-8", path, "-"], {
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
      });
      return stdout;
    }
    if (ext === "docx") {
      const { stdout } = await execFileP("unzip", ["-p", path, "word/document.xml"], {
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30_000,
      });
      return stripTags(stdout.replace(/<\/w:p>/g, "\n"));
    }
  } catch {
    return "";
  }
  return "";
}

function stripTags(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n");
}

/** Searchable description for media/other files: name and folder words plus the date. */
export function describeFile(relPath: string, kind: ItemKind, ts: number): string {
  const words = (s: string): string => s.replace(/[_\-.\\/]+/g, " ").replace(/\s+/g, " ").trim();
  const name = words(basename(relPath, extname(relPath)));
  const dir = words(dirname(relPath) === "." ? "" : dirname(relPath));
  const date = new Date(ts).toISOString().slice(0, 10);
  return `${kind} ${name}. folder: ${dir}. date: ${date}`.trim();
}

export interface ChunkOptions {
  target?: number;
  overlap?: number;
}

/** Paragraph-aware chunks of about `target` chars, carrying `overlap` chars of context. */
export function chunkText(text: string, { target = 800, overlap = 100 }: ChunkOptions = {}): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length === 0) return [];
  if (clean.length <= target) return [clean];

  const pieces: string[] = [];
  for (const para of clean.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= target) {
      pieces.push(p);
      continue;
    }
    // Long paragraph: split on sentence ends, then hard-wrap anything still too long.
    let cur = "";
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if ((cur + " " + sentence).trim().length > target && cur) {
        pieces.push(cur.trim());
        cur = "";
      }
      let s = sentence;
      while (s.length > target) {
        pieces.push(s.slice(0, target));
        s = s.slice(target);
      }
      cur = (cur + " " + s).trim();
    }
    if (cur) pieces.push(cur.trim());
  }

  const chunks: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur && cur.length + 1 + piece.length > target) {
      chunks.push(cur);
      const tail = cur.slice(-overlap);
      cur = tail ? `${tail} ${piece}` : piece;
    } else {
      cur = cur ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.slice(0, MAX_CHUNKS_PER_ITEM);
}
