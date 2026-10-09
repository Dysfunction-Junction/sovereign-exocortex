import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { isRankError, rankSuppliedCandidates, computeSurprisalFeedback } from './mishmash-rank.js';

const NODE = 'pattern-analyzer';

function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function envelope(body: Record<string, unknown>, result: Record<string, unknown>) {
  return {
    v: 1,
    inReplyTo: body.id,
    from: NODE,
    to: body.from,
    ok: true,
    result,
  };
}

export function handlePatternDelegate(body: unknown): { status: number; body: Record<string, unknown> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: 'envelope must be a JSON object' } };
  }
  const record = body as Record<string, unknown>;
  if (record.to !== NODE || record.v !== 1) {
    return { status: 400, body: { error: 'envelope is not addressed to pattern-analyzer' } };
  }
  if (record.action === 'ping') {
    return { status: 200, body: envelope(record, { node: NODE, action: 'ping' }) };
  }
  if (record.action === 'rank') {
    const ranked = rankSuppliedCandidates(record.payload ?? {});
    if (isRankError(ranked)) return { status: 400, body: { error: ranked.error } };
    return {
      status: 200,
      body: envelope(record, { node: NODE, action: 'rank', ...ranked }),
    };
  }
  if (record.action === 'feedback') {
    const feedback = computeSurprisalFeedback(record.payload ?? {});
    if ('error' in feedback) return { status: 400, body: { error: feedback.error } };
    return {
      status: 200,
      body: envelope(record, { node: NODE, action: 'feedback', ...feedback }),
    };
  }
  return { status: 400, body: { error: 'pattern-analyzer accepts ping, rank, or feedback' } };
}


function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('delegate body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new Error('body stream failed')));
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Loopback peer is not enough: a web page can POST here from the user's own browser, and a DNS-rebound
 * hostname also arrives from a loopback peer. Browsers always attach Origin to cross-site POSTs, and a
 * rebound request carries the attacker's name in Host, so both are checked.
 */
export function isTrustedDelegateRequest(headers: IncomingMessage['headers'], port: number | undefined): boolean {
  if (headers.origin !== undefined) return false;
  if (port === undefined) return false;
  const host = headers.host;
  return (
    typeof host === 'string' &&
    [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase())
  );
}

export function startPatternDelegate(port: number) {
  const server = createServer(async (req, res) => {
    if (!isTrustedDelegateRequest(req.headers, req.socket.localPort)) {
      send(res, 403, { error: 'delegate rejects browser-origin or rebound-host requests' });
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      send(res, 200, { ok: true, node: NODE });
      return;
    }
    if (req.method !== 'POST' || path !== '/mishmash/delegate') {
      send(res, 404, { error: 'Not Found' });
      return;
    }
    if (!isLoopback(req.socket.remoteAddress)) {
      send(res, 403, { error: 'delegate is only accepted from this PC' });
      return;
    }
    try {
      const raw = await readBody(req, 64 * 1024);
      const decoded = raw ? JSON.parse(raw) : {};
      const outcome = handlePatternDelegate(decoded);
      send(res, outcome.status, outcome.body);
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : 'bad body' });
    }
  });
  return new Promise<typeof server>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const invoked = process.argv.some((arg) => {
  const base = arg.split(/[/\\]/).pop();
  return base === 'mishmash-delegate.ts' || base === 'mishmash-delegate.js';
});
if (invoked) {
  const port = Number(process.env.MISHMASH_PORT || 39402);
  startPatternDelegate(port).then(() => {
    console.log(`pattern-analyzer mishmash on 127.0.0.1:${port}`);
  });
}
