// graphql.ts — small GraphQL executor for the 18 fixed documents the
// conformance suite sends, plus __type introspection. Hand-written lexer +
// recursive-descent parser; per-type resolver tables. Unknown field ->
// HTTP 200 with an `errors` entry (never an HTTP error, except 401).

import { b64decode, b64encode, lineDiff, utf8Str } from './util.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// ---- lexer ----------------------------------------------------------------

type Tok =
  | { k: 'name'; v: string }
  | { k: 'str'; v: string }
  | { k: 'int'; v: number }
  | { k: 'float'; v: number }
  | { k: 'punct'; v: string }
  | { k: 'spread' }
  | { k: 'var'; v: string };

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { toks.push({ k: 'spread' }); i += 3; continue; }
    if ('{}()[]:!=@'.includes(c)) { toks.push({ k: 'punct', v: c }); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else out += e;
          j += 2;
        } else { out += src[j]; j++; }
      }
      toks.push({ k: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ k: 'var', v: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.') { isFloat = true; j++; while (j < src.length && /[0-9]/.test(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true; j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const num = Number(src.slice(i, j));
      toks.push(isFloat ? { k: 'float', v: num } : { k: 'int', v: num });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ k: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  return toks;
}

// ---- AST ------------------------------------------------------------------

interface ValueNode { kind: 'var' | 'str' | 'int' | 'float' | 'bool' | 'null' | 'enum' | 'list' | 'object'; value: any }
interface FieldNode {
  kind: 'field'; name: string; alias: string | null; args: Record<string, ValueNode>; selection: SelectionNode[];
}
interface FragmentNode { kind: 'fragment'; typeCondition: string | null; selection: SelectionNode[] }
type SelectionNode = FieldNode | FragmentNode;
interface VarDef { name: string; defaultValue: ValueNode | null }
interface Operation { kind: 'query' | 'mutation'; name: string | null; varDefs: VarDef[]; selection: SelectionNode[] }
interface FragmentDef { name: string; typeCondition: string; selection: SelectionNode[] }

class Parser {
  toks: Tok[]; pos = 0; fragments = new Map<string, FragmentDef>();
  constructor(src: string) { this.toks = lex(src); }

  peek(): Tok | null { return this.toks[this.pos] ?? null; }
  next(): Tok { return this.toks[this.pos++]; }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.k !== 'punct' || t.v !== v) throw new Error(`expected ${v}`);
  }
  skipDirectives(): void {
    while (this.peek()?.k === 'punct' && (this.peek() as any).v === '@') {
      this.next();
      const n = this.next();
      if (n.k !== 'name') throw new Error('directive name expected');
      if (this.peek()?.k === 'punct' && (this.peek() as any).v === '(') this.parseArgs();
    }
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.toks.length) {
      const t = this.peek();
      if (t?.k === 'name' && (t.v === 'query' || t.v === 'mutation')) {
        this.next();
        const kind = t.v as 'query' | 'mutation';
        let name: string | null = null;
        const nt = this.peek();
        if (nt?.k === 'name') { name = nt.v; this.next(); }
        const varDefs = this.parseVarDefs();
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        ops.push({ kind, name, varDefs, selection });
      } else if (t?.k === 'name' && t.v === 'fragment') {
        this.next();
        const nameTok = this.next();
        if (nameTok.k !== 'name') throw new Error('fragment name expected');
        const onTok = this.next();
        if (onTok.k !== 'name' || onTok.v !== 'on') throw new Error('fragment on expected');
        const typeTok = this.next();
        if (typeTok.k !== 'name') throw new Error('fragment type expected');
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        this.fragments.set(nameTok.v, { name: nameTok.v, typeCondition: typeTok.v, selection });
      } else if (t?.k === 'punct' && t.v === '{') {
        const selection = this.parseSelectionSet();
        ops.push({ kind: 'query', name: null, varDefs: [], selection });
      } else {
        throw new Error('unexpected token in document');
      }
    }
    return ops;
  }

  parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    if (this.peek()?.k === 'punct' && (this.peek() as any).v === '(') {
      this.next();
      while (!(this.peek()?.k === 'punct' && (this.peek() as any).v === ')')) {
        const v = this.next();
        if (v.k !== 'var') throw new Error('variable expected');
        this.expectPunct(':');
        this.parseType();
        let def: ValueNode | null = null;
        if (this.peek()?.k === 'punct' && (this.peek() as any).v === '=') {
          this.next();
          def = this.parseValue();
        }
        defs.push({ name: v.v, defaultValue: def });
      }
      this.next();
    }
    return defs;
  }

  parseType(): void {
    const t = this.peek();
    if (t?.k === 'punct' && t.v === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else if (t?.k === 'name') {
      this.next();
    } else throw new Error('type expected');
    if (this.peek()?.k === 'punct' && (this.peek() as any).v === '!') this.next();
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!(this.peek()?.k === 'punct' && (this.peek() as any).v === '}')) {
      const t = this.peek();
      if (!t) throw new Error('unterminated selection set');
      if (t.k === 'spread') {
        this.next();
        const nt = this.peek();
        if (nt?.k === 'name' && nt.v === 'on') {
          this.next();
          const typeTok = this.next();
          if (typeTok.k !== 'name') throw new Error('fragment type expected');
          this.skipDirectives();
          const sub = this.parseSelectionSet();
          sels.push({ kind: 'fragment', typeCondition: typeTok.v, selection: sub });
        } else if (nt?.k === 'name') {
          this.next();
          const frag = this.fragments.get(nt.v);
          if (frag) sels.push({ kind: 'fragment', typeCondition: frag.typeCondition, selection: frag.selection });
          this.skipDirectives();
        } else throw new Error('fragment spread expected');
      } else if (t.k === 'name') {
        const first = this.next() as { k: 'name'; v: string };
        let alias: string | null = null;
        let name = first.v;
        const colon = this.peek();
        if (colon?.k === 'punct' && colon.v === ':') {
          this.next();
          const nameTok = this.next();
          if (nameTok.k !== 'name') throw new Error('field name expected');
          alias = first.v;
          name = nameTok.v;
        }
        const args = this.parseArgs();
        this.skipDirectives();
        let selection: SelectionNode[] = [];
        if (this.peek()?.k === 'punct' && (this.peek() as any).v === '{') {
          selection = this.parseSelectionSet();
        }
        sels.push({ kind: 'field', name, alias, args, selection });
      } else throw new Error('selection expected');
    }
    this.next();
    return sels;
  }

  parseArgs(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.k === 'punct' && (this.peek() as any).v === '(') {
      this.next();
      while (!(this.peek()?.k === 'punct' && (this.peek() as any).v === ')')) {
        const n = this.next();
        if (n.k !== 'name') throw new Error('argument name expected');
        this.expectPunct(':');
        args[n.v] = this.parseValue();
      }
      this.next();
    }
    return args;
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.k === 'var') return { kind: 'var', value: t.v };
    if (t.k === 'str') return { kind: 'str', value: t.v };
    if (t.k === 'int') return { kind: 'int', value: t.v };
    if (t.k === 'float') return { kind: 'float', value: t.v };
    if (t.k === 'punct' && t.v === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.k === 'punct' && (this.peek() as any).v === ']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', value: items };
    }
    if (t.k === 'punct' && t.v === '{') {
      const obj: Record<string, ValueNode> = {};
      while (!(this.peek()?.k === 'punct' && (this.peek() as any).v === '}')) {
        const n = this.next();
        if (n.k !== 'name') throw new Error('object key expected');
        this.expectPunct(':');
        obj[n.v] = this.parseValue();
      }
      this.next();
      return { kind: 'object', value: obj };
    }
    if (t.k === 'name') {
      if (t.v === 'true') return { kind: 'bool', value: true };
      if (t.v === 'false') return { kind: 'bool', value: false };
      if (t.v === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.v };
    }
    throw new Error('value expected');
  }
}

function evalValue(node: ValueNode, variables: Record<string, any>): any {
  switch (node.kind) {
    case 'var': return variables[node.value] ?? null;
    case 'str': case 'int': case 'float': case 'bool': case 'enum': case 'null': return node.value;
    case 'list': return node.value.map((v: ValueNode) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(node.value)) out[k] = evalValue(v as ValueNode, variables);
      return out;
    }
  }
}

// ---- global ids -----------------------------------------------------------

function gid(kind: string, ...parts: (string | number)[]): string {
  return b64encode(new TextEncoder().encode(`${kind}:${parts.join(':')}`));
}

function ungid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = utf8Str(b64decode(id));
    const i = text.indexOf(':');
    if (i < 0) return null;
    return { kind: text.slice(0, i), parts: text.slice(i + 1).split(':') };
  } catch {
    return null;
  }
}

// ---- introspection tables -------------------------------------------------

const TYPE_INFO: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'labels', 'author', 'createdAt', 'repository', 'url', 'comments', 'closed', 'createdAtHumanized'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'labels', 'author', 'createdAt', 'repository', 'url', 'headRef', 'baseRef'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'url', 'createdAt'],
    enumValues: [],
  },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'], enumValues: [] },
};

// ---- executor --------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, any>;
  errors: { message: string }[];
}

type AnyObj = Record<string, any>;

function wrapIssue(store: Store, repo: Repo, issue: Issue): AnyObj {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function wrapPull(store: Store, repo: Repo, pull: Pull): AnyObj {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function wrapRepo(store: Store, repo: Repo): AnyObj {
  return { __typename: 'Repository', __repo: repo };
}

function repoGid(repo: Repo): string { return gid('repo', repo.owner, repo.name, repo.id); }
function issueGid(repo: Repo, issue: Issue): string { return gid('issue', repo.owner, repo.name, issue.number); }
function pullGid(repo: Repo, pull: Pull): string { return gid('pr', repo.owner, repo.name, pull.number); }

function cursorFor(index: number): string { return b64encode(new TextEncoder().encode(`cursor:${index}`)); }
function indexOfCursor(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  try {
    const text = utf8Str(b64decode(cursor));
    if (text.startsWith('cursor:')) return parseInt(text.slice(7), 10);
  } catch { /* ignore */ }
  return -1;
}

function makeConnection<T>(items: T[], args: Record<string, any>, typename: string, edgeTypename: string): AnyObj {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const afterIdx = indexOfCursor(args.after ?? null);
  const start = afterIdx + 1;
  const page = items.slice(start, start + first);
  const endCursor = page.length > 0 ? cursorFor(start + page.length - 1) : null;
  const startCursor = page.length > 0 ? cursorFor(start) : null;
  return {
    __typename: typename,
    nodes: page,
    edges: page.map((node, i) => ({ __typename: edgeTypename, node, cursor: cursorFor(start + i) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor,
      endCursor,
    },
    totalCount: items.length,
  };
}

function prFiles(store: Store, repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number }[] {
  const baseTree = store.treeOfCommit(repo, pull.mergeBaseSha);
  const headTree = store.treeOfCommit(repo, store.resolveRef(repo, pull.headRef) ?? pull.headSha);
  const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
  const out: { filename: string; status: string; additions: number; deletions: number }[] = [];
  for (const p of [...paths].sort()) {
    const inBase = baseTree.get(p);
    const inHead = headTree.get(p);
    if (!inBase && inHead) {
      const blob = repo.objects.get(inHead.oid);
      const d = lineDiff('', blob ? utf8Str(blob.body) : '');
      out.push({ filename: p, status: 'added', additions: d.additions, deletions: 0 });
    } else if (inBase && !inHead) {
      const blob = repo.objects.get(inBase.oid);
      const d = lineDiff(blob ? utf8Str(blob.body) : '', '');
      out.push({ filename: p, status: 'removed', additions: 0, deletions: d.deletions });
    } else if (inBase && inHead && inBase.oid !== inHead.oid) {
      const oldBlob = repo.objects.get(inBase.oid);
      const newBlob = repo.objects.get(inHead.oid);
      const d = lineDiff(oldBlob ? utf8Str(oldBlob.body) : '', newBlob ? utf8Str(newBlob.body) : '');
      out.push({ filename: p, status: 'modified', additions: d.additions, deletions: d.deletions });
    }
  }
  return out;
}

function prMergeable(store: Store, repo: Repo, pull: Pull): string {
  if (pull.merged) return 'MERGEABLE';
  const baseTip = store.resolveRef(repo, pull.baseRef);
  const headTip = store.resolveRef(repo, pull.headRef);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const baseTree = store.treeOfCommit(repo, pull.mergeBaseSha);
  const headTree = store.treeOfCommit(repo, headTip);
  const tipTree = store.treeOfCommit(repo, baseTip);
  const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
  for (const p of paths) {
    const b = baseTree.get(p)?.oid;
    const h = headTree.get(p)?.oid;
    if (b === h) continue;
    const t = tipTree.get(p)?.oid;
    if (t !== b && h !== t) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function doMerge(store: Store, repo: Repo, pull: Pull): { ok: boolean; reason?: string } {
  if (pull.state !== 'open') return { ok: false, reason: 'pull request is not open' };
  if (prMergeable(store, repo, pull) === 'CONFLICTING') return { ok: false, reason: 'merge conflict' };
  const baseTip = store.resolveRef(repo, pull.baseRef);
  const headTip = store.resolveRef(repo, pull.headRef);
  if (!baseTip || !headTip) return { ok: false, reason: 'branch not found' };
  const baseTree = store.treeOfCommit(repo, pull.mergeBaseSha);
  const headTree = store.treeOfCommit(repo, headTip);
  const tipTree = store.treeOfCommit(repo, baseTip);
  const result = new Map(tipTree);
  const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
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
  return { ok: true };
}

function resolveField(ctx: Ctx, typename: string, obj: AnyObj, field: string, args: Record<string, any>): any {
  const store = ctx.store;
  switch (typename) {
    case 'Query': {
      if (field === 'viewer') return { __typename: 'User', __login: store.viewerLogin() };
      if (field === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        store.learnOwner(owner);
        if (!store.isViewer(owner)) return null;
        const repo = store.getRepo(owner, name);
        return repo ? wrapRepo(store, repo) : null;
      }
      if (field === 'node') {
        const decoded = ungid(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'repo') {
          const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
          return repo ? wrapRepo(store, repo) : null;
        }
        if (decoded.kind === 'issue') {
          const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
          const issue = repo?.issues.find((i) => i.number === parseInt(decoded.parts[2], 10));
          return repo && issue ? wrapIssue(store, repo, issue) : null;
        }
        if (decoded.kind === 'pr') {
          const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
          const pull = repo?.pulls.find((p) => p.number === parseInt(decoded.parts[2], 10));
          return repo && pull ? wrapPull(store, repo, pull) : null;
        }
        return null;
      }
      if (field === '__type') {
        const info = TYPE_INFO[String(args.name ?? '')];
        if (!info) return null;
        return { __typename: '__Type', __typeName: String(args.name), __info: info };
      }
      if (field === '__schema') return { __typename: '__Schema', queryType: { __typename: '__Type', __typeName: 'Query', __info: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'], enumValues: [] } } };
      return undefined;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = args.input ?? {};
        const decoded = ungid(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'repo') { ctx.errors.push({ message: 'repository not found' }); return null; }
        const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
        if (!repo) { ctx.errors.push({ message: 'repository not found' }); return null; }
        const issue: Issue = {
          number: repo.nextNumber, id: store.newId(), title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '', state: 'open',
          labels: [], createdSeq: store.tick(), comments: [],
        };
        repo.nextNumber += 1;
        repo.issues.push(issue);
        return { __typename: 'CreateIssuePayload', issue: wrapIssue(store, repo, issue) };
      }
      if (field === 'closeIssue') {
        const input = args.input ?? {};
        const decoded = ungid(String(input.issueId ?? ''));
        if (!decoded || decoded.kind !== 'issue') { ctx.errors.push({ message: 'issue not found' }); return null; }
        const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
        const issue = repo?.issues.find((i) => i.number === parseInt(decoded.parts[2], 10));
        if (!repo || !issue) { ctx.errors.push({ message: 'issue not found' }); return null; }
        issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: wrapIssue(store, repo, issue) };
      }
      if (field === 'createPullRequest') {
        const input = args.input ?? {};
        const decoded = ungid(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'repo') { ctx.errors.push({ message: 'repository not found' }); return null; }
        const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
        if (!repo) { ctx.errors.push({ message: 'repository not found' }); return null; }
        const headSha = store.resolveRef(repo, String(input.headRefName ?? ''));
        const baseSha = store.resolveRef(repo, String(input.baseRefName ?? ''));
        if (!headSha || !baseSha) { ctx.errors.push({ message: 'head or base branch does not exist' }); return null; }
        const pull: Pull = {
          number: repo.nextNumber, id: store.newId(), title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '', state: 'open',
          merged: false, mergedAt: null, mergeCommitSha: null,
          headRef: String(input.headRefName), baseRef: String(input.baseRefName),
          headSha, baseSha, mergeBaseSha: store.mergeBase(repo, headSha, baseSha),
          createdSeq: store.tick(),
        };
        repo.nextNumber += 1;
        repo.pulls.push(pull);
        return { __typename: 'CreatePullRequestPayload', pullRequest: wrapPull(store, repo, pull) };
      }
      if (field === 'mergePullRequest') {
        const input = args.input ?? {};
        const decoded = ungid(String(input.pullRequestId ?? ''));
        if (!decoded || decoded.kind !== 'pr') { ctx.errors.push({ message: 'pull request not found' }); return null; }
        const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
        const pull = repo?.pulls.find((p) => p.number === parseInt(decoded.parts[2], 10));
        if (!repo || !pull) { ctx.errors.push({ message: 'pull request not found' }); return null; }
        const res = doMerge(store, repo, pull);
        if (!res.ok) { ctx.errors.push({ message: res.reason ?? 'merge failed' }); return null; }
        return { __typename: 'MergePullRequestPayload', pullRequest: wrapPull(store, repo, pull) };
      }
      if (field === 'addComment') {
        const input = args.input ?? {};
        const decoded = ungid(String(input.subjectId ?? ''));
        if (!decoded) { ctx.errors.push({ message: 'subject not found' }); return null; }
        const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
        if (!repo) { ctx.errors.push({ message: 'subject not found' }); return null; }
        const body = String(input.body ?? '');
        if (decoded.kind === 'issue') {
          const issue = repo.issues.find((i) => i.number === parseInt(decoded.parts[2], 10));
          if (!issue) { ctx.errors.push({ message: 'issue not found' }); return null; }
          const comment = { id: store.newId(), body };
          issue.comments.push(comment);
          const commentId = gid('comment', repo.owner, repo.name, issue.number, comment.id);
          return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: commentId, body } } };
        }
        ctx.errors.push({ message: 'subject not found' });
        return null;
      }
      return undefined;
    }
    case 'User': {
      if (field === 'login') return obj.__login ?? store.viewerLogin();
      if (field === 'id') return 1000;
      if (field === 'name') return store.viewerName();
      if (field === 'email') return store.viewerEmail();
      return undefined;
    }
    case 'Repository': {
      const repo: Repo = obj.__repo;
      if (field === 'id') return repoGid(repo);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'owner') return { __typename: 'User', __login: repo.owner };
      if (field === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip ? { __typename: 'Ref', name: repo.defaultBranch } : null;
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'description') return repo.description;
      if (field === 'isPrivate') return repo.private;
      if (field === 'issue') {
        const issue = repo.issues.find((i) => i.number === args.number);
        return issue ? wrapIssue(store, repo, issue) : null;
      }
      if (field === 'issues') {
        let list = [...repo.issues];
        const states: string[] | undefined = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const orderBy = args.orderBy ?? {};
        const dir = String(orderBy.direction ?? 'DESC').toUpperCase();
        list.sort((a, b) => (dir === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        return makeConnection(list.map((i) => wrapIssue(store, repo, i)), args, 'IssueConnection', 'IssueEdge');
      }
      if (field === 'pullRequest') {
        const pull = repo.pulls.find((p) => p.number === args.number);
        return pull ? wrapPull(store, repo, pull) : null;
      }
      if (field === 'pullRequests') {
        let list = [...repo.pulls];
        const states: string[] | undefined = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toUpperCase()));
          list = list.filter((p) => {
            const st = p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
            return wanted.has(st);
          });
        } else {
          list = list.filter((p) => p.state === 'open');
        }
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        return makeConnection(list.map((p) => wrapPull(store, repo, p)), args, 'PullRequestConnection', 'PullRequestEdge');
      }
      return undefined;
    }
    case 'Ref': {
      if (field === 'name') return obj.name;
      return undefined;
    }
    case 'Issue': {
      const issue: Issue = obj.__issue;
      const repo: Repo = obj.__repo;
      if (field === 'id') return issueGid(repo, issue);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'body') return issue.body;
      if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'author') return { __typename: 'User', __login: store.viewerLogin() };
      if (field === 'createdAt') return store.isoFor(issue.createdSeq);
      if (field === 'repository') return wrapRepo(store, repo);
      if (field === 'labels') {
        return { __typename: 'LabelConnection', nodes: issue.labels.map((n) => ({ __typename: 'Label', name: n })) };
      }
      return undefined;
    }
    case 'PullRequest': {
      const pull: Pull = obj.__pull;
      const repo: Repo = obj.__repo;
      if (field === 'id') return pullGid(repo, pull);
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'headRefName') return pull.headRef;
      if (field === 'baseRefName') return pull.baseRef;
      if (field === 'mergeable') return prMergeable(store, repo, pull);
      if (field === 'merged') return pull.merged;
      if (field === 'author') return { __typename: 'User', __login: store.viewerLogin() };
      if (field === 'createdAt') return store.isoFor(pull.createdSeq);
      if (field === 'repository') return wrapRepo(store, repo);
      if (field === 'files') {
        const files = prFiles(store, repo, pull);
        const nodes = files.map((f) => ({ __typename: 'PullRequestFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status }));
        return makeConnection(nodes, args, 'PullRequestFileConnection', 'PullRequestFileEdge');
      }
      return undefined;
    }
    case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestFileConnection': case 'LabelConnection': {
      if (field === 'nodes') return obj.nodes;
      if (field === 'edges') return obj.edges;
      if (field === 'pageInfo') return obj.pageInfo;
      if (field === 'totalCount') return obj.totalCount;
      return undefined;
    }
    case 'IssueEdge': case 'PullRequestEdge': case 'PullRequestFileEdge': case 'IssueCommentEdge': {
      if (field === 'node') return obj.node;
      if (field === 'cursor') return obj.cursor;
      return undefined;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return obj.hasNextPage;
      if (field === 'hasPreviousPage') return obj.hasPreviousPage;
      if (field === 'startCursor') return obj.startCursor;
      if (field === 'endCursor') return obj.endCursor;
      return undefined;
    }
    case 'PullRequestFile': {
      if (field === 'path') return obj.path;
      if (field === 'additions') return obj.additions;
      if (field === 'deletions') return obj.deletions;
      if (field === 'changeType') return obj.changeType;
      return undefined;
    }
    case 'Label': {
      if (field === 'name') return obj.name;
      if (field === 'color') return obj.color ?? 'ededed';
      return undefined;
    }
    case 'IssueComment': {
      if (field === 'id') return obj.id;
      if (field === 'body') return obj.body;
      return undefined;
    }
    case '__Type': {
      if (field === 'name') return obj.__typeName;
      if (field === 'kind') return obj.__info.kind;
      if (field === 'fields') {
        return obj.__info.fields.map((n: string) => ({ __typename: '__Field', name: n }));
      }
      if (field === 'enumValues') {
        return obj.__info.enumValues.map((n: string) => ({ __typename: '__EnumValue', name: n }));
      }
      return undefined;
    }
    case '__Field': {
      if (field === 'name') return obj.name;
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'type') return { __typename: '__Type', __typeName: 'String', __info: { kind: 'SCALAR', fields: [], enumValues: [] } };
      return undefined;
    }
    case '__EnumValue': {
      if (field === 'name') return obj.name;
      if (field === 'description') return null;
      return undefined;
    }
    case '__Schema': {
      if (field === 'queryType') return obj.queryType;
      if (field === 'mutationType') return null;
      return undefined;
    }
    default: {
      // Payload objects: resolve by plain property.
      if (field === 'issue' || field === 'pullRequest' || field === 'commentEdge') return obj[field] ?? null;
      return undefined;
    }
  }
}

function executeSelection(ctx: Ctx, typename: string, obj: AnyObj, selection: SelectionNode[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const sel of selection) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== typename) continue;
      Object.assign(out, executeSelection(ctx, typename, obj, sel.selection));
      continue;
    }
    const field = sel as FieldNode;
    if (field.name === '__typename') {
      out[field.alias ?? field.name] = typename;
      continue;
    }
    const args: Record<string, any> = {};
    for (const [k, v] of Object.entries(field.args)) args[k] = evalValue(v, ctx.variables);
    const value = resolveField(ctx, typename, obj, field.name, args);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typename}".` });
      out[field.alias ?? field.name] = null;
      continue;
    }
    out[field.alias ?? field.name] = resolveValue(ctx, value, field.selection);
  }
  return out;
}

function resolveValue(ctx: Ctx, value: any, selection: SelectionNode[]): any {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => resolveValue(ctx, v, selection));
  if (typeof value === 'object' && '__typename' in value) {
    if (selection.length === 0) return value;
    return executeSelection(ctx, value.__typename, value, selection);
  }
  return value;
}

export function executeGraphQL(store: Store, body: unknown): { status: number; body: any } {
  const runOne = (op: any): any => {
    if (!op || typeof op.query !== 'string') {
      return { data: null, errors: [{ message: 'query is required' }] };
    }
    let ops: Operation[];
    try {
      const parser = new Parser(op.query);
      ops = parser.parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: `syntax error: ${(e as Error).message}` }] };
    }
    const variables: Record<string, any> = { ...(op.variables ?? {}) };
    let chosen = ops[0];
    if (typeof op.operationName === 'string') {
      const named = ops.find((o) => o.name === op.operationName);
      if (named) chosen = named;
    } else if (ops.length > 1) {
      const named = ops.find((o) => o.name);
      if (named) chosen = named;
    }
    for (const vd of chosen.varDefs) {
      if (!(vd.name in variables) && vd.defaultValue) {
        variables[vd.name] = evalValue(vd.defaultValue, variables);
      }
    }
    const ctx: Ctx = { store, variables, errors: [] };
    const rootType = chosen.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelection(ctx, rootType, {}, chosen.selection);
    const out: Record<string, any> = { data };
    if (ctx.errors.length > 0) out.errors = ctx.errors;
    return out;
  };

  if (Array.isArray(body)) return { status: 200, body: body.map(runOne) };
  return { status: 200, body: runOne(body) };
}
