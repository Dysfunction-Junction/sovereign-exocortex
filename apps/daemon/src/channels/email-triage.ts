/**
 * @file email-triage.ts
 * High-signal email triage and inbox decongestion filter.
 * Distinguishes genuine human correspondence from automated bots, newsletters, and receipts.
 */

const AUTOMATED_SENDER_REGEX = /^(no[-_]?reply|donotreply|notifications?|support|news|billing|receipts?|updates?|alerts?|marketing|info|hello)@/i;

export interface EmailTriageResult {
  category: "HUMAN" | "TRANSACTIONAL" | "BULK_IGNORE";
  reason: string;
}

/**
 * Checks whether an email address matches common automated bot/service prefixes.
 */
export function isAutomatedSender(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  const clean = address.trim().toLowerCase();
  const emailPart = clean.match(/<([^>]+)>/)?.[1] || clean;
  return AUTOMATED_SENDER_REGEX.test(emailPart);
}

/**
 * Inspects standard RFC email headers to detect automated/bulk messages.
 */
export function hasBulkHeaders(headers: Record<string, string>): boolean {
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    norm[k.toLowerCase()] = String(v).toLowerCase();
  }

  // 1. Unsubscribe headers (direct marker of marketing/newsletter)
  if (norm["list-unsubscribe"] || norm["list-id"]) return true;

  // 2. Precedence headers
  if (["bulk", "list", "junk"].includes(norm["precedence"] || "")) return true;

  // 3. Auto-submitted headers (RFC 3834)
  if (norm["auto-submitted"] && norm["auto-submitted"] !== "no") return true;

  return false;
}

/**
 * Classifies an incoming email into HUMAN, TRANSACTIONAL, or BULK_IGNORE.
 */
export function classifyEmailType(headers: Record<string, string>, fromAddress: string, subject = ""): EmailTriageResult {
  // Check bulk RFC headers first
  if (hasBulkHeaders(headers)) {
    return { category: "BULK_IGNORE", reason: "Found bulk or list-unsubscribe headers" };
  }

  // Check sender address patterns
  if (isAutomatedSender(fromAddress)) {
    // Check if it's actionable transactional (receipt, flight, tracking)
    const lowerSubj = subject.toLowerCase();
    if (
      lowerSubj.includes("receipt") ||
      lowerSubj.includes("order") ||
      lowerSubj.includes("tracking") ||
      lowerSubj.includes("flight") ||
      lowerSubj.includes("confirmation")
    ) {
      return { category: "TRANSACTIONAL", reason: "Automated sender with transactional subject keywords" };
    }
    return { category: "BULK_IGNORE", reason: "Automated sender without actionable transactional keywords" };
  }

  return { category: "HUMAN", reason: "Direct sender with no automated markers" };
}

/**
 * Generates an optimal Gmail API search query that drops promo, social, spam, and trash server-side.
 */
export function buildScopedGmailQuery(daysBack = 30): string {
  return `newer_than:${daysBack}d -category:promotions -category:social -is:spam -is:trash`;
}

/**
 * Checks if a thread represents mutual correspondence involving the user.
 */
export function isMutualCorrespondent(participants: string[], userEmail: string): boolean {
  if (!userEmail || !Array.isArray(participants)) return false;
  const lowerUser = userEmail.toLowerCase().trim();
  const lowerParticipants = participants.map((p) => p.toLowerCase());
  return lowerParticipants.some((p) => p.includes(lowerUser)) && participants.length >= 2;
}
