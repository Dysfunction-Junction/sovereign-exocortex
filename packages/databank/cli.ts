#!/usr/bin/env tsx
/**
 * databank CLI. Environment:
 *   DATABANK_ROOT      mounted vault (default /mnt/databank)
 *   DATABANK_KEY_FILE  master key file (32 bytes: hex/base64/raw)
 *   DATABANK_TOKEN     bearer token for `serve`
 *   DATABANK_HOST/PORT serve bind (default 127.0.0.1:8790)
 *   EXOCORTEX_EMBED_URL embedder (default llama.cpp http://127.0.0.1:8081; EXOCORTEX_EMBED_BACKEND=ollama uses OLLAMA_URL); EXOCORTEX_EMBEDDINGS=0 disables
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
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
import { parseContactsPath } from "./parsers/contacts.js";
import { parseFiHistoryPath, normalizePhoneNumber } from "./parsers/fi-history.js";
import { PeopleResolver } from "./people-resolver.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const VALUE_FLAGS = new Set(["--source", "--older-than-days", "--kind", "--k", "--limit", "--device", "--owner", "--seed", "--out"]);
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
    case "ingest-contacts": {
      const target = positional[0];
      if (!target) throw new Error("usage: ingest-contacts <path>");
      await runIngest("contacts", () => parseContactsPath(target, { source: flag("source") }));
      return;
    }
    case "ingest-fi": {
      const target = positional[0];
      if (!target) throw new Error("usage: ingest-fi <path> [--group-by month|day|record]");
      const groupByRaw = flag("group-by") ?? "month";
      if (!["month", "day", "record"].includes(groupByRaw)) {
        throw new Error(`invalid --group-by '${groupByRaw}'; valid options: month, day, record`);
      }
      const groupBy = groupByRaw as "month" | "day" | "record";
      const bank = open();
      try {
        const contactMap: Record<string, string> = {};
        try {
          const rows = bank.getItemsBySource("contacts");
          for (const r of rows) {
            if (!r.meta) continue;
            try {
              const m = JSON.parse(r.meta);
              const name = m.name || m.contact;
              if (name && Array.isArray(m.phones)) {
                for (const p of m.phones) {
                  const num = typeof p === "string" ? p : p?.number;
                  if (num) {
                    const np = normalizePhoneNumber(num);
                    if (np) contactMap[np] = name;
                  }
                }
              }
            } catch {}
          }
        } catch {}

        const items = await parseFiHistoryPath(target, {
          groupBy,
          contactMap,
        });

        let newItems = 0;
        let existing = 0;
        for (const item of items) {
          const res = await bank.ingestText(item);
          if (res.existed) existing++;
          else newItems++;
        }
        console.log(JSON.stringify({ label: "fi", total: items.length, newItems, existing }));
      } finally {
        bank.close();
      }
      return;
    }
    case "ingest-health": {
      const target = positional[0];
      if (!target) throw new Error("usage: ingest-health <path> [--device <device>]");
      await runIngest("health", () => parseHealthConnectPath(target, { device: flag("device") }));
      return;
    }
    case "ingest-jsonl": {
      const target = positional[0];
      if (!target) throw new Error("usage: ingest-jsonl <file.jsonl>");
      const bank = open();
      try {
        const content = readFileSync(target, "utf8");
        const lines = content.split("\n").filter((l) => l.trim().length > 0);
        let newItems = 0;
        let existing = 0;
        for (const line of lines) {
          const item = JSON.parse(line) as TextInput;
          const res = await bank.ingestText(item);
          if (res.existed) existing++;
          else newItems++;
        }
        console.log(JSON.stringify({ label: "jsonl", total: lines.length, newItems, existing }));
      } finally {
        bank.close();
      }
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
      if (!q) throw new Error("usage: search <query> [--kind photo] [--k 10] [--owner michael|gwen]");
      const bank = open();
      try {
        const hits = await bank.search(q, { k: Number(flag("k") ?? 10), kind: flag("kind") as ItemKind | undefined, owner: flag("owner") });
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
    case "resolve-people": {
      const explicitSeed = flag("seed");
      const seedFile = explicitSeed ?? process.env.PEOPLE_SEED_FILE;
      if (explicitSeed && !existsSync(explicitSeed)) {
        throw new Error(`Explicit seed file not found: ${explicitSeed}`);
      }
      const outFile = flag("out");
      if (outFile) {
        const normalized = outFile.replace(/\\/g, "/");
        if (normalized.includes("/projects/") || normalized.includes("/.git/")) {
          throw new Error(`Refusing to write unencrypted people graph inside repository path: ${outFile}`);
        }
      }
      const ownerId = flag("owner") ?? process.env.OWNER_ID ?? "person_michael";
      const resolver = seedFile && existsSync(seedFile) ? PeopleResolver.fromFile(seedFile) : new PeopleResolver();
      const bank = open();

      const str = (v: unknown): string | undefined =>
        typeof v === "string" && v.trim() ? v.trim() : undefined;

      const toMs = (n: unknown): number | undefined =>
        typeof n === "number" && Number.isFinite(n) && n > 0
          ? (n < 1e11 ? n * 1000 : n)
          : undefined;

      try {
        const sources = ["contacts", "cube-acr-calls", "google-fi", "gwen-messenger", "sms", "join-sms"];
        let totalItems = 0;
        let badMeta = 0;
        let skippedEmpty = 0;
        const perSourceCount: Record<string, number> = {};

        for (const src of sources) {
          const rows = bank.getItemsBySource(src);
          perSourceCount[src] = rows.length;
          totalItems += rows.length;

          for (const r of rows) {
            let m: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(r.meta || "{}");
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                m = parsed as Record<string, unknown>;
              } else {
                badMeta++;
              }
            } catch {
              badMeta++;
            }

            let name = str(m.name) || str(m.contact);
            if (!name && src === "contacts") {
              name = str(r.title);
            }

            const phones: string[] = [];
            const extractPhone = (val: unknown) => {
              if (typeof val === "string") {
                const s = str(val);
                if (s) phones.push(s);
              } else if (val && typeof val === "object") {
                const s = str((val as Record<string, unknown>).number);
                if (s) phones.push(s);
              }
            };

            if (Array.isArray(m.phones)) m.phones.forEach(extractPhone);
            if (Array.isArray(m.phone_numbers)) m.phone_numbers.forEach(extractPhone);
            if (m.phoneNumber) extractPhone(m.phoneNumber);

            const emails: string[] = [];
            const extractEmail = (val: unknown) => {
              if (typeof val === "string") {
                const s = str(val);
                if (s) emails.push(s);
              } else if (val && typeof val === "object") {
                const s = str((val as Record<string, unknown>).address);
                if (s) emails.push(s);
              }
            };
            if (Array.isArray(m.emails)) m.emails.forEach(extractEmail);

            const tags: string[] = [];
            if (Array.isArray(m.tags)) {
              for (const t of m.tags) {
                const st = str(t);
                if (st) tags.push(st);
              }
            }

            if (!name && phones.length === 0 && emails.length === 0) {
              skippedEmpty++;
              continue;
            }

            const rawTs = toMs(m.start_ts_ms) ?? toMs(m.lastTimestamp) ?? toMs(r.ts);

            resolver.ingestRecord({
              source: src,
              itemId: r.item_id,
              name,
              phones,
              emails,
              account: str(m.account),
              timestamp: rawTs,
              tags,
            });
          }
        }

        const people = resolver.getAllPeople();
        const { entities, edges } = resolver.toGraphEntitiesAndEdges(ownerId);
        const ledgerEvents = resolver.toLedgerEvents(ownerId);

        const summary = {
          totalItemsProcessed: totalItems,
          perSourceCount,
          badMeta,
          skippedEmpty,
          canonicalPeopleCount: people.length,
          graphEntitiesCount: entities.length,
          graphEdgesCount: edges.length,
          ledgerEventsCount: ledgerEvents.length,
          staffCount: people.filter((p) => p.tags.includes("oakridge-staff")).length,
        };

        console.log(JSON.stringify(summary, null, 2));

        if (outFile) {
          mkdirSync(dirname(outFile), { recursive: true });
          const tmpFile = `${outFile}.tmp.${Date.now()}`;
          writeFileSync(tmpFile, JSON.stringify({ people, entities, edges, ledgerEvents }, null, 2), "utf8");
          renameSync(tmpFile, outFile);
          console.error(`[PeopleResolver] Saved people graph atomically to ${outFile}`);
        }
      } finally {
        bank.close();
      }
      return;
    }
    default:
      console.log("commands: keygen <file> | ingest-dir <dir> --source <s> | ingest-takeout <path> [--device <dev>] | ingest-sms <path> [--device <dev>] | ingest-health <path> [--device <dev>] | ingest-contacts <path> | archive-memories <file> --older-than-days N | search <q> | reindex | stats | verify [--limit N] | resolve-people [--seed <file>] [--out <file>] | serve");
      process.exitCode = cmd ? 2 : 0;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
