/**
 * @file pairing.ts
 * Mobile pairing client: Exchanges a short-lived pairing token at POST /mobile/pair
 * for a permanent device registration and signed JWT token.
 */

export interface PairingExchangeResult {
  ok: boolean;
  token: string;
  deviceId: string;
  label?: string;
  error?: string;
  reason?: string;
}

/**
 * Exchanges a single-use pairing token with the PC's gateway at `POST ${baseUrl}/mobile/pair`.
 */
export async function exchangePairingToken(
  baseUrl: string,
  pairingToken: string,
  deviceLabel = "Android Companion"
): Promise<PairingExchangeResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/mobile/pair`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairingToken,
      deviceLabel,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let reason = `HTTP ${res.status}`;
    try {
      const json = JSON.parse(errText);
      reason = json.reason ?? json.error ?? reason;
    } catch {
      if (errText) reason = errText.slice(0, 100);
    }
    throw new Error(`Pairing failed: ${reason}`);
  }

  const json = (await res.json()) as PairingExchangeResult;
  if (!json.ok || !json.token) {
    throw new Error(`Pairing failed: ${json.reason ?? json.error ?? "no credentials returned"}`);
  }

  return json;
}
