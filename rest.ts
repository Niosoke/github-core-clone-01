// rest.ts — GitHub REST v3: repos, branches, commits, contents, labels,
// issues, comments, pull requests, merges. All JSON, deterministic ids and
// timestamps (logical clock), owner != viewer -> 404 (never 403).

import { b64decode, b64encode, lineDiff, parseCommit, parseTree, utf8, utf8Str } from './util.ts';
import { SCENARIO_EPOCH, type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface RestCtx {
  store: Store;
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array | null;
  baseUrl: string; // e.g. http://127.0.0.1:PORT
}

export interface RestResponse { status: number; headers: Record<string, string>; body: Uint8Array }

function json(status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: utf8(typeof value === 'string' ? value : JSON.stringify(value)),
  };
}

function err(status: number, message: string): RestResponse {
  return json(status, { message });
}

function parseBody(ctx: RestCtx): { ok: true; value: any } | { ok: false; res: RestResponse } {
  if (!ctx.body || ctx.body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(utf8Str(ctx.body)) };
  } catch {
    return { ok: false, res: err(400, 'Invalid JSON') };
  }
}

function pageParams(ctx: RestCtx): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function linkHeader(ctx: RestCtx, total: number, perPage: number, page: number): Record<string, string> {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `${ctx.baseUrl}${ctx.pathname}?${q.toString()}`;
  };
  if (page < pages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(pages)}>; rel="last"`);
  return links.length > 0 ? { link: links.join(', ') } : {};
}

function paginate<T>(ctx: RestCtx, items: T[]): { items: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageParams(ctx);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), headers: linkHeader(ctx, items.length, perPage, page) };
}

// ---- serializers ---------------------------------------------------------

function repoJson(store: Store, r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: r.owner === store.viewerLogin() ? 1000 : 1002, type: 'User' },
    private: r.private,
    description: r.description,
    default_branch: r.defaultBranch,
    fork: false,
    created_at: store.isoFor(r.createdSeq),
    updated_at: store.isoFor(r.createdSeq),
    html_url: `https://example.invalid/${r.owner}/${r.name}`,
  };
}

function issueJson(store: Store, r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((name) => ({ name })),
    user: { login: store.viewerLogin() },
    created_at: store.isoFor(i.createdSeq),
    updated_at: store.isoFor(i.createdSeq),
  };
}

function pullJson(store: Store, r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha,
    head: { ref: p.headRef, sha: p.headSha, label: `${r.owner}:${p.headRef}` },
    base: { ref: p.baseRef, sha: p.baseSha, label: `${r.owner}:${p.baseRef}` },
    user: { login: store.viewerLogin() },
    created_at: store.isoFor(p.createdSeq),
    updated_at: store.isoFor(p.createdSeq),
  };
}

// ---- repo lookup ----------------------------------------------------------

function getRepoOr404(ctx: RestCtx, owner: string, name: string): { repo: Repo } | { res: RestResponse } {
  ctx.store.learnOwner(owner);
  if (!ctx.store.isViewer(owner)) return { res: err(404, 'Not Found') };
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return { res: err(404, 'Not Found') };
  return { repo };
}

// ---- contents helpers -----------------------------------------------------

function commitTreeChange(ctx: RestCtx, repo: Repo, branch: string, message: string, mutate: (flat: Map<string, { oid: string; mode: string }>) => void): { commitSha: string; tipBefore: string | null } | { res: RestResponse } {
  const refName = `refs/heads/${branch}`;
  const tipBefore = repo.refs.get(refName) ?? null;
  const flat = ctx.store.treeOfCommit(repo, tipBefore);
  mutate(flat);
  const treeOid = ctx.store.buildTreeFromFlat(repo, flat);
  const parents = tipBefore ? [tipBefore] : [];
  const commitSha = ctx.store.makeCommit(repo, treeOid, parents, message);
  repo.refs.set(refName, commitSha);
  return { commitSha, tipBefore };
}

// ---- main handler ---------------------------------------------------------

export function handleRest(ctx: RestCtx): RestResponse {
  const { store, method } = ctx;
  const seg = ctx.pathname.split('/').filter((s) => s.length > 0);
  // seg[0] === 'api', seg[1] === 'v3', rest follows.
  const rest = seg.slice(2);

  if (rest.length === 0) {
    if (method === 'GET') {
      return json(200, { current_user_url: `${ctx.baseUrl}/api/v3/user` }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'meta' && method === 'GET') {
    return json(200, { installed_version: '1.0.0' });
  }

  if (rest[0] === 'rate_limit' && method === 'GET') {
    return json(200, {
      resources: { core: { limit: 5000, remaining: 5000, reset: SCENARIO_EPOCH + 3600 } },
      rate: { limit: 5000, remaining: 5000, reset: SCENARIO_EPOCH + 3600 },
    });
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') {
      return json(200, {
        login: store.viewerLogin(),
        id: 1000,
        name: store.viewerName(),
        email: store.viewerEmail(),
        type: 'User',
      });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.res;
      const b = parsed.value ?? {};
      const name = typeof b.name === 'string' ? b.name : '';
      if (!name) return err(422, 'name is required');
      const owner = store.viewerLogin();
      if (store.getRepo(owner, name)) return err(422, `Repository ${owner}/${name} already exists`);
      const repo = store.createRepo(owner, name, typeof b.description === 'string' ? b.description : '', b.private === true);
      return json(201, repoJson(store, repo));
    }
    if (method === 'GET') {
      const list = store.listReposFor(store.viewerLogin()).map((r) => repoJson(store, r));
      const { items, headers } = paginate(ctx, list);
      return json(200, items, headers);
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const name = rest[2];
    const tail = rest.slice(3);
    const found = getRepoOr404(ctx, owner, name);
    if ('res' in found) return found.res;
    const repo = found.repo;

    if (tail.length === 0) {
      if (method === 'GET') return json(200, repoJson(store, repo));
      if (method === 'PATCH') {
        const parsed = parseBody(ctx);
        if (!parsed.ok) return parsed.res;
        const b = parsed.value ?? {};
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.private = b.private;
        if (typeof b.default_branch === 'string') repo.defaultBranch = b.default_branch;
        return json(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, headers: {}, body: new Uint8Array(0) };
      }
      return err(404, 'Not Found');
    }

    // branches
    if (tail[0] === 'branches') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort();
      if (tail.length === 1 && method === 'GET') {
        return json(200, branches.map((b) => ({ name: b, commit: { sha: repo.refs.get(`refs/heads/${b}`) } })));
      }
      if (tail.length >= 2 && method === 'GET') {
        const branch = tail.slice(1).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return err(404, 'Not Found');
        return json(200, { name: branch, commit: { sha } });
      }
      return err(404, 'Not Found');
    }

    // commits
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const ref = ctx.query.get('sha') ?? undefined;
      const tip = store.resolveRef(repo, ref);
      if (!tip) return json(200, []);
      const anc = store.ancestors(repo, tip);
      const entries: { sha: string; ts: number; message: string }[] = [];
      for (const oid of anc.keys()) {
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const info = parseCommit(obj.body);
        const m = info.author.match(/ (\d+) \+0000$/);
        entries.push({ sha: oid, ts: m ? parseInt(m[1], 10) : 0, message: info.message });
      }
      entries.sort((a, b) => b.ts - a.ts);
      return json(200, entries.map((e) => ({ sha: e.sha, commit: { message: e.message } })));
    }

    // git refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const parsed = parseBody(ctx);
        if (!parsed.ok) return parsed.res;
        const b = parsed.value ?? {};
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref || !sha) return err(422, 'ref and sha are required');
        const obj = repo.objects.get(sha);
        if (!obj) return err(422, 'object does not exist');
        let stored = sha;
        if (ref.startsWith('refs/heads/') && obj.type === 'tag') {
          stored = store.peelToCommit(repo, sha) ?? sha;
        }
        repo.refs.set(ref, stored);
        return json(201, { ref, object: { sha: stored } });
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = tail.slice(2).join('/');
        const sha = repo.refs.get(ref);
        if (!sha) return err(404, 'Not Found');
        return json(200, { ref, object: { sha } });
      }
      return err(404, 'Not Found');
    }

    // contents
    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      if (!path) return err(404, 'Not Found');
      if (method === 'GET') {
        const ref = ctx.query.get('ref') ?? undefined;
        const tip = store.resolveRef(repo, ref);
        const flat = store.treeOfCommit(repo, tip);
        const file = flat.get(path);
        if (file) {
          const blob = repo.objects.get(file.oid);
          if (!blob) return err(404, 'Not Found');
          return json(200, {
            type: 'file', encoding: 'base64', name: path.split('/').pop(), path,
            content: b64encode(blob.body), sha: file.oid, size: blob.body.length,
          });
        }
        // Directory: walk the tree to the path and list its entries.
        if (tip) {
          const commitObj = repo.objects.get(tip);
          if (commitObj && commitObj.type === 'commit') {
            let treeOid = parseCommit(commitObj.body).tree;
            let found = true;
            for (const part of path.split('/')) {
              const treeObj = repo.objects.get(treeOid);
              if (!treeObj || treeObj.type !== 'tree') { found = false; break; }
              const entry = parseTree(treeObj.body).find((e) => e.name === part);
              if (!entry || entry.mode !== '40000') { found = false; break; }
              treeOid = entry.oid;
            }
            if (found) {
              const treeObj = repo.objects.get(treeOid);
              if (treeObj && treeObj.type === 'tree') {
                const items = parseTree(treeObj.body)
                  .sort((a, b) => (a.name < b.name ? -1 : 1))
                  .map((e) => ({
                    type: e.mode === '40000' ? 'dir' : 'file',
                    name: e.name, path: `${path}/${e.name}`, sha: e.oid,
                  }));
                return json(200, items);
              }
            }
          }
        }
        return err(404, 'Not Found');
      }
      if (method === 'PUT') {
        const parsed = parseBody(ctx);
        if (!parsed.ok) return parsed.res;
        const b = parsed.value ?? {};
        const message = typeof b.message === 'string' ? b.message : 'update';
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const content = b64decode(contentB64);
        const refName = `refs/heads/${branch}`;
        const tipBefore = repo.refs.get(refName) ?? null;
        const flatBefore = store.treeOfCommit(repo, tipBefore);
        const existing = flatBefore.get(path);
        if (existing) {
          if (typeof b.sha !== 'string') return err(422, 'sha is required to update a file');
          if (b.sha !== existing.oid) return err(409, 'sha does not match');
        } else if (typeof b.sha === 'string') {
          return err(422, 'sha given but file does not exist');
        }
        const blobSha = store.putObject(repo, 'blob', content);
        const made = commitTreeChange(ctx, repo, branch, message, (flat) => {
          flat.set(path, { oid: blobSha, mode: '100644' });
        });
        if ('res' in made) return made.res;
        const created = !existing;
        return json(created ? 201 : 200, {
          content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, encoding: 'base64', content: contentB64 },
          commit: { sha: made.commitSha },
        });
      }
      if (method === 'DELETE') {
        const parsed = parseBody(ctx);
        if (!parsed.ok) return parsed.res;
        const b = parsed.value ?? {};
        const message = typeof b.message === 'string' ? b.message : 'delete';
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        const tipBefore = repo.refs.get(refName) ?? null;
        const flatBefore = store.treeOfCommit(repo, tipBefore);
        const existing = flatBefore.get(path);
        if (!existing) return err(404, 'Not Found');
        if (typeof b.sha === 'string' && b.sha !== existing.oid) return err(409, 'sha does not match');
        const made = commitTreeChange(ctx, repo, branch, message, (flat) => { flat.delete(path); });
        if ('res' in made) return made.res;
        return json(200, { commit: { sha: made.commitSha } });
      }
      return err(404, 'Not Found');
    }

    // labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        return json(200, repo.labels.map((l) => ({ name: l.name, color: l.color })));
      }
      if (method === 'POST' && tail.length === 1) {
        const parsed = parseBody(ctx);
        if (!parsed.ok) return parsed.res;
        const b = parsed.value ?? {};
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name) return err(422, 'name is required');
        const color = typeof b.color === 'string' ? b.color : 'ededed';
        const existing = repo.labels.find((l) => l.name === name);
        if (existing) return json(201, { name: existing.name, color: existing.color });
        repo.labels.push({ name, color });
        return json(201, { name, color });
      }
      return err(404, 'Not Found');
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const parsed = parseBody(ctx);
          if (!parsed.ok) return parsed.res;
          const b = parsed.value ?? {};
          const title = typeof b.title === 'string' ? b.title : '';
          if (!title) return err(422, 'title is required');
          const labelNames: string[] = Array.isArray(b.labels)
            ? b.labels.map((l: unknown) => (typeof l === 'string' ? l : (l as { name?: string }).name ?? '')).filter(Boolean)
            : [];
          for (const ln of labelNames) {
            if (!repo.labels.some((l) => l.name === ln)) return err(422, `label ${ln} does not exist`);
          }
          const issue: Issue = {
            number: repo.nextNumber, id: store.newId(), title,
            body: typeof b.body === 'string' ? b.body : '', state: 'open',
            labels: labelNames, createdSeq: store.tick(), comments: [],
          };
          repo.nextNumber += 1;
          repo.issues.push(issue);
          return json(201, issueJson(store, repo, issue));
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const direction = ctx.query.get('direction') ?? 'desc';
          let list = repo.issues.filter((i) => state === 'all' || i.state === state);
          list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          const { items, headers } = paginate(ctx, list.map((i) => issueJson(store, repo, i)));
          return json(200, items, headers);
        }
        return err(404, 'Not Found');
      }
      const num = parseInt(tail[1], 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (tail.length === 2) {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') return json(200, issueJson(store, repo, issue));
        if (method === 'PATCH') {
          const parsed = parseBody(ctx);
          if (!parsed.ok) return parsed.res;
          const b = parsed.value ?? {};
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          return json(200, issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (method === 'POST') {
          const parsed = parseBody(ctx);
          if (!parsed.ok) return parsed.res;
          const b = parsed.value ?? {};
          const body = typeof b.body === 'string' ? b.body : '';
          const comment = { id: store.newId(), body };
          issue.comments.push(comment);
          return json(201, { id: comment.id, body: comment.body, user: { login: store.viewerLogin() } });
        }
        if (method === 'GET') {
          return json(200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: store.viewerLogin() } })));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const parsed = parseBody(ctx);
          if (!parsed.ok) return parsed.res;
          const b = parsed.value ?? {};
          const headRef = typeof b.head === 'string' ? b.head : '';
          const baseRef = typeof b.base === 'string' ? b.base : '';
          const title = typeof b.title === 'string' ? b.title : '';
          if (!headRef || !baseRef || !title) return err(422, 'head, base and title are required');
          const headSha = store.resolveRef(repo, headRef);
          const baseSha = store.resolveRef(repo, baseRef);
          if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
          const mergeBaseSha = store.mergeBase(repo, headSha, baseSha);
          const pull: Pull = {
            number: repo.nextNumber, id: store.newId(), title,
            body: typeof b.body === 'string' ? b.body : '', state: 'open',
            merged: false, mergedAt: null, mergeCommitSha: null,
            headRef, baseRef, headSha, baseSha, mergeBaseSha,
            createdSeq: store.tick(),
          };
          repo.nextNumber += 1;
          repo.pulls.push(pull);
          return json(201, pullJson(store, repo, pull));
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = repo.pulls.filter((p) => state === 'all' ? (p.state === 'open' || p.state === 'closed') : p.state === state);
          list = [...list].sort((a, b) => b.createdSeq - a.createdSeq);
          const { items, headers } = paginate(ctx, list.map((p) => pullJson(store, repo, p)));
          return json(200, items, headers);
        }
        return err(404, 'Not Found');
      }
      const num = parseInt(tail[1], 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return err(404, 'Not Found');
      if (tail.length === 2 && method === 'GET') {
        return json(200, pullJson(store, repo, pull));
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const baseTree = store.treeOfCommit(repo, pull.mergeBaseSha);
        const headTree = store.treeOfCommit(repo, store.resolveRef(repo, pull.headRef) ?? pull.headSha);
        const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
        const files: Record<string, unknown>[] = [];
        for (const p of [...paths].sort()) {
          const inBase = baseTree.get(p);
          const inHead = headTree.get(p);
          if (!inBase && inHead) {
            const blob = repo.objects.get(inHead.oid);
            const text = blob ? utf8Str(blob.body) : '';
            const d = lineDiff('', text);
            files.push({ filename: p, status: 'added', additions: d.additions, deletions: 0, changes: d.additions });
          } else if (inBase && !inHead) {
            const blob = repo.objects.get(inBase.oid);
            const text = blob ? utf8Str(blob.body) : '';
            const d = lineDiff(text, '');
            files.push({ filename: p, status: 'removed', additions: 0, deletions: d.deletions, changes: d.deletions });
          } else if (inBase && inHead && inBase.oid !== inHead.oid) {
            const oldBlob = repo.objects.get(inBase.oid);
            const newBlob = repo.objects.get(inHead.oid);
            const d = lineDiff(oldBlob ? utf8Str(oldBlob.body) : '', newBlob ? utf8Str(newBlob.body) : '');
            files.push({ filename: p, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
          }
        }
        return json(200, files);
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull.state !== 'open') return err(405, 'pull request is not open');
        const baseTip = store.resolveRef(repo, pull.baseRef);
        const headTip = store.resolveRef(repo, pull.headRef);
        if (!baseTip || !headTip) return err(404, 'Not Found');
        const baseTree = store.treeOfCommit(repo, pull.mergeBaseSha);
        const headTree = store.treeOfCommit(repo, headTip);
        const tipTree = store.treeOfCommit(repo, baseTip);
        // Conflict rule: path changed head-vs-merge-base, and base-tip differs
        // from merge-base AND head differs from base-tip.
        const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
        for (const p of paths) {
          const b = baseTree.get(p)?.oid;
          const h = headTree.get(p)?.oid;
          if (b === h) continue;
          const t = tipTree.get(p)?.oid;
          if (t !== b && h !== t) return err(405, 'merge conflict');
        }
        // Squash: base-tip tree overlaid with head-vs-merge-base changes.
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
        return json(200, { merged: true, sha: mergeSha, message: pull.title });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
