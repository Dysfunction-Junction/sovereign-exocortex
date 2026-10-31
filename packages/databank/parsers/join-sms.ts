/**
 * @file parsers/join-sms.ts
 * Parser for Join SMS backups (JSON files from Join exports).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TextInput } from "../databank.js";
import { parseTimestamp, type ParsedTemporal } from "./takeout-location.js";

export interface JoinSmsParserOptions {
  filePath?: string;
  device?: string;
  groupBy?: "conversation" | "message";
}

export interface RawJoinMessage {
  sender?: string;
  senderNumber?: string;
  sender_number?: string;
  recipient?: string;
  recipientNumber?: string;
  recipient_number?: string;
  address?: string;
  number?: string;
  phone?: string;
  contact?: string;
  contact_name?: string;
  contactName?: string;
  name?: string;
  body?: string;
  text?: string;
  message?: string;
  msg?: string;
  date?: string | number;
  timestamp?: string | number;
  date_sent?: string | number;
  time?: string | number;
  type?: number | string; // 1 = inbox, 2 = sent
  incoming?: boolean;
  received?: boolean;
  sent?: boolean;
  device?: string;
  deviceName?: string;
  model?: string;
}

export interface NormalizedSmsMessage {
  sender: string;
  senderNumber: string;
  recipient: string;
  recipientNumber: string;
  contact: string;
  contactNumber: string;
  body: string;
  timestamp: number;
  temporal: ParsedTemporal;
  isIncoming: boolean;
  device?: string;
}

function normalizeMessage(raw: RawJoinMessage, fallbackDevice?: string): NormalizedSmsMessage | null {
  const body = (raw.body ?? raw.text ?? raw.message ?? raw.msg ?? "").trim();
  const rawDate = raw.date ?? raw.timestamp ?? raw.date_sent ?? raw.time;
  const { ms: timestamp, temporal } = parseTimestamp(rawDate);

  const device =
    raw.device || raw.deviceName || raw.model || fallbackDevice;

  // Direction: type 1 = incoming/inbox, type 2 = sent
  let isIncoming = true;
  if (typeof raw.type === "number") {
    isIncoming = raw.type === 1;
  } else if (typeof raw.type === "string") {
    isIncoming = raw.type === "1" || raw.type.toLowerCase() === "inbox";
  } else if (raw.sent === true) {
    isIncoming = false;
  } else if (raw.incoming === false || raw.received === false) {
    isIncoming = false;
  } else if (raw.sender && /^(me|user|myself)$/i.test(raw.sender.trim())) {
    isIncoming = false;
  }

  let contactName = raw.contact_name ?? raw.contactName ?? raw.name ?? raw.contact ?? "";
  let contactPhone = "";

  let sender: string;
  let senderNumber = "";
  let recipient: string;
  let recipientNumber = "";

  if (isIncoming) {
    sender = raw.sender || contactName || raw.address || raw.number || raw.senderNumber || "Unknown";
    senderNumber = raw.senderNumber || raw.sender_number || raw.address || raw.number || raw.phone || "";
    recipient = raw.recipient || "Me";
    recipientNumber = raw.recipientNumber || raw.recipient_number || "";
    contactPhone = senderNumber;
    if (!contactName && sender && !/^(me|user|myself)$/i.test(sender)) {
      contactName = sender;
    }
  } else {
    sender = raw.sender || "Me";
    senderNumber = raw.senderNumber || raw.sender_number || "";
    recipient = raw.recipient || contactName || raw.address || raw.number || raw.recipientNumber || "Unknown";
    recipientNumber = raw.recipientNumber || raw.recipient_number || raw.address || raw.number || raw.phone || "";
    contactPhone = recipientNumber;
    if (!contactName && recipient && !/^(me|user|myself)$/i.test(recipient)) {
      contactName = recipient;
    }
  }

  // Determine contact for the conversation: prefer name if not "Me", then phone
  let contact = contactName;
  if (!contact || /^(me|user|myself)$/i.test(contact)) {
    contact = contactPhone;
  }
  if (!contact) {
    contact = isIncoming ? sender : recipient;
  }
  if (!contact || /^(me|user|myself)$/i.test(contact)) {
    contact = "Unknown";
  }

  return {
    sender,
    senderNumber,
    recipient,
    recipientNumber,
    contact,
    contactNumber: contactPhone,
    body,
    timestamp,
    temporal,
    isIncoming,
    device,
  };
}

function formatBubble(msg: NormalizedSmsMessage): string {
  const time = msg.temporal.isoTimestamp.replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return `[${time}] ${msg.sender}: ${msg.body}`;
}

/** Formats a group of messages with a single contact into a Databank TextInput */
export function formatConversation(
  contact: string,
  messages: NormalizedSmsMessage[],
  options?: JoinSmsParserOptions
): TextInput {
  // Sort chronologically
  messages.sort((a, b) => a.timestamp - b.timestamp);

  const first = messages[0];
  const last = messages[messages.length - 1];
  const detectedDevice = messages.find((m) => m.device)?.device ?? options?.device ?? "unknown";

  const participants = Array.from(
    new Set(messages.flatMap((m) => [m.sender, m.recipient]).filter(Boolean))
  );

  const headerLines: string[] = [
    `SMS with ${contact}`,
    `Participants: ${participants.join(", ")}`,
    first.contactNumber ? `Number: ${first.contactNumber}` : null,
    `Date Range: ${first.temporal.dateStr} to ${last.temporal.dateStr} (${messages.length} messages)`,
    detectedDevice !== "unknown" ? `Device: ${detectedDevice}` : null,
    "--- Transcript ---",
  ].filter((l): l is string => Boolean(l));

  const bubbles = messages.map(formatBubble).join("\n");
  const fullText = `${headerLines.join("\n")}\n\n${bubbles}`;

  const tags = Array.from(
    new Set(
      ["sms", "message", contact, detectedDevice !== "unknown" ? detectedDevice : null].filter(
        (t): t is string => Boolean(t)
      )
    )
  );

  const entities = Array.from(
    new Set([contact, ...participants].filter((e): e is string => Boolean(e)))
  );

  return {
    kind: "conversation",
    source: "join-sms",
    title: `SMS with ${contact}`,
    text: fullText,
    path: options?.filePath ?? "",
    ts: first.timestamp,
    meta: {
      sender: first.sender,
      recipient: first.recipient,
      timestamp: first.timestamp,
      lastTimestamp: last.timestamp,
      contact,
      contactNumber: first.contactNumber,
      messageCount: messages.length,
      device: detectedDevice,
      tags,
      entities,
      temporal: first.temporal,
    },
  };
}

/** Formats an individual message into a Databank TextInput */
export function formatSingleMessage(
  msg: NormalizedSmsMessage,
  options?: JoinSmsParserOptions
): TextInput {
  const detectedDevice = msg.device ?? options?.device ?? "unknown";
  const bubble = formatBubble(msg);
  const text = `SMS with ${msg.contact}\nFrom: ${msg.sender} -> To: ${msg.recipient}\n\n${bubble}`;

  const tags = Array.from(
    new Set(
      ["sms", "message", msg.contact, detectedDevice !== "unknown" ? detectedDevice : null].filter(
        (t): t is string => Boolean(t)
      )
    )
  );

  const entities = Array.from(
    new Set([msg.contact, msg.sender, msg.recipient].filter((e): e is string => Boolean(e)))
  );

  return {
    kind: "conversation",
    source: "join-sms",
    title: `SMS with ${msg.contact}`,
    text,
    path: options?.filePath ?? "",
    ts: msg.timestamp,
    meta: {
      sender: msg.sender,
      recipient: msg.recipient,
      timestamp: msg.timestamp,
      contact: msg.contact,
      contactNumber: msg.contactNumber,
      device: detectedDevice,
      tags,
      entities,
      temporal: msg.temporal,
    },
  };
}

/**
 * Parses Join SMS content (JSON object or string).
 */
export function parseJoinSms(
  content: string | Record<string, unknown> | Array<unknown>,
  options?: JoinSmsParserOptions
): TextInput[] {
  let data: unknown = content;
  if (typeof content === "string") {
    try {
      data = JSON.parse(content);
    } catch (err) {
      throw new Error(`Failed to parse Join SMS JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!data || typeof data !== "object") return [];

  let rawList: RawJoinMessage[] = [];
  let rootDevice: string | undefined = undefined;

  if (Array.isArray(data)) {
    rawList = data as RawJoinMessage[];
  } else if ("messages" in data && Array.isArray((data as { messages: unknown[] }).messages)) {
    rawList = (data as { messages: unknown[] }).messages as RawJoinMessage[];
    const obj = data as { device?: string; deviceName?: string; model?: string };
    rootDevice = obj.device || obj.deviceName || obj.model;
  } else {
    // Single message object
    rawList = [data as RawJoinMessage];
  }

  const normalized: NormalizedSmsMessage[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    const msg = normalizeMessage(raw, rootDevice ?? options?.device);
    if (msg) normalized.push(msg);
  }

  if (normalized.length === 0) return [];

  if (options?.groupBy === "message") {
    return normalized.map((msg) => formatSingleMessage(msg, options));
  }

  // Default: group by contact
  const grouped = new Map<string, NormalizedSmsMessage[]>();
  for (const msg of normalized) {
    const key = msg.contact || "Unknown";
    const existing = grouped.get(key);
    if (existing) {
      existing.push(msg);
    } else {
      grouped.set(key, [msg]);
    }
  }

  const items: TextInput[] = [];
  for (const [contact, msgs] of grouped.entries()) {
    items.push(formatConversation(contact, msgs, options));
  }

  return items;
}

async function walkSmsDir(
  dir: string,
  items: TextInput[],
  options?: JoinSmsParserOptions
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkSmsDir(full, items, options);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".json")) {
      try {
        const raw = await readFile(full, "utf8");
        items.push(...parseJoinSms(raw, { ...options, filePath: full }));
      } catch {
        // skip unparseable files in batch walk
      }
    }
  }
}

/**
 * Parses Join SMS file or directory recursively.
 */
export async function parseJoinSmsPath(
  targetPath: string,
  options?: JoinSmsParserOptions
): Promise<TextInput[]> {
  const s = await stat(targetPath);
  if (s.isDirectory()) {
    const items: TextInput[] = [];
    await walkSmsDir(targetPath, items, options);
    return items;
  } else {
    const raw = await readFile(targetPath, "utf8");
    return parseJoinSms(raw, { ...options, filePath: targetPath });
  }
}
