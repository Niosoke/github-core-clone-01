// util.ts — git primitives: SHA-1, pkt-line codec, git objects, packfile
// read/write (with OFS/REF delta resolution), tree/commit/tag codecs,
// line diff. Standard library only. No wall clock, no randomness.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Uint8Array | string): string {
  return createHash('sha1').update(data).digest('hex');
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Str(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function b64encode(b: Uint8Array | string): string {
  return Buffer.from(b as any).toString('base64');
}

export function b64decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---- git objects ---------------------------------------------------------

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; body: Uint8Array }

export function objectBytes(type: ObjType, body: Uint8Array): Uint8Array {
  return concat(utf8(`${type} ${body.length}\0`), body);
}

export function objectSha(type: ObjType, body: Uint8Array): string {
  return sha1Hex(objectBytes(type, body));
}

export function storeObject(store: Map<string, GitObject>, type: ObjType, body: Uint8Array): string {
  const sha = objectSha(type, body);
  if (!store.has(sha)) store.set(sha, { type, body });
  return sha;
}

// ---- pkt-line ------------------------------------------------------------

export function pktLine(data: Uint8Array | string): Uint8Array {
  const b = typeof data === 'string' ? utf8(data) : data;
  const len = b.length + 4;
  const hex = len.toString(16).padStart(4, '0');
  return concat(utf8(hex), b);
}

export const PKT_FLUSH = utf8('0000');
export const PKT_DELIM = utf8('0001');

export type PktItem =
  | { kind: 'data'; data: Uint8Array }
  | { kind: 'flush' }
  | { kind: 'delim' };

export function parsePktLines(buf: Uint8Array): PktItem[] {
  const items: PktItem[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(utf8Str(buf.subarray(i, i + 4)), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { items.push({ kind: 'flush' }); i += 4; continue; }
    if (len === 1) { items.push({ kind: 'delim' }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) break;
    items.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return items;
}

// ---- tree ----------------------------------------------------------------

export interface TreeEntry { mode: string; name: string; oid: string }

function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? e.name + '/' : e.name;
}

export function parseTree(body: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = utf8Str(body.subarray(i, sp));
    const nul = body.indexOf(0, sp);
    if (nul < 0) break;
    const name = utf8Str(body.subarray(sp + 1, nul));
    const oid = Buffer.from(body.subarray(nul + 1, nul + 21)).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

export function buildTree(entries: TreeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0);
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    parts.push(utf8(`${e.mode} ${e.name}\0`));
    parts.push(new Uint8Array(Buffer.from(e.oid, 'hex')));
  }
  return concat(...parts);
}

// ---- commit / tag --------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string; // "Name <email> ts +0000"
  committer: string;
  message: string;
}

export function buildCommit(c: CommitInfo): Uint8Array {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`, `committer ${c.committer}`, '', c.message);
  return utf8(lines.join('\n'));
}

export function parseCommit(body: Uint8Array): CommitInfo {
  const text = utf8Str(body);
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export interface TagInfo { object: string; type: ObjType; tag: string; tagger: string; message: string }

export function buildTag(t: TagInfo): Uint8Array {
  const lines = [
    `object ${t.object}`,
    `type ${t.type}`,
    `tag ${t.tag}`,
    `tagger ${t.tagger}`,
    '',
    t.message,
  ];
  return utf8(lines.join('\n'));
}

export function parseTag(body: Uint8Array): TagInfo {
  const text = utf8Str(body);
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const info: TagInfo = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) info.tag = line.slice(4);
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

// ---- packfile ------------------------------------------------------------

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

const TYPE_NUM: Record<ObjType, number> = { commit: OBJ_COMMIT, tree: OBJ_TREE, blob: OBJ_BLOB, tag: OBJ_TAG };
const NUM_TYPE: Record<number, ObjType> = { [OBJ_COMMIT]: 'commit', [OBJ_TREE]: 'tree', [OBJ_BLOB]: 'blob', [OBJ_TAG]: 'tag' };

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Inflate one zlib stream starting at `off`, expecting `size` output bytes.
 *  Returns the inflated bytes and the offset just past the stream. The end
 *  is found by scanning for the stream's trailing Adler-32 checksum (one
 *  inflate call per object, no binary search); falls back to a binary
 *  search if the checksum scan finds nothing. */
function inflateAt(buf: Uint8Array, off: number, size: number): { raw: Uint8Array; next: number } {
  const raw = inflateSync(buf.subarray(off));
  if (raw.length !== size) throw new Error('pack inflate size mismatch');
  const adler = adler32(raw);
  for (let e = off + 2; e + 20 <= buf.length; e++) {
    const v = ((buf[e - 4] << 24) | (buf[e - 3] << 16) | (buf[e - 2] << 8) | buf[e - 1]) >>> 0;
    if (v === adler) return { raw, next: e };
  }
  // Fallback: binary-search the smallest end that inflates to `size` bytes.
  let lo = off;
  let hi = buf.length - 20;
  let found: Uint8Array | null = null;
  let foundLen = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const trial = inflateSync(buf.subarray(off, mid));
      if (trial.length === size) { found = trial; foundLen = mid - off; hi = mid - 1; }
      else if (trial.length < size) lo = mid + 1;
      else hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found === null) throw new Error('pack inflate failed');
  return { raw: found, next: off + foundLen };
}

function readVarint(buf: Uint8Array, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = off;
  while (i < buf.length) {
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value, next: i };
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const src = readVarint(delta, 0);
  if (src.value !== base.length) throw new Error('delta base size mismatch');
  const dst = readVarint(delta, src.next);
  const out = new Uint8Array(dst.value);
  let i = dst.next;
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let b = 0; b < 4; b++) if (op & (1 << b)) off |= delta[i++] << (8 * b);
      for (let b = 0; b < 3; b++) if (op & (0x10 << b)) size |= delta[i++] << (8 * b);
      if (size === 0) size = 0x10000;
      out.set(base.subarray(off, off + size), o);
      o += size;
    } else if (op > 0) {
      out.set(delta.subarray(i, i + op), o);
      o += op;
      i += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  if (o !== dst.value) throw new Error('delta output size mismatch');
  return out;
}

export function parsePack(buf: Uint8Array): Map<string, GitObject> {
  if (buf.length < 12 || utf8Str(buf.subarray(0, 4)) !== 'PACK') throw new Error('not a packfile');
  const version = (buf[4] << 24) | (buf[5] << 16) | (buf[6] << 8) | buf[7];
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = (buf[8] << 24) | (buf[9] << 16) | (buf[10] << 8) | buf[11];
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let i = 12;
  for (let n = 0; n < count; n++) {
    const start = i;
    let b = buf[i++];
    const typeNum = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[i++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseObj: GitObject | null = null;
    if (typeNum === OBJ_OFS_DELTA) {
      let offByte = buf[i++];
      let off = offByte & 0x7f;
      while (offByte & 0x80) {
        offByte = buf[i++];
        off = ((off + 1) << 7) | (offByte & 0x7f);
      }
      const base = byOffset.get(start - off);
      if (!base) throw new Error('ofs-delta base not found');
      baseObj = base;
    } else if (typeNum === OBJ_REF_DELTA) {
      const baseSha = Buffer.from(buf.subarray(i, i + 20)).toString('hex');
      i += 20;
      const base = objects.get(baseSha);
      if (!base) throw new Error('ref-delta base not found');
      baseObj = base;
    }
    const { raw, next } = inflateAt(buf, i, size);
    i = next;
    let obj: GitObject;
    if (typeNum === OBJ_OFS_DELTA || typeNum === OBJ_REF_DELTA) {
      if (!baseObj) throw new Error('delta without base');
      obj = { type: baseObj.type, body: applyDelta(baseObj.body, raw) };
    } else {
      const t = NUM_TYPE[typeNum];
      if (!t) throw new Error('unknown pack object type ' + typeNum);
      obj = { type: t, body: raw };
    }
    const sha = objectSha(obj.type, obj.body);
    objects.set(sha, obj);
    byOffset.set(start, obj);
  }
  return objects;
}

export function buildPack(objects: GitObject[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(12);
  head.set(utf8('PACK'));
  head[7] = 2;
  const n = objects.length;
  head[8] = (n >> 24) & 0xff; head[9] = (n >> 16) & 0xff; head[10] = (n >> 8) & 0xff; head[11] = n & 0xff;
  parts.push(head);
  for (const obj of objects) {
    const typeNum = TYPE_NUM[obj.type];
    const size = obj.body.length;
    const headerBytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    headerBytes.push(first);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(new Uint8Array(headerBytes));
    parts.push(deflateSync(obj.body));
  }
  const withoutTrailer = concat(...parts);
  return concat(withoutTrailer, new Uint8Array(Buffer.from(sha1Hex(withoutTrailer), 'hex')));
}

// ---- line diff (multiset) ------------------------------------------------

export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (lines: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = count(oldText === '' ? [] : oldText.split('\n'));
  const b = count(newText === '' ? [] : newText.split('\n'));
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of b) additions += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) deletions += Math.max(0, n - (b.get(line) ?? 0));
  return { additions, deletions };
}

// ---- small helpers -------------------------------------------------------

export function escapeHtmlJson(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}
