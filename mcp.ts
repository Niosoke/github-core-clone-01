// mcp.ts — MCP over streamable HTTP (legacy era): server/discover answers
// -32601 so the client falls back to the initialize handshake; initialize,
// notifications/initialized (202, empty), tools/list (six canonical tools),
// tools/call. Plain JSON answers (no SSE). Same store as REST.

import { utf8Str } from './util.ts';
import type { Store } from './store.ts';

export interface McpResponse { status: number; headers: Record<string, string>; body: Uint8Array }

function text(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: text(JSON.stringify({ jsonrpc: '2.0', id, result })) };
}

function rpcError(id: unknown, code: number, message: string): McpResponse {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: text(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })) };
}

const TOOLS: Record<string, any>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

function toolResult(obj: unknown): Record<string, unknown> {
  const str = JSON.stringify(obj);
  return { content: [{ type: 'text', text: str }], structuredContent: obj, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], structuredContent: { error: message }, isError: true };
}

function missingArgs(tool: Record<string, any>, args: Record<string, any>): string | null {
  const required: string[] = tool.inputSchema?.required ?? [];
  for (const r of required) {
    if (args[r] === undefined || args[r] === null || args[r] === '') return `missing required argument: ${r}`;
  }
  return null;
}

export function handleMcp(store: Store, body: Uint8Array | null): McpResponse {
  if (!body || body.length === 0) {
    return { status: 400, headers: { 'content-type': 'application/json' }, body: text(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })) };
  }
  let req: any;
  try {
    req = JSON.parse(utf8Str(body));
  } catch {
    return { status: 400, headers: { 'content-type': 'application/json' }, body: text(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })) };
  }
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';

  // Notification without id: 202, empty body.
  if (id === null || id === undefined) {
    if (method === 'notifications/initialized') {
      return { status: 202, headers: {}, body: new Uint8Array(0) };
    }
    return { status: 202, headers: {}, body: new Uint8Array(0) };
  }

  if (method === 'server/discover') {
    // Legacy era: not supported; client falls back to initialize.
    return rpcError(id, -32601, 'Method not found');
  }

  if (method === 'initialize') {
    const params = req.params ?? {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: 'makefun-forge', version: '1.0.0' },
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const params = req.params ?? {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args: Record<string, any> = (params.arguments ?? {}) as Record<string, any>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
    const missing = missingArgs(tool, args);
    if (missing) return rpcError(id, -32602, missing);

    if (name === 'create_repo') {
      const owner = store.viewerLogin();
      if (store.getRepo(owner, String(args.name))) {
        return rpcResult(id, toolError(`Repository ${owner}/${args.name} already exists`));
      }
      const repo = store.createRepo(owner, String(args.name), typeof args.description === 'string' ? args.description : '', args.private === true);
      return rpcResult(id, toolResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.private, description: repo.description, default_branch: repo.defaultBranch }));
    }

    const owner = String(args.owner ?? '');
    const repoName = String(args.repo ?? '');
    store.learnOwner(owner);
    if (!store.isViewer(owner)) {
      return rpcResult(id, toolError('Not Found'));
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      return rpcResult(id, toolError('Not Found'));
    }

    if (name === 'get_repo') {
      return rpcResult(id, toolResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.private, description: repo.description, default_branch: repo.defaultBranch }));
    }

    if (name === 'create_issue') {
      const issue = {
        number: repo.nextNumber, id: store.newId(), title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '', state: 'open',
        labels: [] as string[], createdSeq: store.tick(), comments: [] as { id: number; body: string }[],
      };
      repo.nextNumber += 1;
      repo.issues.push(issue);
      return rpcResult(id, toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
    }

    if (name === 'list_issues') {
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }));
      return rpcResult(id, toolResult(list));
    }

    if (name === 'create_pull_request') {
      const headSha = store.resolveRef(repo, String(args.head));
      const baseSha = store.resolveRef(repo, String(args.base));
      if (!headSha || !baseSha) {
        return rpcResult(id, toolError('head or base branch does not exist'));
      }
      const pull = {
        number: repo.nextNumber, id: store.newId(), title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '', state: 'open' as const,
        merged: false, mergedAt: null, mergeCommitSha: null,
        headRef: String(args.head), baseRef: String(args.base),
        headSha, baseSha, mergeBaseSha: store.mergeBase(repo, headSha, baseSha),
        createdSeq: store.tick(),
      };
      repo.nextNumber += 1;
      repo.pulls.push(pull);
      return rpcResult(id, toolResult({ id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha } }));
    }

    if (name === 'merge_pull_request') {
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) return rpcResult(id, toolError('pull request not found'));
      if (pull.state !== 'open') return rpcResult(id, toolError('pull request is not open'));
      const baseTip = store.resolveRef(repo, pull.baseRef);
      const headTip = store.resolveRef(repo, pull.headRef);
      if (!baseTip || !headTip) return rpcResult(id, toolError('branch not found'));
      const baseTree = store.treeOfCommit(repo, pull.mergeBaseSha);
      const headTree = store.treeOfCommit(repo, headTip);
      const tipTree = store.treeOfCommit(repo, baseTip);
      const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
      for (const p of paths) {
        const b = baseTree.get(p)?.oid;
        const h = headTree.get(p)?.oid;
        if (b === h) continue;
        const t = tipTree.get(p)?.oid;
        if (t !== b && h !== t) return rpcResult(id, toolError('merge conflict'));
      }
      const result = new Map(tipTree);
      for (const p of paths) {
        const b = baseTree.get(p);
        const h = headTree.get(p);
        if (!b && h) result.set(p, h);
        else if (b && !h) result.delete(p);
        else if (b && h && b.oid !== h.oid) result.set(p, h);
      }
      const treeOid = store.buildTreeFromFlat(repo, result);
      const mergeSha = store.makeCommit(repo, treeOid, [baseTip], pull.title);
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = store.isoFor(store.seq);
      pull.mergeCommitSha = mergeSha;
      return rpcResult(id, toolResult({ merged: true, sha: mergeSha, number: pull.number }));
    }

    return rpcError(id, -32602, `unknown tool: ${name}`);
  }

  return rpcError(id, -32601, 'Method not found');
}
