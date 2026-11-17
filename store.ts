// store.ts — in-memory forge store: repos, objects, refs, issues, PRs,
// labels, comments. Deterministic logical clock (no Date.now, no random).
// Identity: dynamic learning (first owner segment seen wins) with a
// computed fallback from the published deterministic scenario values.

import { buildCommit, buildTag, buildTree, parseCommit, parseTag, parseTree, storeObject, utf8, ZERO_OID } from './util.ts';
import type { GitObject, ObjType, TreeEntry } from './util.ts';

export const SCENARIO_EPOCH = 1735689600; // 2025-01-01T00:00:00Z

// Published deterministic scenario values (kit wire.ts buildScenario(),
// fixed seed 0x6a09e667f3bcc909): viewer adaiversen, stranger olgabauer,
// teammate quinnkeller, org faint-meadow-org, first repo amber-thistle.
export const FALLBACK_VIEWER = 'adaiversen';
export const FALLBACK_VIEWER_NAME = 'ada iversen';
export const FALLBACK_VIEWER_EMAIL = 'adaiversen@example.invalid';
export const FALLBACK_STRANGER = 'olgabauer';
export const FALLBACK_TEAMMATE = 'quinnkeller';
export const FALLBACK_ORG = 'faint-meadow-org';
export const FALLBACK_FIRST_REPO = 'amber-thistle';

export interface Label { name: string; color: string }
export interface Issue {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; createdSeq: number; comments: { id: number; body: string }[];
}
export interface Pull {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  mergeBaseSha: string | null; createdSeq: number;
}
export interface Repo {
  id: number; name: string; owner: string; description: string; private: boolean;
  defaultBranch: string; createdSeq: number;
  refs: Map<string, string>; // full refname -> commit oid
  objects: Map<string, GitObject>;
  issues: Issue[]; pulls: Pull[]; labels: Label[];
  nextNumber: number; // shared issue/PR counter
}

export class Store {
  repos = new Map<string, Repo>();
  seq = 0; // logical clock + creation ordering
  nextId = 1;
  requestId = 0;
  learnedViewer: string | null = null;
  learnedViewerName: string | null = null;

  tick(): number { this.seq += 1; return this.seq; }

  /** Deterministic timestamp string for a commit line at sequence s. */
  tsFor(s: number): number { return SCENARIO_EPOCH + s; }

  isoFor(s: number): string {
    return new Date(this.tsFor(s) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  nextRequestId(): string {
    this.requestId += 1;
    return `req-${this.requestId}`;
  }

  newId(): number { const id = this.nextId; this.nextId += 1; return id; }

  // ---- identity ---------------------------------------------------------

  /** Learn the viewer login from the first owner segment ever seen. */
  learnOwner(owner: string): void {
    if (this.learnedViewer === null && owner) this.learnedViewer = owner;
  }

  viewerLogin(): string { return this.learnedViewer ?? FALLBACK_VIEWER; }

  viewerName(): string {
    if (this.learnedViewerName) return this.learnedViewerName;
    if (this.learnedViewer) return this.learnedViewer;
    return FALLBACK_VIEWER_NAME;
  }

  viewerEmail(): string {
    return this.learnedViewer ? `${this.learnedViewer}@example.invalid` : FALLBACK_VIEWER_EMAIL;
  }

  /** An owner segment that is not the viewer is a stranger: 404, never 403. */
  isViewer(owner: string): boolean { return owner === this.viewerLogin(); }

  // ---- repos ------------------------------------------------------------

  repoKey(owner: string, name: string): string { return `${owner}/${name}`; }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.newId(), name, owner, description, private: isPrivate,
      defaultBranch: 'main', createdSeq: this.tick(),
      refs: new Map(), objects: new Map(), issues: [], pulls: [],
      labels: [
        { name: 'bug', color: 'd73a4a' },
        { name: 'enhancement', color: 'a2eeef' },
        { name: 'documentation', color: '0075ca' },
        { name: 'question', color: 'd876e3' },
        { name: 'good first issue', color: '7057ff' },
        { name: 'help wanted', color: '008672' },
      ],
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listReposFor(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // ---- git objects ------------------------------------------------------

  putObject(repo: Repo, type: ObjType, body: Uint8Array): string {
    return storeObject(repo.objects, type, body);
  }

  getObject(repo: Repo, oid: string): GitObject | null {
    return repo.objects.get(oid) ?? null;
  }

  /** Create a commit object with the logical clock; returns its oid. */
  makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const s = this.tick();
    const ts = this.tsFor(s);
    const ident = `${this.viewerName()} <${this.viewerEmail()}> ${ts} +0000`;
    const body = buildCommit({ tree, parents, author: ident, committer: ident, message });
    return this.putObject(repo, 'commit', body);
  }

  makeTag(repo: Repo, object: string, type: ObjType, tag: string, message: string): string {
    const s = this.tick();
    const ts = this.tsFor(s);
    const tagger = `${this.viewerName()} <${this.viewerEmail()}> ${ts} +0000`;
    const body = buildTag({ object, type, tag, tagger, message });
    return this.putObject(repo, 'tag', body);
  }

  /** Ancestors of `tip` (including tip), BFS by generation. */
  ancestors(repo: Repo, tip: string): Map<string, number> {
    const seen = new Map<string, number>();
    const queue: { oid: string; depth: number }[] = [{ oid: tip, depth: 0 }];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (seen.has(cur.oid)) continue;
      const obj = repo.objects.get(cur.oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.set(cur.oid, cur.depth);
      const info = parseCommit(obj.body);
      for (const p of info.parents) queue.push({ oid: p, depth: cur.depth + 1 });
    }
    return seen;
  }

  isAncestor(repo: Repo, maybeAncestor: string, tip: string): boolean {
    if (maybeAncestor === tip) return true;
    const seen = new Set<string>();
    const queue: string[] = [tip];
    let head = 0;
    while (head < queue.length) {
      const oid = queue[head++];
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const info = parseCommit(obj.body);
      for (const p of info.parents) {
        if (p === maybeAncestor) return true;
        queue.push(p);
      }
    }
    return false;
  }

  /** Merge base: the common ancestor closest to both tips. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancA = this.ancestors(repo, a);
    if (ancA.has(b)) return b;
    const queue: { oid: string; depth: number }[] = [{ oid: b, depth: 0 }];
    const seenB = new Set<string>();
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (seenB.has(cur.oid)) continue;
      seenB.add(cur.oid);
      if (ancA.has(cur.oid)) return cur.oid;
      const obj = repo.objects.get(cur.oid);
      if (!obj || obj.type !== 'commit') continue;
      const info = parseCommit(obj.body);
      for (const p of info.parents) queue.push({ oid: p, depth: cur.depth + 1 });
    }
    return null;
  }

  /** Reachable commits from tips, stopping at shallow boundary commits. */
  reachable(repo: Repo, tips: string[], shallow: Set<string>): Set<string> {
    const out = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (out.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.add(oid);
      if (shallow.has(oid)) continue;
      const info = parseCommit(obj.body);
      for (const p of info.parents) stack.push(p);
    }
    return out;
  }

  /** Resolve a ref-ish (full refname, short branch, or raw oid) to a commit oid. */
  resolveRef(repo: Repo, ref: string | null | undefined): string | null {
    if (!ref) {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (repo.objects.has(ref) && repo.objects.get(ref)!.type === 'commit') return ref;
    if (repo.refs.has(ref)) return repo.refs.get(ref)!;
    const head = repo.refs.get(`refs/heads/${ref}`);
    if (head) return head;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag) return this.peelToCommit(repo, tag);
    return null;
  }

  /** Follow a tag object to its commit; pass through commits. */
  peelToCommit(repo: Repo, oid: string): string | null {
    let cur = oid;
    for (let i = 0; i < 10; i++) {
      const obj = repo.objects.get(cur);
      if (!obj) return null;
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') { cur = parseTag(obj.body).object; continue; }
      return null;
    }
    return null;
  }

  // ---- trees -------------------------------------------------------------

  /** Build (and store) a tree from a flat path -> {oid, mode} map. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    const build = (paths: Map<string, { oid: string; mode: string }>): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, v] of paths) {
        const slash = path.indexOf('/');
        if (slash < 0) entries.push({ mode: v.mode, name: path, oid: v.oid });
        else {
          const dir = path.slice(0, slash);
          let sub = dirs.get(dir);
          if (!sub) { sub = new Map(); dirs.set(dir, sub); }
          sub.set(path.slice(slash + 1), v);
        }
      }
      for (const [dir, sub] of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(sub) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(flat);
  }

  /** Flatten a tree oid into path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.body)) {
        if (e.mode === '40000') walk(e.oid, prefix + e.name + '/');
        else out.set(prefix + e.name, { oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Tree of a commit (empty tree when the repo has no commits yet). */
  treeOfCommit(repo: Repo, commitOid: string | null): Map<string, { oid: string; mode: string }> {
    if (!commitOid) return new Map();
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(obj.body).tree);
  }

  emptyTreeOid(repo: Repo): string {
    return this.putObject(repo, 'tree', new Uint8Array(0));
  }
}

export function isZeroOid(oid: string): boolean {
  return oid === ZERO_OID;
}

export { utf8 };
