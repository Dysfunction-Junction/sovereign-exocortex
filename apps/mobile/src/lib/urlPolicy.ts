/**
 * Policy for the base URLs credentials are sent to. Used when a URL is saved and again when
 * connection targets are built, so a value stored by an older build cannot bypass it.
 *
 *  - https is required.
 *  - Cleartext http is allowed only for a literal loopback host, and only if the caller opts in
 *    (desktop and dev builds; the release Android app also has cleartext disabled at the OS level).
 *  - Base URLs are origins: no embedded credentials, path, query or fragment.
 */

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

export interface UrlPolicyOptions {
  allowLoopbackHttp?: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function validateBaseUrl(raw: string, opts: UrlPolicyOptions = {}): UrlCheck {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, reason: "the address is empty" };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "the address is not a valid URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `unsupported scheme ${url.protocol}; use https://` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "the address must not contain a username or password" };
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return { ok: false, reason: "the address must be just a host and port, without a path, query or fragment" };
  }
  if (url.protocol === "http:") {
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (!(loopback && opts.allowLoopbackHttp)) {
      return {
        ok: false,
        reason: "cleartext http:// would expose the access token; use an https:// address (for example the Tailscale gateway)",
      };
    }
  }
  return { ok: true, url: url.origin };
}
