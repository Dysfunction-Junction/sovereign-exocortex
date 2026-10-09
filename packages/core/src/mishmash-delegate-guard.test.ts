import { describe, it, expect } from 'vitest';
import { request } from 'node:http';
import { isTrustedDelegateRequest, startPatternDelegate } from './mishmash-delegate.js';

describe('pattern-analyzer delegate Origin/Host guard', () => {
  it('trusts only the exact loopback host:port and no Origin', () => {
    const ok = (headers: Record<string, string>) => isTrustedDelegateRequest(headers, 39402);
    expect(ok({ host: '127.0.0.1:39402' })).toBe(true);
    expect(ok({ host: 'LOCALHOST:39402' })).toBe(true);
    expect(ok({ host: '[::1]:39402' })).toBe(true);
    expect(ok({ host: '127.0.0.1:39402', origin: 'https://evil.example' })).toBe(false);
    expect(ok({ host: 'rebound.attacker.example:39402' })).toBe(false);
    expect(ok({ host: '127.0.0.1:1' })).toBe(false);
    expect(ok({})).toBe(false);
    expect(isTrustedDelegateRequest({ host: '127.0.0.1:39402' }, undefined)).toBe(false);
  });

  it('the real server refuses cross-site and rebound requests but serves a plain local call', async () => {
    const server = await startPatternDelegate(0);
    const port = (server.address() as { port: number }).port;
    const body = JSON.stringify({ v: 1, id: 'env-12345678', from: 'gateway', to: 'pattern-analyzer', capability: 'rank', action: 'ping', payload: {} });
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const r = request(
          { host: '127.0.0.1', port, path: '/mishmash/delegate', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        r.on('error', reject);
        r.end(body);
      });
    try {
      expect(await status({})).toBe(200);
      expect(await status({ Origin: 'https://evil.example' })).toBe(403);
      expect(await status({ Host: 'rebound.attacker.example' })).toBe(403);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
