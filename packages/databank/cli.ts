#!/usr/bin/env tsx
/**
 * databank CLI. Environment:
 *   DATABANK_ROOT      mounted vault (default /mnt/databank)
 *   DATABANK_KEY_FILE  master key file (32 bytes: hex/base64/raw)
 *   DATABANK_TOKEN     bearer token for `serve`
 *   DATABANK_HOST/PORT serve bind (default 127.0.0.1:8790)
 *   EXOCORTEX_EMBED_URL embedder (default llama.cpp http://127.0.0.1:8081; EXOCORTEX_EMBED_BACKEND=ollama uses OLLAMA_URL); EXOCORTEX_EMBEDDINGS=0 disables
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { LocalEmbedder } from "@exocortex/memory/embeddings";
import { Databank, type Embedder, type TextInput } from "./databank.js";
import { archiveMemories } from "./archive.js";
import { DatabankKeys } from "./crypto.js";
import { createDatabankServer } from "./server.js";
import type { ItemKind } from "./text.js";
import { parseTakeoutLocationPath } from "./parsers/takeout-location.js";
import { parseJoinSmsPath } from "./parsers/join-sms.js";
import { parseHealthConnectPath } from "./parsers/health-connect.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const VALUE_FLAGS = new Set(["--source", "--older-than-days", "--kind", "--k", "--limit", "--device"]);
const positional: string[] = [];
for (let i = 1; i < argv.length; i++) {
  if (VALUE_FLAGS.has(argv[i])) i++;
  else if (!argv[i].startsWith("--")) positional.push(argv[i]);
}

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const has = (name: string): boolean => argv.includes(`--${name}`);

function open(): Databank {
  const root = process.env.DATABANK_ROOT ?? "/mnt/databank";
  const keyFile = process.env.DATABANK_KEY_FILE;
  if (!keyFile) throw new Error("DATABANK_KEY_FILE is not set");
  const embedder: Embedder | null =
    process.env.EXOCORTEX_EMBEDDINGS === "0" ? null : (new LocalEmbedder() as unknown as Embedder);
  return Databank.open({ root, keys: DatabankKeys.fromFile(keyFile), embedder });
}

async function runIngest(label: string, parseFn: () => Promise<TextInput[]>): Promise<void> {
  const items = await parseFn();
  const bank = open();
  try {
    let newItems = 0;
    let existing = 0;
    for (const item of items) {
      const res = await bank.ingestText(item);
      if (res.existed) existing++;
      else newItems++;
    }
    console.log(JSON.stringify({ label, total: items.length, newItems, existing }));
  } finally {
    bank.close();
  }
}

async function main(): Promise<void> {
  switch (cmd) {
    case "keygen": {
      const out = positional[0];
      if (!out) throw new Error("usage: keygen <file>");
      if (existsSync(out)) throw new Error(`${out} already exists; refusing to overwrite a key`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, DatabankKeys.generate().toString("hex") + "\n", { mode: 0o600, flag: "wx" });
      console.log(`wrote ${out}. Back it up somewhere other than the vault: without it the blobs are unrecoverable.`);
      return;
    }
    case "ingest-dir": {
      const dir = positional[0];
      if (!dir) throw new Error("usage: ingest-dir <dir> --source <name>");
      const bank = open();
      try {
        let last = 0;
        const s = await bank.ingestDir(dir, {
          source: flag("source") ?? "import",
          onProgress: (p) => {
            if (p.files - last >= 50) {
              last = p.files;
              console.log(`${p.files} files (${p.newItems} new, ${p.existing} existing, ${p.failed.length} failed)`);
            }
          },
        });
        console.log(JSON.stringify({ files: s.files, newItems: s.newItems, existing: s.existing, failed: s.failed.length }));
        for (const f of s.failed.slice(0, 20)) console.error(`FAILED ${f.path}: ${f.error}`);
      } finally {
        bank.close();
      }
      return;
    }
    case "ingest-takeout": {
      const target = positional[0];
      if (!target) throw new Error("usage: ingest-takeout <path> [--device <device>]");
      await runIngest("takeout", () => parseTakeoutLocationPath(target, { device: flag("device") }));
      return;
    }
    case "ingest-sms": {
      const target = positional[0];
      if (!target) throw new Error("usage: ingest-sms <path> [--device <device>]");
      await runIngest("sms", () => parseJoinSmsPath(target, { device: flag("device") }));
      return;
    }
    case "ingest-health": {
      const target = positional[0];
      if (!target) throw new Error("usage: ingest-health <path> [--device <device>]");
      await runIngest("health", () => parseHealthConnectPath(target, { device: flag("device") }));
      return;
    }
    case "archive-memories": {
      const file = positional[0] ?? process.env.LOCAL_LTM_FILE;
      if (!file) throw new Error("usage: archive-memories <memories.jsonl> --older-than-days N");
      const bank = open();
      try {
        console.log(JSON.stringify(await archiveMemories(bank, file, { olderThanDays: Number(flag("older-than-days") ?? 90) })));
      } finally {
        bank.close();
      }
      return;
    }
    case "search": {
      const q = positional.join(" ");
      if (!q) throw new Error("usage: search <query> [--kind photo] [--k 10]");
      const bank = open();
      try {
        const hits = await bank.search(q, { k: Number(flag("k") ?? 10), kind: flag("kind") as ItemKind | undefined });
        for (const h of hits) console.log(`${h.score.toFixed(3)}  [${h.kind}] ${h.path || h.title}  (${h.via})\n    ${h.snippet.replace(/\s+/g, " ").slice(0, 140)}`);
      } finally {
        bank.close();
      }
      return;
    }
    case "reindex": {
      const bank = open();
      try {
        console.log(`embedded ${await bank.reindex()} chunks`);
      } finally {
        bank.close();
      }
      return;
    }
    case "stats": {
      const bank = open();
      try {
        console.log(JSON.stringify(bank.stats(), null, 2));
      } finally {
        bank.close();
      }
      return;
    }
    case "verify": {
      const bank = open();
      try {
        const log = bank.verifyLog();
        const blobs = await bank.verifyBlobs(flag("limit") ? Number(flag("limit")) : undefined);
        console.log(JSON.stringify({ log, blobsChecked: blobs.checked, badBlobs: blobs.bad }, null, 2));
        if (!log.ok || blobs.bad.length > 0) process.exitCode = 1;
      } finally {
        bank.close();
      }
      return;
    }
    case "serve": {
      const token = process.env.DATABANK_TOKEN;
      if (!token) throw new Error("DATABANK_TOKEN is not set");
      const bank = open();
      const host = process.env.DATABANK_HOST ?? "127.0.0.1";
      const port = Number(process.env.DATABANK_PORT ?? 8790);
      createDatabankServer(bank, { token }).listen(port, host, () => console.log(`databank listening on ${host}:${port}`));
      return;
    }
    default:
      console.log("commands: keygen <file> | ingest-dir <dir> --source <s> | ingest-takeout <path> [--device <dev>] | ingest-sms <path> [--device <dev>] | ingest-health <path> [--device <dev>] | archive-memories <file> --older-than-days N | search <q> | reindex | stats | verify [--limit N] | serve");
      process.exitCode = cmd ? 2 : 0;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
