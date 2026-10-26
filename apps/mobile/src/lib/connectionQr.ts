// Parses the connection & pairing QR payload used by Setup's "Scan to Connect" flow.
// Deliberately pure functions, isolated from UI state to ensure strict contract agreement
// between the PC generator scripts and the mobile camera parser.
//
// Supported JSON shapes:
//   1. Standard config: {"baseUrl": "http://100.x.y.z:8788", "token": "<jwt or bearer>"}
//   2. Pairing token:   {"baseUrl": "http://100.x.y.z:8788", "pairingToken": "pt_..."}
//   3. IP + Port form:  {"ip": "100.x.y.z", "port": 8788, "pairingToken": "pt_..."}

export interface ConnectionQrPayload {
  baseUrl: string;
  token?: string;
  pairingToken?: string;
  isPairingToken: boolean;
}

export class InvalidConnectionQrError extends Error {
  constructor(reason: string) {
    super(`Invalid connection QR code: ${reason}`);
    this.name = "InvalidConnectionQrError";
  }
}

export function parseConnectionQrPayload(raw: string): ConnectionQrPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidConnectionQrError("not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidConnectionQrError("expected a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  let baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";

  // Support direct IP + Port payload shape: {"ip": "100.x.x.x", "port": 8788, ...}
  if (!baseUrl) {
    const rawIp = typeof record.ip === "string" ? record.ip.trim() : typeof record.tailscaleIp === "string" ? record.tailscaleIp.trim() : "";
    if (rawIp) {
      const port = record.port === undefined ? 8788 : record.port;
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new InvalidConnectionQrError('"port" must be an integer between 1 and 65535');
      }
      const protocol = typeof record.protocol === "string" && record.protocol.toLowerCase() === "https" ? "https" : "http";
      let u: URL;
      try {
        u = new URL(`${protocol}://${rawIp}:${port}`);
      } catch {
        throw new InvalidConnectionQrError(`"ip" is not a valid host: ${rawIp}`);
      }
      if (u.username || u.password || u.search || u.hash || u.pathname !== "/" || u.hostname !== rawIp.toLowerCase()) {
        throw new InvalidConnectionQrError('"ip" must be a bare host or IP address');
      }
      baseUrl = `${protocol}://${u.host}`;
    }
  }

  if (!baseUrl) {
    throw new InvalidConnectionQrError("missing or empty \"baseUrl\" (or \"ip\")");
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new InvalidConnectionQrError(`"baseUrl" is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidConnectionQrError(`"baseUrl" must be http(s), got ${url.protocol}`);
  }

  const rawToken = typeof record.token === "string" ? record.token.trim() : "";
  const rawPairingToken = typeof record.pairingToken === "string" ? record.pairingToken.trim() : "";

  if (!rawToken && !rawPairingToken) {
    throw new InvalidConnectionQrError("missing token or pairingToken in payload");
  }

  // Determine if the token represents a short-lived pairing exchange token
  const isPairingToken = Boolean(
    rawPairingToken || (rawToken && rawToken.startsWith("pt_"))
  );

  const pairingToken = rawPairingToken || (rawToken.startsWith("pt_") ? rawToken : undefined);
  const token = rawToken && !rawToken.startsWith("pt_") ? rawToken : undefined;

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    token,
    pairingToken,
    isPairingToken,
  };
}
