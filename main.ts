// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// It reads unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
// patch format, and text-editor tool calls as JSON; finds the lines an edit names even when
// the model drifted their whitespace or indentation; and changes every file or none (atomic).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /**
   * Whether the path exists in the tree as edited: a file in it, or anything at
   * that path on disk. A directory counts: SPEC.md section 2 reports `exists`
   * when an edit creates a file, or moves a file to a path, that exists, and a
   * path a directory occupies exists even though it holds no file text, so
   * `get` (which reads files only) must not be the existence test for a
   * create or a move destination. A path an earlier edit deleted does not
   * exist, so it can be created again in the same patch.
   */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

type Edit = (tree: Tree) => void;

/** A file split into lines the way SPEC.md section 3 says. */
interface FileModel {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

const lead = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** One line of N: a context line (written as the file's own matched line, `ctx` is its index in O) or a new line. */
interface NLine {
  text: string;
  ctx: number | null;
}

/** Whether two lines are equal at a matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at or after `from`. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The lines N writes when it replaces O at `pos`: context lines as the file's own, the rest re-indented at tier 2. */
function buildWritten(fileLines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = lead(fileLines[pos] ?? '');
    P = lead(O[0] ?? '');
  }
  return N.map((n) => {
    if (n.ctx !== null) return fileLines[pos + n.ctx] ?? '';
    if (tier === 2) {
      const t = n.text;
      if (t === '' || /^[ \t]+$/.test(t)) return t;
      if (t.startsWith(P)) return F + t.slice(P.length);
      return t;
    }
    return n.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UBody {
  kind: string;
  text: string;
  raw: string;
}
interface UHunk {
  a: number;
  body: UBody[];
}
interface USection {
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean;
  del: boolean;
  hunks: UHunk[];
}

function freshSection(): USection {
  return {
    pairOld: null,
    pairNew: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    create: false,
    del: false,
    hunks: [],
  };
}

/** The path of a `--- `/`+++ ` header line: after the four characters, up to the first tab, trimmed, without a leading a/ or b/. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(.*) b\/(.*)$/;

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let hunk: UHunk | null = null;
  const closeHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.raw === '') hunk.body.pop();
      sec.hunks.push(hunk);
      hunk = null;
    }
  };
  const startSection = (s: USection): void => {
    sec = s;
    sections.push(s);
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ')) {
        closeHunk();
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeHunk();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        hunk.body.push({ kind: line === '' ? ' ' : line[0]!, text: line === '' ? '' : line.slice(1), raw: line });
        i++;
        continue;
      }
      closeHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null || m[1] === '' || m[2] === '') throw new Exit2(`error: parse ${i + 1}`);
      const s = freshSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      startSection(s);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && sec.hunks.length === 0 && !sec.hasPair) {
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(lines[i + 1]!);
        sec.hasPair = true;
        i += 2;
        continue;
      }
      const s = freshSection();
      s.pairOld = headerPath(line);
      s.pairNew = headerPath(lines[i + 1]!);
      s.hasPair = true;
      startSection(s);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), body: [] };
      i++;
      continue;
    }
    if (sec === null) {
      i++;
      continue;
    }
    if (sec.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice(10).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        sec.create = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        sec.del = true;
        i++;
        continue;
      }
    }
    i++;
  }
  closeHunk();
  return sections;
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  return parseUnified(lines).map((sec) => {
    let oldP: string | null = sec.hasPair ? sec.pairOld : (sec.renameFrom ?? sec.diffOld);
    let newP: string | null = sec.hasPair ? sec.pairNew : (sec.renameTo ?? sec.diffNew);
    if (oldP === '/dev/null') oldP = null;
    if (newP === '/dev/null') newP = null;
    const isCreate = oldP === null || sec.create;
    const isDelete = !isCreate && (newP === null || sec.del);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    const path = oldP ?? '';
    const dest = newP ?? '';
    if (isCreate) {
      return (tree: Tree): void => {
        if (!safe(dest)) throw new Fail('unsafe', dest);
        if (tree.exists(dest)) throw new Fail('exists', dest);
        const plus: string[] = [];
        let noBreak = false;
        for (const h of sec.hunks) {
          for (let j = 0; j < h.body.length; j++) {
            const b = h.body[j]!;
            if (b.kind === '+') {
              plus.push(b.text);
              noBreak = j + 1 < h.body.length && h.body[j + 1]!.kind === '\\';
            }
          }
        }
        tree.now.set(dest, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      };
    }
    if (isDelete) {
      return (tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      };
    }
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (isMove && !safe(dest)) throw new Fail('unsafe', dest);
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      if (isMove && tree.exists(dest)) throw new Fail('exists', dest);
      const f = parseFile(cur);
      let d = 0;
      for (const h of sec.hunks) {
        const O: string[] = [];
        const N: NLine[] = [];
        let lastCtxPlus = -1;
        for (let j = 0; j < h.body.length; j++) {
          const b = h.body[j]!;
          if (b.kind === ' ') {
            O.push(b.text);
            N.push({ text: b.text, ctx: O.length - 1 });
            lastCtxPlus = j;
          } else if (b.kind === '-') {
            O.push(b.text);
          } else if (b.kind === '+') {
            N.push({ text: b.text, ctx: null });
            lastCtxPlus = j;
          }
        }
        const noBreak = lastCtxPlus >= 0 && lastCtxPlus + 1 < h.body.length && h.body[lastCtxPlus + 1]!.kind === '\\';
        if (O.length > 0) {
          const found = findTier(f.lines, O, strict);
          if (found === null) throw new Fail('no-match', path);
          const target = h.a - 1 + d;
          let best = found.occ[0]!;
          for (const p of found.occ) {
            if (Math.abs(p - target) < Math.abs(best - target)) best = p;
          }
          const atEnd = best + O.length === f.lines.length;
          const written = buildWritten(f.lines, best, O, N, found.tier);
          f.lines.splice(best, O.length, ...written);
          if (atEnd) f.finalBreak = !noBreak;
          d += N.length - O.length;
        } else {
          const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
          const written = buildWritten(f.lines, at, O, N, 0);
          f.lines.splice(at, 0, ...written);
          if (at === f.lines.length) f.finalBreak = !noBreak;
          d += N.length;
        }
      }
      const out = serializeFile(f);
      if (isMove) {
        tree.now.set(path, null);
        tree.now.set(dest, out);
        moves.push([path, dest]);
      } else {
        tree.now.set(path, out);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srEdit(path: string, O: string[], N: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (O.length === 0) {
      if (tree.exists(path)) throw new Fail('exists', path);
      tree.now.set(path, N.length === 0 ? '' : N.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = parseFile(cur);
    const found = findTier(f.lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const nlines: NLine[] = N.map((t) => ({ text: t, ctx: null }));
    const written = buildWritten(f.lines, pos, O, nlines, found.tier);
    f.lines.splice(pos, O.length, ...written);
    tree.now.set(path, serializeFile(f));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sLine = i;
    let path: string | null = null;
    for (let j = sLine - 1; j > prevReplace; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${sLine + 1}`);
    let sep = -1;
    for (let j = sLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${sLine + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${sLine + 1}`);
    const O = lines.slice(sLine + 1, sep);
    const N = lines.slice(sep + 1, rep);
    edits.push(srEdit(path, O, N, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: Array<{ kind: string; text: string }>;
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const kind = line.startsWith('*** Add') ? 'add' : line.startsWith('*** Delete') ? 'delete' : 'update';
      const path = line.slice(line.indexOf(':') + 1).trim();
      const headerLineNo = i + 1;
      const start = i + 1;
      let j = start;
      while (j < last) {
        const l = lines[j]!;
        if (!blank(l) && (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: '))) break;
        j++;
      }
      const secLines = lines.slice(start, j);
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) secLines.pop();
      edits.push(buildV4aEdit(kind, path, secLines, start, headerLineNo, strict, moves));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function buildV4aEdit(
  kind: string,
  path: string,
  secLines: string[],
  secStartIdx: number,
  headerLineNo: number,
  strict: boolean,
  moves: Array<[string, string]>,
): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < secLines.length; k++) {
      const l = secLines[k]!;
      if (l.startsWith('+')) fileLines.push(l.slice(1));
      else if (blank(l)) fileLines.push('');
      else throw new Exit2(`error: parse ${secStartIdx + k + 1}`);
    }
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.exists(path)) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (let k = 0; k < secLines.length; k++) {
      if (!blank(secLines[k]!)) throw new Exit2(`error: parse ${secStartIdx + k + 1}`);
    }
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (secLines.length > 0 && secLines[0]!.startsWith('*** Move to: ')) {
    moveTo = secLines[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (let k = idx; k < secLines.length; k++) {
    const l = secLines[k]!;
    const lineNo = secStartIdx + k + 1;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const a = l.slice(2).trim();
      cur = { anchor: a === '' ? null : a, eof: false, body: [] };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      cur.body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLineNo}`);
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.exists(moveTo)) throw new Fail('exists', moveTo);
    const f = parseFile(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(f.lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const O: string[] = [];
      const N: NLine[] = [];
      for (const b of ch.body) {
        if (b.kind === ' ') {
          O.push(b.text);
          N.push({ text: b.text, ctx: O.length - 1 });
        } else if (b.kind === '-') {
          O.push(b.text);
        } else if (b.kind === '+') {
          N.push({ text: b.text, ctx: null });
        }
      }
      if (O.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const written = buildWritten(f.lines, at, O, N, 0);
        f.lines.splice(at, 0, ...written);
        cursor = at + written.length;
      } else {
        const found = findTier(f.lines, O, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos: number | undefined;
        if (ch.eof) {
          pos = found.occ.find((p) => p + O.length === f.lines.length);
          if (pos === undefined) throw new Fail('no-match', path);
        } else {
          pos = found.occ[0]!;
        }
        const written = buildWritten(f.lines, pos, O, N, found.tier);
        f.lines.splice(pos, O.length, ...written);
        cursor = pos + written.length;
      }
    }
    const out = serializeFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Entry point (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : tree.original(oldP);
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : tree.original(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      const di = rows.findIndex((r) => r.text === `D ${oldP}`);
      if (di >= 0) rows.splice(di, 1);
      const ai = rows.findIndex((r) => r.text === `A ${newP}`);
      if (ai >= 0) rows.splice(ai, 1);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
