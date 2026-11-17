// app.ts — HTTP plumbing: body reading, routing, bearer auth, request ids.
// Routes: /healthz (no auth), /api/v3/*, POST /api/graphql, POST /mcp,
// /<owner>/<repo>.git/* (smart HTTP). Everything else -> 404 JSON.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import type { RestCtx } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPackStream } from './git.ts';
import { utf8, utf8Str } from './util.ts';

const MAX_BODY = 128 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    req.on('data', (c: Uint8Array) => {
      total += c.length;
      if (total > MAX_BODY) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      resolve(out);
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, store: Store, status: number, headers: Record<string, string>, body: Uint8Array): void {
  res.writeHead(status, {
    ...headers,
    'x-github-request-id': store.nextRequestId(),
  });
  res.end(body);
}

function unauthorized(store: Store): { status: number; headers: Record<string, string>; body: Uint8Array } {
  return { status: 401, headers: { 'content-type': 'application/json' }, body: utf8('{"message":"Requires authentication"}') };
}

export function createApp(store: Store): ReturnType<typeof createServer> {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const authed = (req: IncomingMessage): boolean => {
    if (!expectedToken) return true;
    return req.headers.authorization === `Bearer ${expectedToken}`;
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = url.pathname;
      const method = req.method ?? 'GET';
      const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;

      if (pathname === '/healthz' && method === 'GET') {
        send(res, store, 200, { 'content-type': 'application/json' }, utf8('{"ok":true}'));
        return;
      }

      if (!authed(req)) {
        const u = unauthorized(store);
        send(res, store, u.status, u.headers, u.body);
        return;
      }

      if (pathname.startsWith('/api/v3')) {
        const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);
        const ctx: RestCtx = {
          store, method, pathname, query: url.searchParams,
          headers: req.headers as Record<string, string | string[] | undefined>,
          body, baseUrl,
        };
        const r = handleRest(ctx);
        send(res, store, r.status, r.headers, r.body);
        return;
      }

      if (pathname === '/api/graphql' && method === 'POST') {
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(utf8Str(body));
        } catch {
          send(res, store, 400, { 'content-type': 'application/json' }, utf8('{"message":"Invalid JSON"}'));
          return;
        }
        const r = executeGraphQL(store, parsed);
        send(res, store, r.status, { 'content-type': 'application/json' }, utf8(JSON.stringify(r.body)));
        return;
      }

      if (pathname === '/mcp' && method === 'POST') {
        const body = await readBody(req);
        const r = handleMcp(store, body);
        send(res, store, r.status, r.headers, r.body);
        return;
      }

      const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
      if (gitMatch) {
        const [, owner, repoName, action] = gitMatch;
        const gitProtocol = (req.headers['git-protocol'] as string | undefined) ?? null;
        if (action === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          const r = handleInfoRefs(store, owner, repoName, service, gitProtocol);
          send(res, store, r.status, r.headers, r.body);
          return;
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          // v2 fetch negotiates in rounds inside one request/response pair,
          // so this route is handled streaming instead of read-body-then-answer.
          handleUploadPackStream(store, owner, repoName, req, res, gitProtocol);
          return;
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          const r = handleReceivePack(store, owner, repoName, body);
          send(res, store, r.status, r.headers, r.body);
          return;
        }
        send(res, store, 404, { 'content-type': 'application/json' }, utf8('{"message":"Not Found"}'));
        return;
      }

      send(res, store, 404, { 'content-type': 'application/json' }, utf8('{"message":"Not Found"}'));
    } catch (e) {
      // Never crash the server on a bad request.
      try {
        send(res, store, 500, { 'content-type': 'application/json' }, utf8(JSON.stringify({ message: 'Internal Server Error' })));
      } catch { /* socket already gone */ }
      console.error('handler error:', (e as Error)?.message ?? e);
    }
  });
}
