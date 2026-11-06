import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { App } from '../app';
import { approveAction, rejectAction } from '../work/approvals';
import { mintCapability, type HumanCapability } from '../work/capability';
import { approvalsView, issueView, queueView, stateView } from './views';

// The only place a human capability is created: from a session cookie set on this origin.
// State-changing requests also need an allowed Host and a matching Origin.

const COOKIE = 'apx_session';
const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export function createApp(app: App, port: number, publicDir = 'public'): Server {
  const sessions = new Map<string, HumanCapability>();
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  const deps = { store: app.store, facts: app.facts.db, duplicateInvoices: () => app.duplicateInvoices() };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
    res.end(text);
  };

  const capabilityFor = (req: IncomingMessage): HumanCapability | undefined => {
    const id = /(?:^|;\s*)apx_session=([0-9a-f]{64})/.exec(req.headers.cookie ?? '')?.[1];
    return id ? sessions.get(id) : undefined;
  };

  return createServer(async (req, res) => {
    try {
      if (!hosts.has(req.headers.host ?? '')) return send(res, 421, 'unknown host');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname]!;
        const headers: Record<string, string> = { 'Content-Type': type };
        if (url.pathname === '/' && !capabilityFor(req)) {
          const id = randomBytes(32).toString('hex');
          sessions.set(id, mintCapability(id));
          headers['Set-Cookie'] = `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/`;
        }
        res.writeHead(200, { ...SECURITY_HEADERS, ...headers });
        return res.end(readFileSync(join(publicDir, file)));
      }

      if (req.method === 'GET') {
        if (url.pathname === '/api/state') return send(res, 200, stateView(app));
        if (url.pathname === '/api/issues') return send(res, 200, queueView(app));
        const m = /^\/api\/issues\/([\w.-]+)$/.exec(url.pathname);
        if (m) {
          const view = issueView(app, m[1]!);
          return view ? send(res, 200, view) : send(res, 404, { error: 'no such issue' });
        }
        if (url.pathname === '/api/approvals') return send(res, 200, approvalsView(app));
        return send(res, 404, 'not found');
      }

      if (req.method === 'POST') {
        if (!origins.has(req.headers.origin ?? '')) return send(res, 403, { error: 'origin not allowed' });
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'send JSON' });
        const cap = capabilityFor(req);
        if (!cap) return send(res, 401, { error: 'no session; reload the page' });
        const m = /^\/api\/actions\/([\w.-]+)\/(approve|reject)$/.exec(url.pathname);
        if (!m) return send(res, 404, { error: 'not found' });
        const body = JSON.parse((await readBody(req)) || '{}') as { payload_hash?: unknown; reason?: unknown };
        const hash = typeof body.payload_hash === 'string' ? body.payload_hash : '';
        const decision = m[2] === 'approve' ? approveAction(cap, deps, m[1]!, hash) : rejectAction(cap, deps, m[1]!, hash, typeof body.reason === 'string' ? body.reason.slice(0, 500) : '');
        return send(res, decision.ok ? 200 : 409, decision);
      }

      return send(res, 405, 'method not allowed');
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  });
}

function readBody(req: IncomingMessage, limit = 64_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
