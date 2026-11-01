/**
 * @file parsers/contacts.ts
 * Parser for Contact exports (Google Contacts CSV, Samsung Contacts CSV).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TextInput } from "../databank.js";

export interface ContactParserOptions {
  filePath?: string;
  source?: string;
  account?: string;
}

export interface ParsedContact {
  name: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
  company?: string;
  jobTitle?: string;
  phones: Array<{ type?: string; number: string }>;
  emails: Array<{ type?: string; address: string }>;
  addresses: Array<{ type?: string; formatted: string }>;
  notes?: string;
  birthday?: string;
  account?: string;
}

/** Parses CSV text into rows of string arrays handling quoted values */
export function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  const lines = csv.split(/\r?\n/);

  let inQuotes = false;
  let curFields: string[] = [];
  let curField = "";

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    if (!inQuotes && !line.trim()) continue;

    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') {
          curField += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === "," && !inQuotes) {
        curFields.push(curField.trim());
        curField = "";
      } else {
        curField += c;
      }
    }

    if (!inQuotes) {
      curFields.push(curField.trim());
      rows.push(curFields);
      curFields = [];
      curField = "";
    } else {
      curField += "\n";
    }
  }

  if (curField || curFields.length > 0) {
    curFields.push(curField.trim());
    rows.push(curFields);
  }

  return rows;
}

function parseSamsungContacts(rows: string[][], header: string[], options?: ContactParserOptions): ParsedContact[] {
  const contacts: ParsedContact[] = [];

  const displayNameIdx = header.findIndex((h) => h === "display name");
  const nameIdx = header.findIndex((h) => h === "name");
  const lastNameIdx = header.findIndex((h) => h === "last name");
  const nicknameIdx = header.findIndex((h) => h === "nickname");
  const companyIdx = header.findIndex((h) => h === "company name");
  const jobTitleIdx = header.findIndex((h) => h === "job title");
  const memoIdx = header.findIndex((h) => h === "memo");
  const accountIdx = header.findIndex((h) => h === "account");

  // Collect phone and email column indices
  const phoneCols: Array<{ valIdx: number; typeIdx: number }> = [];
  for (let i = 1; i <= 20; i++) {
    const valIdx = header.findIndex((h) => h === `phone number${i}(phone number)`);
    const typeIdx = header.findIndex((h) => h === `phone number${i}(type)`);
    if (valIdx !== -1) phoneCols.push({ valIdx, typeIdx });
  }

  const emailCols: Array<{ valIdx: number; typeIdx: number }> = [];
  for (let i = 1; i <= 15; i++) {
    const valIdx = header.findIndex((h) => h === `email${i}(address)`);
    const typeIdx = header.findIndex((h) => h === `email${i}(type)`);
    if (valIdx !== -1) emailCols.push({ valIdx, typeIdx });
  }

  const addressCols: Array<{ streetIdx: number; cityIdx: number; stateIdx: number; postIdx: number }> = [];
  for (let i = 1; i <= 10; i++) {
    const streetIdx = header.findIndex((h) => h === `address${i}(street)`);
    const cityIdx = header.findIndex((h) => h === `address${i}(city)`);
    const stateIdx = header.findIndex((h) => h === `address${i}(state)`);
    const postIdx = header.findIndex((h) => h === `address${i}(postcode)`);
    if (streetIdx !== -1) addressCols.push({ streetIdx, cityIdx, stateIdx, postIdx });
  }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const dispName = displayNameIdx !== -1 ? row[displayNameIdx] || "" : "";
    const first = nameIdx !== -1 ? row[nameIdx] || "" : "";
    const last = lastNameIdx !== -1 ? row[lastNameIdx] || "" : "";

    const name = dispName.trim() || `${first} ${last}`.trim();
    if (!name) continue;

    const phones: Array<{ type?: string; number: string }> = [];
    for (const pc of phoneCols) {
      const num = row[pc.valIdx]?.trim();
      if (num) {
        const type = pc.typeIdx !== -1 ? row[pc.typeIdx]?.trim() : undefined;
        phones.push({ number: num, type: type || undefined });
      }
    }

    const emails: Array<{ type?: string; address: string }> = [];
    for (const ec of emailCols) {
      const addr = row[ec.valIdx]?.trim();
      if (addr) {
        const type = ec.typeIdx !== -1 ? row[ec.typeIdx]?.trim() : undefined;
        emails.push({ address: addr, type: type || undefined });
      }
    }

    const addresses: Array<{ type?: string; formatted: string }> = [];
    for (const ac of addressCols) {
      const street = row[ac.streetIdx]?.trim() || "";
      const city = row[ac.cityIdx]?.trim() || "";
      const state = row[ac.stateIdx]?.trim() || "";
      const post = row[ac.postIdx]?.trim() || "";
      const parts = [street, city, state, post].filter(Boolean);
      if (parts.length > 0) {
        addresses.push({ formatted: parts.join(", ") });
      }
    }

    const company = companyIdx !== -1 ? row[companyIdx]?.trim() : undefined;
    const jobTitle = jobTitleIdx !== -1 ? row[jobTitleIdx]?.trim() : undefined;
    const notes = memoIdx !== -1 ? row[memoIdx]?.trim() : undefined;
    const nickname = nicknameIdx !== -1 ? row[nicknameIdx]?.trim() : undefined;
    const account = accountIdx !== -1 ? row[accountIdx]?.trim() || options?.account : options?.account;

    contacts.push({
      name,
      firstName: first || undefined,
      lastName: last || undefined,
      nickname: nickname || undefined,
      company: company || undefined,
      jobTitle: jobTitle || undefined,
      phones,
      emails,
      addresses,
      notes: notes || undefined,
      account: account || undefined,
    });
  }

  return contacts;
}

function parseGoogleContacts(rows: string[][], header: string[], options?: ContactParserOptions): ParsedContact[] {
  const contacts: ParsedContact[] = [];

  const nameIdx = header.findIndex((h) => h === "name");
  const givenNameIdx = header.findIndex((h) => h === "given name");
  const familyNameIdx = header.findIndex((h) => h === "family name");
  const nicknameIdx = header.findIndex((h) => h === "nickname");
  const birthdayIdx = header.findIndex((h) => h === "birthday");
  const notesIdx = header.findIndex((h) => h === "notes");

  // Phone and email columns
  const phoneCols: Array<{ valIdx: number; typeIdx: number }> = [];
  for (let i = 1; i <= 10; i++) {
    const valIdx = header.findIndex((h) => h === `phone ${i} - value`);
    const typeIdx = header.findIndex((h) => h === `phone ${i} - type`);
    if (valIdx !== -1) phoneCols.push({ valIdx, typeIdx });
  }

  const emailCols: Array<{ valIdx: number; typeIdx: number }> = [];
  for (let i = 1; i <= 10; i++) {
    const valIdx = header.findIndex((h) => h === `e-mail ${i} - value`);
    const typeIdx = header.findIndex((h) => h === `e-mail ${i} - type`);
    if (valIdx !== -1) emailCols.push({ valIdx, typeIdx });
  }

  const addressCols: Array<{ valIdx: number; typeIdx: number }> = [];
  for (let i = 1; i <= 5; i++) {
    const valIdx = header.findIndex((h) => h === `address ${i} - formatted`);
    const typeIdx = header.findIndex((h) => h === `address ${i} - type`);
    if (valIdx !== -1) addressCols.push({ valIdx, typeIdx });
  }

  const orgNameIdx = header.findIndex((h) => h === "organization 1 - name");
  const orgTitleIdx = header.findIndex((h) => h === "organization 1 - title");

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const full = nameIdx !== -1 ? row[nameIdx] || "" : "";
    const first = givenNameIdx !== -1 ? row[givenNameIdx] || "" : "";
    const last = familyNameIdx !== -1 ? row[familyNameIdx] || "" : "";

    const name = full.trim() || `${first} ${last}`.trim();
    if (!name) continue;

    const phones: Array<{ type?: string; number: string }> = [];
    for (const pc of phoneCols) {
      const num = row[pc.valIdx]?.trim();
      if (num) {
        const type = pc.typeIdx !== -1 ? row[pc.typeIdx]?.trim() : undefined;
        phones.push({ number: num, type: type || undefined });
      }
    }

    const emails: Array<{ type?: string; address: string }> = [];
    for (const ec of emailCols) {
      const addr = row[ec.valIdx]?.trim();
      if (addr) {
        const type = ec.typeIdx !== -1 ? row[ec.typeIdx]?.trim() : undefined;
        emails.push({ address: addr, type: type || undefined });
      }
    }

    const addresses: Array<{ type?: string; formatted: string }> = [];
    for (const ac of addressCols) {
      const addr = row[ac.valIdx]?.trim();
      if (addr) {
        const type = ac.typeIdx !== -1 ? row[ac.typeIdx]?.trim() : undefined;
        addresses.push({ formatted: addr, type: type || undefined });
      }
    }

    const company = orgNameIdx !== -1 ? row[orgNameIdx]?.trim() : undefined;
    const jobTitle = orgTitleIdx !== -1 ? row[orgTitleIdx]?.trim() : undefined;
    const notes = notesIdx !== -1 ? row[notesIdx]?.trim() : undefined;
    const nickname = nicknameIdx !== -1 ? row[nicknameIdx]?.trim() : undefined;
    const birthday = birthdayIdx !== -1 ? row[birthdayIdx]?.trim() : undefined;

    contacts.push({
      name,
      firstName: first || undefined,
      lastName: last || undefined,
      nickname: nickname || undefined,
      company: company || undefined,
      jobTitle: jobTitle || undefined,
      phones,
      emails,
      addresses,
      notes: notes || undefined,
      birthday: birthday || undefined,
      account: options?.account,
    });
  }

  return contacts;
}

/** Converts a ParsedContact into a Databank TextInput */
export function contactToTextInput(contact: ParsedContact, options?: ContactParserOptions): TextInput {
  const lines: string[] = [`Contact: ${contact.name}`];
  if (contact.nickname) lines.push(`Nickname: ${contact.nickname}`);
  if (contact.company || contact.jobTitle) {
    const job = [contact.company, contact.jobTitle ? `(${contact.jobTitle})` : ""].filter(Boolean).join(" ");
    lines.push(`Organization: ${job}`);
  }
  if (contact.phones.length > 0) {
    lines.push(`Phones: ${contact.phones.map((p) => (p.type ? `${p.type}: ${p.number}` : p.number)).join(", ")}`);
  }
  if (contact.emails.length > 0) {
    lines.push(`Emails: ${contact.emails.map((e) => (e.type ? `${e.type}: ${e.address}` : e.address)).join(", ")}`);
  }
  if (contact.addresses.length > 0) {
    lines.push(`Addresses: ${contact.addresses.map((a) => a.formatted).join("; ")}`);
  }
  if (contact.birthday) lines.push(`Birthday: ${contact.birthday}`);
  if (contact.notes) lines.push(`Notes: ${contact.notes}`);

  const tags = Array.from(
    new Set(
      ["contact", "person", contact.name, contact.company || null, contact.account || null].filter((t): t is string =>
        Boolean(t)
      )
    )
  );

  return {
    kind: "note",
    source: options?.source ?? "contacts",
    title: `Contact: ${contact.name}`,
    text: lines.join("\n"),
    path: options?.filePath ?? "",
    ts: Date.now(),
    meta: {
      entityType: "contact",
      name: contact.name,
      phones: contact.phones,
      emails: contact.emails,
      company: contact.company,
      jobTitle: contact.jobTitle,
      addresses: contact.addresses,
      notes: contact.notes,
      birthday: contact.birthday,
      account: contact.account,
      tags,
    },
  };
}

/** Parses Contact CSV content into Databank TextInputs */
export function parseContacts(csv: string, options?: ContactParserOptions): TextInput[] {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) return [];

  const rawHeader = rows[0];
  const normalizedHeader = rawHeader.map((h) => h.toLowerCase().trim().replace(/^\ufeff/, ""));

  let parsed: ParsedContact[] = [];
  if (normalizedHeader.some((h) => h.includes("display name") || h.includes("phone number1"))) {
    parsed = parseSamsungContacts(rows, normalizedHeader, options);
  } else {
    parsed = parseGoogleContacts(rows, normalizedHeader, options);
  }

  return parsed.map((c) => contactToTextInput(c, options));
}

async function walkContactsDir(dir: string, items: TextInput[], options?: ContactParserOptions): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkContactsDir(full, items, options);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".csv")) {
      try {
        const raw = await readFile(full, "utf8");
        const account = e.name.includes("@") ? e.name.replace(/^Contact_/, "").replace(/\.csv$/i, "") : undefined;
        items.push(...parseContacts(raw, { ...options, filePath: full, account }));
      } catch {
        // ignore unparseable CSV
      }
    }
  }
}

/** Parses a file or directory of Contact CSV files */
export async function parseContactsPath(
  filePathOrDir: string,
  options?: ContactParserOptions
): Promise<TextInput[]> {
  const s = await stat(filePathOrDir);
  if (s.isDirectory()) {
    const items: TextInput[] = [];
    await walkContactsDir(filePathOrDir, items, options);
    return items;
  }
  const raw = await readFile(filePathOrDir, "utf8");
  return parseContacts(raw, { ...options, filePath: filePathOrDir });
}
