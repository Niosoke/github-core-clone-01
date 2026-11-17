// git.ts — git smart HTTP: info/refs (v0/v2 advertisement), upload-pack
// (v2 ls-refs/fetch, v0 fetch), receive-pack (v0). Plain objects only in
// packs we generate; incoming packs are fully parsed with delta resolution.

import { buildPack, concat, parseCommit, parsePack, parsePktLines, parseTag, parseTree, pktLine, PKT_DELIM, PKT_FLUSH, utf8, utf8Str, ZERO_OID } from './util.ts';
import type { GitObject, PktItem } from './util.ts';
import { isZeroOid, type Repo, type Store } from './store.ts';

const AGENT = 'makefun-forge/1.0.0';

export interface GitResponse { status: number; headers: Record<string, string>; body: Uint8Array }

function json404(): GitResponse {
  return { status: 404, headers: { 'content-type': 'application/json' }, body: utf8('{"message":"Not Found"}') };
}

function capsUpload(): string {
  return `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=${AGENT} symref=HEAD:refs/heads/main`;
}

function capsReceive(): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function headTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** Peeled commit for a tag ref line, or null for lightweight tags/commits. */
function peeledFor(store: Store, repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return store.peelToCommit(repo, oid);
}

// ---- info/refs -----------------------------------------------------------

export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string | null, gitProtocol: string | null): GitResponse {
  store.learnOwner(owner);
  const repo = store.getRepo(owner, repoName);
  if (!repo || !service) return json404();
  const isUpload = service === 'git-upload-pack';
  const isReceive = service === 'git-receive-pack';
  if (!isUpload && !isReceive) return json404();

  const contentType = isUpload
    ? 'application/x-git-upload-pack-advertisement'
    : 'application/x-git-receive-pack-advertisement';
  const caps = isUpload ? capsUpload() : capsReceive();

  if (isUpload && gitProtocol === 'version=2') {
    const parts: Uint8Array[] = [
      pktLine('version 2\n'),
      pktLine('ls-refs\n'),
      pktLine('fetch=shallow filter\n'),
      pktLine('object-format=sha1\n'),
      pktLine(`agent=${AGENT}\n`),
      PKT_FLUSH,
    ];
    return { status: 200, headers: { 'content-type': contentType }, body: concat(...parts) };
  }

  const parts: Uint8Array[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const tip = headTip(repo);
  const refs = sortedRefs(repo);
  if (!tip && refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else if (tip) {
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      const peeled = peeledFor(store, repo, r.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${r.name}^{}\n`));
    }
  } else {
    // Refs exist but no HEAD tip (should not happen; advertise refs anyway).
    let first = true;
    for (const r of refs) {
      parts.push(pktLine(first ? `${r.oid} ${r.name}\0${caps}\n` : `${r.oid} ${r.name}\n`));
      first = false;
      const peeled = peeledFor(store, repo, r.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${r.name}^{}\n`));
    }
  }
  // Real git expects a flush after the ref list in a v0 advertisement.
  parts.push(PKT_FLUSH);
  return { status: 200, headers: { 'content-type': contentType }, body: concat(...parts) };
}

// ---- upload-pack --------------------------------------------------------

interface FetchRequest {
  command: 'fetch' | 'ls-refs';
  wants: string[]; haves: string[]; shallows: string[]; deepen: number | null;
  deepenRelative: boolean;
  peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[];
  done: boolean;
}

function parseUploadPackRequest(items: PktItem[]): FetchRequest | null {
  const req: FetchRequest = {
    command: 'fetch', wants: [], haves: [], shallows: [], deepen: null,
    deepenRelative: false,
    peel: false, symrefs: false, unborn: false, prefixes: [], done: false,
  };
  let seenCommand = false;
  for (const item of items) {
    if (item.kind !== 'data') continue;
    const line = utf8Str(item.data).replace(/\n$/, '');
    if (line.startsWith('command=')) {
      if (line === 'command=ls-refs') req.command = 'ls-refs';
      else if (line === 'command=fetch') req.command = 'fetch';
      else return null;
      seenCommand = true;
    } else if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.deepen = parseInt(line.slice(7).trim(), 10);
    else if (line === 'deepen-relative') req.deepenRelative = true;
    else if (line === 'peel') req.peel = true;
    else if (line === 'symrefs') req.symrefs = true;
    else if (line === 'unborn') req.unborn = true;
    else if (line === 'done') req.done = true;
    else if (line.startsWith('ref-prefix ')) req.prefixes.push(line.slice(11));
    else if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line.startsWith('agent=') || line.startsWith('object-format=') || line.startsWith('filter ')) {
      // accepted, ignored
    }
  }
  if (!seenCommand) return null;
  return req;
}

function lsRefsResponse(store: Store, repo: Repo, req: FetchRequest): Uint8Array {
  const parts: Uint8Array[] = [];
  const tip = headTip(repo);
  const refs = sortedRefs(repo);
  const match = (name: string): boolean =>
    req.prefixes.length === 0 || req.prefixes.some((p) => name.startsWith(p));
  // HEAD is a ref like any other for prefix filtering: real git clones send
  // `ref-prefix HEAD`, the kit client sends `refs/...` prefixes (which do
  // not match HEAD), so one rule serves both.
  if (tip && match('HEAD')) {
    let line = `${tip} HEAD`;
    if (req.symrefs) line += ' symref-target:refs/heads/main';
    parts.push(pktLine(line + '\n'));
  }
  if (!tip && req.unborn && match(`refs/heads/${repo.defaultBranch}`)) {
    parts.push(pktLine(`unborn refs/heads/${repo.defaultBranch} symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const r of refs) {
    if (!match(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (req.peel) {
      const peeled = peeledFor(store, repo, r.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(line + '\n'));
  }
  parts.push(PKT_FLUSH);
  return concat(...parts);
}

/** Collect objects for a pack: the given commits (trees/blobs only — parents
 *  are NOT traversed; the caller passes the exact commit set) plus tag objects
 *  whose targets are in that set. Objects in `exclude` (already held by the
 *  client) are never sent. */
function collectObjects(repo: Repo, commitOids: Set<string>, tagOids: string[], exclude: Set<string>): GitObject[] {
  const seen = new Set<string>();
  const out: GitObject[] = [];
  const stack: string[] = [...commitOids, ...tagOids];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || exclude.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    out.push(obj);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.body);
      stack.push(info.tree);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.body)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.body).object;
      if (commitOids.has(target) || repo.objects.get(target)?.type === 'tag') stack.push(target);
    }
  }
  return out;
}

/** Objects the client already holds: each held commit plus its full tree
 *  closure. Parents are NOT followed — a shallow-boundary commit's parents
 *  are exactly what a deepen fetch must still deliver. */
function closureObjects(repo: Repo, commits: string[]): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const c of commits) {
    out.add(c);
    const obj = repo.objects.get(c);
    if (obj && obj.type === 'commit') stack.push(parseCommit(obj.body).tree);
    else if (obj && obj.type === 'tag') stack.push(parseTag(obj.body).object);
  }
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.body)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.body).object);
    }
  }
  return out;
}

function sidebandPack(pack: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    const payload = concat(new Uint8Array([1]), slice);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) {
    // Never emit a packfile section with zero sideband packets.
    parts.push(pktLine(new Uint8Array([1])));
  }
  parts.push(PKT_FLUSH);
  return concat(...parts);
}

function fetchResponse(store: Store, repo: Repo, req: FetchRequest, v2: boolean): Uint8Array {
  // Held set: closure of haves, stopping at client-shallow boundaries.
  const clientShallow = new Set(req.shallows);
  const held = store.reachable(repo, req.haves, clientShallow);
  for (const s of req.shallows) held.add(s);

  // Depth-limited walk from wants. `deepen` is an absolute depth from the
  // wants (the kit's semantics). With `deepen-relative` (real git's
  // `fetch --deepen`), the limit is relative to the client's current
  // shallow boundary: the walk runs unbounded until it reaches a shallow
  // commit, then extends `deepen` generations past it. Expansion also
  // stops at held non-shallow commits, whose ancestors are held by
  // definition. A commit reached again through a looser limit is
  // re-walked; limits only grow, so this terminates.
  const maxDepth = req.deepen !== null && req.deepen > 0 ? req.deepen : null;
  const wanted = new Set<string>();
  const boundary = new Set<string>();
  {
    const startLimit = req.deepenRelative ? null : maxDepth;
    const queue: { oid: string; depth: number; limit: number | null }[] =
      req.wants.map((w) => ({ oid: w, depth: 1, limit: startLimit }));
    const bestLimit = new Map<string, number>();
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const peeled = store.peelToCommit(repo, cur.oid);
      const commitOid = peeled ?? cur.oid;
      // A client-shallow commit extends its own limit when the client
      // asked for a relative deepen.
      let effLimit = cur.limit;
      if (req.deepenRelative && maxDepth !== null && clientShallow.has(commitOid)) {
        const rel = cur.depth + maxDepth;
        effLimit = effLimit === null ? rel : Math.max(effLimit, rel);
      }
      const effLimitVal = effLimit ?? Infinity;
      const prev = bestLimit.get(commitOid);
      if (prev !== undefined && prev >= effLimitVal) continue;
      bestLimit.set(commitOid, effLimitVal);
      const obj = repo.objects.get(commitOid);
      if (!obj || obj.type !== 'commit') continue;
      wanted.add(commitOid);
      if (effLimit !== null && cur.depth >= effLimit) { boundary.add(commitOid); continue; }
      // Held non-shallow commits need no expansion: their ancestors are held.
      // (Absolute walks only: a relative walk must pass through held
      // commits to reach the shallow boundary below them.)
      if (!req.deepenRelative && held.has(commitOid) && !clientShallow.has(commitOid)) continue;
      const info = parseCommit(obj.body);
      for (const p of info.parents) queue.push({ oid: p, depth: cur.depth + 1, limit: effLimit });
    }
  }

  // New objects = wanted minus held (boundary commits stay in the set).
  const fresh = new Set<string>();
  for (const oid of wanted) if (!held.has(oid)) fresh.add(oid);
  // A want that is itself a tag object must also be sent.
  const extraTips: string[] = [];
  for (const w of req.wants) {
    const obj = repo.objects.get(w);
    if (obj && obj.type === 'tag' && !held.has(w)) extraTips.push(w);
  }

  // Shallow / unshallow for the resulting client state. Only boundary
  // CHANGES are reported (like real git upload-pack): a commit the client
  // already declared shallow is not re-reported as shallow, and a commit
  // is unshallow only when its parents are now all present.
  const resulting = new Set<string>([...held, ...fresh]);
  const stillBoundary = new Set<string>();
  for (const oid of resulting) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.body);
    if (info.parents.length === 0) continue;
    const missing = info.parents.some((p) => !resulting.has(p));
    if (missing) stillBoundary.add(oid);
  }
  const shallowOut = new Set<string>([...stillBoundary].filter((o) => !clientShallow.has(o)));
  const unshallowOut: string[] = req.shallows.filter((s) => resulting.has(s) && !stillBoundary.has(s));

  const parts: Uint8Array[] = [];
  const knownHaves = req.haves.filter((h) => repo.objects.has(h));
  const heldObjects = closureObjects(repo, [...held]);
  const packObjects = collectObjects(repo, fresh, extraTips, heldObjects);
  const packSection = sidebandPack(buildPack(packObjects));
  if (v2) {
    // v2 section order mirrors real git upload-pack (verified against
    // git 2.43 upload-pack with GIT_PROTOCOL=version=2):
    //  - acknowledgments ONLY while negotiation continues (no `done` yet);
    //    once the client sent `done`, the server goes straight to the pack.
    //  - a `ready` line means the pack follows in THIS response: the acks
    //    section ends with DELIM, not FLUSH (FLUSH after `ready` makes real
    //    git die "expected packfile to be sent after 'ready'").
    //  - NAK (no known have) ends the segment with FLUSH and the server
    //    waits for more haves / `done` in a later round.
    //  - shallow-info ONLY when it carries lines, terminated by DELIM.
    //  - packfile always, terminated by FLUSH.
    if (!req.done && req.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      if (knownHaves.length === 0) {
        parts.push(pktLine('NAK\n'));
        parts.push(PKT_FLUSH);
        return concat(...parts);
      }
      for (const h of knownHaves) parts.push(pktLine(`ACK ${h}\n`));
      parts.push(pktLine('ready\n'));
      parts.push(PKT_DELIM);
    }
    if (shallowOut.size > 0 || unshallowOut.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(packSection);
  } else {
    // v0: plain NAK/ACK lines, then shallow lines, then the sideband pack.
    // No section headers and no flushes between them.
    if (knownHaves.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const h of knownHaves) parts.push(pktLine(`ACK ${h}\n`));
    }
    for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(packSection);
  }
  return concat(...parts);
}

function applyFetchLine(accum: FetchRequest, line: string): boolean {
  if (line.startsWith('command=')) {
    if (line === 'command=ls-refs') accum.command = 'ls-refs';
    else if (line === 'command=fetch') accum.command = 'fetch';
    else return false;
  } else if (line.startsWith('want ')) accum.wants.push(line.slice(5).trim());
  else if (line.startsWith('have ')) accum.haves.push(line.slice(5).trim());
  else if (line.startsWith('shallow ')) accum.shallows.push(line.slice(8).trim());
  else if (line.startsWith('deepen ')) accum.deepen = parseInt(line.slice(7).trim(), 10);
  else if (line === 'deepen-relative') accum.deepenRelative = true;
  else if (line === 'peel') accum.peel = true;
  else if (line === 'symrefs') accum.symrefs = true;
  else if (line === 'unborn') accum.unborn = true;
  else if (line === 'done') accum.done = true;
  else if (line.startsWith('ref-prefix ')) accum.prefixes.push(line.slice(11));
  // Anything else (agent=, object-format=, thin-pack, include-tag, ...) is
  // accepted and ignored.
  return true;
}

// ---- upload-pack, streaming ----------------------------------------------
// Protocol v2 fetch is multi-round inside one HTTP request/response pair:
// the client writes wants + haves and reads the server's acknowledgments.
// If the server ACKs a known have it sends `ready` and the pack follows in
// the SAME response (acks section ends with DELIM). Only a NAK ends the
// segment with FLUSH, after which the client writes more haves / `done` and
// the server answers with the pack. A read-the-whole-body-first server
// deadlocks that exchange, so this handler parses pkt-lines as they arrive
// and answers round by round.

export function handleUploadPackStream(
  store: Store, owner: string, repoName: string,
  req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
  gitProtocol: string | null,
): void {
  store.learnOwner(owner);
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/json', 'x-github-request-id': store.nextRequestId() });
    res.end('{"message":"Not Found"}');
    req.resume();
    return;
  }
  const v2 = gitProtocol === 'version=2';
  let headSent = false;
  let finished = false;
  const sendHead = (status: number, contentType: string): void => {
    if (headSent) return;
    headSent = true;
    res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': store.nextRequestId() });
  };
  const fail400 = (): void => {
    if (finished) return;
    finished = true;
    sendHead(400, 'application/json');
    res.end('{"message":"Bad Request"}');
  };

  const accum: FetchRequest = {
    command: 'fetch', wants: [], haves: [], shallows: [], deepen: null,
    deepenRelative: false,
    peel: false, symrefs: false, unborn: false, prefixes: [], done: false,
  };
  let commandSeen = false;
  let buf = Buffer.alloc(0);

  const finishRound = (): void => {
    if (finished) return;
    if (!commandSeen) { fail400(); return; }
    if (accum.command === 'ls-refs') {
      sendHead(200, 'application/x-git-upload-pack-result');
      finished = true;
      res.end(lsRefsResponse(store, repo, accum));
      return;
    }
    if (accum.done) {
      sendHead(200, 'application/x-git-upload-pack-result');
      finished = true;
      res.end(fetchResponse(store, repo, accum, v2));
      return;
    }
    if (!v2) {
      // v0 is single-round in practice; wait for the body to end.
      return;
    }
    // Negotiation continues: answer this round's acknowledgments.
    // NAK (no known have) ends the segment with FLUSH and the server waits
    // for more haves / `done`. A `ready` means the pack follows in THIS
    // response, so send the whole fetchResponse (acks + DELIM + pack) now.
    const known = accum.haves.filter((h) => repo.objects.has(h));
    sendHead(200, 'application/x-git-upload-pack-result');
    if (known.length === 0) {
      res.write(concat(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH));
      return;
    }
    finished = true;
    res.end(fetchResponse(store, repo, accum, v2));
  };

  req.on('data', (chunk: Buffer) => {
    if (finished) return;
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4 && !finished) {
      const len = parseInt(buf.subarray(0, 4).toString('utf8'), 16);
      if (Number.isNaN(len) || len < 0) { fail400(); return; }
      if (len === 0) {
        buf = buf.subarray(4);
        finishRound();
        continue;
      }
      if (len === 1) { buf = buf.subarray(4); continue; }
      if (len < 4 || buf.length < len) break;
      const text = utf8Str(buf.subarray(4, len)).replace(/\n$/, '');
      buf = buf.subarray(len);
      if (text.startsWith('command=')) commandSeen = true;
      if (!applyFetchLine(accum, text)) { fail400(); return; }
    }
  });
  req.on('end', () => {
    if (finished) return;
    if (!commandSeen) { fail400(); return; }
    if (accum.command === 'ls-refs') {
      sendHead(200, 'application/x-git-upload-pack-result');
      finished = true;
      res.end(lsRefsResponse(store, repo, accum));
      return;
    }
    accum.done = true;
    sendHead(200, 'application/x-git-upload-pack-result');
    finished = true;
    res.end(fetchResponse(store, repo, accum, v2));
  });
  req.on('error', () => {
    if (!finished) { finished = true; try { res.end(); } catch { /* gone */ } }
  });
}
function parseV0Fetch(body: Uint8Array): FetchRequest | null {
  const items = parsePktLines(body);
  const req: FetchRequest = {
    command: 'fetch', wants: [], haves: [], shallows: [], deepen: null,
    deepenRelative: false,
    peel: false, symrefs: false, unborn: false, prefixes: [], done: false,
  };
  let seenWant = false;
  for (const item of items) {
    if (item.kind !== 'data') continue;
    const line = utf8Str(item.data).replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // First want line may carry space-separated caps after the oid.
      const rest = line.slice(5);
      const oid = rest.slice(0, 40);
      req.wants.push(oid);
      seenWant = true;
    } else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.deepen = parseInt(line.slice(7).trim(), 10);
    else if (line === 'deepen-relative') req.deepenRelative = true;
    else if (line === 'done') req.done = true;
  }
  if (!seenWant) return null;
  return req;
}

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Uint8Array, gitProtocol: string | null): GitResponse {
  store.learnOwner(owner);
  const repo = store.getRepo(owner, repoName);
  if (!repo) return json404();
  const v2 = gitProtocol === 'version=2';
  const req = v2 ? parseUploadPackRequest(parsePktLines(body)) : parseV0Fetch(body);
  if (!req) {
    return { status: 400, headers: { 'content-type': 'application/json' }, body: utf8('{"message":"Bad Request"}') };
  }
  let out: Uint8Array;
  if (req.command === 'ls-refs') {
    out = lsRefsResponse(store, repo, req);
  } else {
    out = fetchResponse(store, repo, req, v2);
  }
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: out };
}

// ---- receive-pack ---------------------------------------------------------

interface PushCommand { oldOid: string; newOid: string; ref: string }

function parseReceivePack(body: Uint8Array): { commands: PushCommand[]; pack: Uint8Array | null } | null {
  // Commands are pkt-lines up to the first flush; the rest is the raw pack.
  let i = 0;
  const commands: PushCommand[] = [];
  while (i + 4 <= body.length) {
    const len = parseInt(utf8Str(body.subarray(i, i + 4)), 16);
    if (Number.isNaN(len) || len < 0) return null;
    if (len === 0) { i += 4; break; }
    if (len < 4 || i + len > body.length) return null;
    const raw = body.subarray(i + 4, i + len);
    const nul = raw.indexOf(0);
    const text = utf8Str(nul >= 0 ? raw.subarray(0, nul) : raw).replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length !== 3) return null;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    i += len;
  }
  if (commands.length === 0) return null;
  const pack = i < body.length ? body.subarray(i) : null;
  return { commands, pack };
}

function closureComplete(repo: Repo, tipOid: string, extra: Map<string, GitObject>): boolean {
  // Every object reachable from the tip must be present in the store or the
  // incoming pack. An object already in the store has a complete closure by
  // invariant (only complete packs and server-built objects ever enter it),
  // so the walk stops descending there: validation is O(new objects), not
  // O(history), on every push.
  const seen = new Set<string>();
  const stack = [tipOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const inStore = repo.objects.has(oid);
    const obj = inStore ? repo.objects.get(oid)! : extra.get(oid);
    if (!obj) return false;
    if (inStore) continue;
    if (obj.type === 'commit') {
      const info = parseCommit(obj.body);
      stack.push(info.tree);
      for (const p of info.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.body)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.body).object);
    }
  }
  return true;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Uint8Array): GitResponse {
  store.learnOwner(owner);
  const repo = store.getRepo(owner, repoName);
  if (!repo) return json404();
  const parsed = parseReceivePack(body);
  if (!parsed) {
    return { status: 400, headers: { 'content-type': 'application/json' }, body: utf8('{"message":"Bad Request"}') };
  }
  const { commands, pack } = parsed;

  let incoming = new Map<string, GitObject>();
  if (pack && pack.length > 0) {
    try {
      incoming = parsePack(pack);
    } catch {
      const report = reportResult('unpack failed to parse pack', []);
      return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: report };
    }
  }
  // Validate every new tip's closure before touching any ref.
  let unpackError: string | null = null;
  for (const cmd of commands) {
    if (isZeroOid(cmd.newOid)) continue;
    const known = repo.objects.has(cmd.newOid) || incoming.has(cmd.newOid);
    if (!known) { unpackError = `object ${cmd.newOid} not found`; break; }
    if (!closureComplete(repo, cmd.newOid, incoming)) { unpackError = `incomplete closure for ${cmd.newOid}`; break; }
  }
  if (unpackError) {
    const report = reportResult(unpackError, []);
    return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: report };
  }
  // Store incoming objects (content-addressed; harmless for rejected refs).
  for (const [sha, obj] of incoming) {
    if (!repo.objects.has(sha)) repo.objects.set(sha, obj);
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.oldOid !== (current ?? ZERO_OID)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
      continue;
    }
    if (isZeroOid(cmd.newOid)) {
      // Delete.
      repo.refs.delete(cmd.ref);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== undefined) {
      if (cmd.ref.startsWith('refs/tags/')) {
        if (current !== cmd.newOid) {
          results.push({ ref: cmd.ref, ok: false, reason: 'cannot update tag' });
          continue;
        }
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      // Branch update: fast-forward required.
      if (cmd.oldOid === cmd.newOid) {
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      const oldCommit = store.peelToCommit(repo, cmd.oldOid);
      const newCommit = store.peelToCommit(repo, cmd.newOid);
      if (!oldCommit || !newCommit || !store.isAncestor(repo, oldCommit, newCommit)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }

  const report = reportResult(null, results);
  return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: report };
}

function reportResult(unpackError: string | null, results: { ref: string; ok: boolean; reason: string }[]): Uint8Array {
  const inner: Uint8Array[] = [];
  if (unpackError) inner.push(pktLine(`unpack ${unpackError}\n`));
  else inner.push(pktLine('unpack ok\n'));
  for (const r of results) {
    if (r.ok) inner.push(pktLine(`ok ${r.ref}\n`));
    else inner.push(pktLine(`ng ${r.ref} ${r.reason}\n`));
  }
  inner.push(PKT_FLUSH);
  const innerBytes = concat(...inner);
  // Wrap in band-1 sideband packets; outer stream ends with flush.
  const parts: Uint8Array[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < innerBytes.length; i += CHUNK) {
    const slice = innerBytes.subarray(i, Math.min(innerBytes.length, i + CHUNK));
    parts.push(pktLine(concat(new Uint8Array([1]), slice)));
  }
  parts.push(PKT_FLUSH);
  return concat(...parts);
}
