export function formatTimeAgo(timestamp: number, now = Date.now()): string {
  const diffMs = Math.max(0, now - timestamp);
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function formatProposalWhy(
  item: {
    state?: string;
    tier?: number | string;
    efe?: number;
    updatedAt?: number;
  },
  now = Date.now()
): string | null {
  const parts: string[] = [];
  if (item.state && typeof item.state === "string" && item.state.trim().length > 0) {
    const s = item.state.trim();
    parts.push(s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());
  }
  if (item.tier !== undefined && item.tier !== null) {
    const tStr = String(item.tier).trim();
    if (tStr.length > 0) {
      parts.push(`tier ${tStr.toUpperCase().startsWith("T") ? tStr.toUpperCase() : `T${tStr}`}`);
    }
  }
  if (typeof item.efe === "number" && !Number.isNaN(item.efe)) {
    parts.push(`EFE ${item.efe.toFixed(2)}`);
  }
  if (typeof item.updatedAt === "number" && !Number.isNaN(item.updatedAt) && item.updatedAt > 0) {
    parts.push(formatTimeAgo(item.updatedAt, now));
  }
  if (parts.length === 0) return null;
  return parts.join(" · ");
}
