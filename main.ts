// main.ts is mend, the CLI SPEC.md specifies. It reads an AI-written edit in one of four formats (a unified diff,
// SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON) and applies it to the tree of text files
// in the working directory: every file is changed or nothing is. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// The body of the file follows SPEC.md section by section: the command line and the exit codes (sections 1 and 2),
// files, lines and safe paths (section 3), format detection (section 4), line matching at three tiers (section 5),
// the four readers (sections 6 to 9) and the all-or-nothing write (section 10). In a trial the grader runs
// `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts (the last lines below):
// keep that hand-over and runner.ts as they are.

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
  /** Moves a move edit made, in order, for the `R` lines of section 2. */
  readonly moves: { old: string; next: string }[] = [];
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
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3)
// ---------------------------------------------------------------------------

interface FileLines {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBr = text.endsWith(br);
  const lines = text.split(br);
  if (finalBr) lines.pop();
  return { lines, br, finalBr };
}

function joinFile(fl: FileLines): string {
  return fl.lines.length === 0 ? '' : fl.lines.join(fl.br) + (fl.finalBr ? fl.br : '');
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

function matchAt(lines: string[], o: string[], i: number, tier: number): boolean {
  for (let k = 0; k < o.length; k += 1) if (!lineEq(lines[i + k]!, o[k]!, tier)) return false;
  return true;
}

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier at which `o` occurs at or after `from` (and, when given, passes `ok`), with every such position. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, ok?: (pos: number) => boolean): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (matchAt(lines, o, i, tier) && (ok === undefined || ok(i))) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** A line of N at tier 2, re-indented from the patch's indent P to the file's own indent F (section 5). */
function reindent(line: string, f: string, p: string): string {
  if (line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

/** One body line of a unified hunk or a V4A chunk: a context, old or new line, and whether a `\` line follows it. */
interface BodyItem {
  type: ' ' | '-' | '+';
  text: string;
  bsAfter: boolean;
}

/**
 * Splice a body (context, `-` and `+` lines in order) into `fl` at `pos`, where its context and `-` lines matched
 * the file's lines there at `tier`. Context lines are written as the file's own matched lines; at tier 2 the `+`
 * lines are re-indented. Returns the lines written.
 */
function spliceBody(fl: FileLines, pos: number, items: BodyItem[], tier: number, oFirst: string): string[] {
  const seg: string[] = [];
  let oi = 0;
  const f = leadWs(fl.lines[pos] ?? '');
  const p = leadWs(oFirst);
  for (const it of items) {
    if (it.type === ' ') {
      seg.push(fl.lines[pos + oi]!);
      oi += 1;
    } else if (it.type === '-') {
      oi += 1;
    } else {
      seg.push(tier === 2 ? reindent(it.text, f, p) : it.text);
    }
  }
  const oLen = items.filter((it) => it.type !== '+').length;
  fl.lines.splice(pos, oLen, ...seg);
  return seg;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  minusPath: string | null;
  plusPath: string | null;
  pairSeen: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
  startedHunks: boolean;
}

/** The path of a `--- ` or `+++ ` header line: after the four characters, to the first tab, spaces removed. */
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  return raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const newSection = (): Section => {
    const s: Section = {
      diffOld: null, diffNew: null, minusPath: null, plusPath: null, pairSeen: false,
      renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [], startedHunks: false,
    };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), items: [] };
      cur.hunks.push(hunk);
      cur.startedHunks = true;
      i += 1;
      const raw: { type: string; text: string; empty: boolean }[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') raw.push({ type: ' ', text: '', empty: true });
        else if (bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') raw.push({ type: bl[0], text: bl.slice(1), empty: false });
        else break;
        i += 1;
      }
      while (raw.length > 0 && raw[raw.length - 1]!.empty) raw.pop();
      for (const it of raw) {
        if (it.type === '\\') {
          const prev = hunk.items[hunk.items.length - 1];
          if (prev !== undefined) prev.bsAfter = true;
        } else {
          hunk.items.push({ type: it.type as BodyItem['type'], text: it.text, bsAfter: false });
        }
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        const s = cur !== null && !cur.startedHunks && !cur.pairSeen ? cur : newSection();
        s.pairSeen = true;
        s.minusPath = headerPath(line);
        s.plusPath = headerPath(next);
        i += 2;
        continue;
      }
      if (cur !== null && !cur.startedHunks) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && !cur.startedHunks) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s));
}

function sectionEdit(s: Section): Edit {
  let oldP: string | null = s.pairSeen ? s.minusPath : (s.renameFrom ?? s.diffOld);
  let newP: string | null = s.pairSeen ? s.plusPath : (s.renameTo ?? s.diffNew);
  const isCreate = oldP === '/dev/null' || s.newFile;
  const isDelete = newP === '/dev/null' || s.delFile;
  if (isCreate) oldP = null;
  if (isDelete) newP = null;
  return (tree) => {
    if (isCreate) {
      const p = newP ?? oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus = s.hunks.flatMap((h) => h.items.filter((it) => it.type === '+'));
      const texts = plus.map((it) => it.text);
      const last = plus[plus.length - 1];
      const text = texts.length === 0 ? '' : texts.join('\n') + (last !== undefined && last.bsAfter ? '' : '\n');
      tree.now.set(p, text);
      return;
    }
    const o = oldP ?? newP ?? '';
    if (!safe(o)) throw new Fail('unsafe', o);
    const isMove = newP !== null && newP !== o;
    if (isMove && !safe(newP!)) throw new Fail('unsafe', newP!);
    const src = tree.get(o);
    if (src === null) throw new Fail('missing', o);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    if (isDelete) {
      tree.now.set(o, null);
      return;
    }
    const fl = splitFile(src);
    let d = 0;
    for (const h of s.hunks) {
      const oItems = h.items.filter((it) => it.type !== '+');
      const nLen = h.items.filter((it) => it.type !== '-').length;
      if (oItems.length === 0) {
        const add = h.items.filter((it) => it.type === '+').map((it) => it.text);
        let pos = h.a + d;
        if (pos > fl.lines.length) pos = fl.lines.length;
        if (pos < 0) pos = 0;
        const atEnd = pos === fl.lines.length;
        fl.lines.splice(pos, 0, ...add);
        if (atEnd && add.length > 0) {
          const lastItem = h.items[h.items.length - 1]!;
          fl.finalBr = !lastItem.bsAfter;
        }
      } else {
        const oTexts = oItems.map((it) => it.text);
        const found = findTier(fl.lines, oTexts, strictFlag);
        if (found === null) throw new Fail('no-match', o);
        const target = h.a - 1 + d;
        let pos = found.positions[0]!;
        let best = Math.abs(pos - target);
        for (const cand of found.positions) {
          const dist = Math.abs(cand - target);
          if (dist < best) {
            pos = cand;
            best = dist;
          }
        }
        const runsToEnd = pos + oTexts.length === fl.lines.length;
        spliceBody(fl, pos, h.items, found.tier, oTexts[0]!);
        if (runsToEnd) {
          const lastNP = [...h.items].reverse().find((it) => it.type !== '-');
          fl.finalBr = lastNP === undefined ? true : !lastNP.bsAfter;
        }
      }
      d += nLen - oItems.length;
    }
    const text = joinFile(fl);
    if (isMove) {
      tree.now.set(o, null);
      tree.now.set(newP!, text);
      tree.moves.push({ old: o, next: newP! });
    } else {
      tree.now.set(o, text);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const src = tree.get(p);
      if (src === null) throw new Fail('missing', p);
      const fl = splitFile(src);
      const found = findTier(fl.lines, oldLines, strictFlag);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const seg = found.tier === 2 ? newLines.map((l) => reindent(l, leadWs(fl.lines[pos]!), leadWs(oldLines[0]!))) : [...newLines];
      fl.lines.splice(pos, oldLines.length, ...seg);
      tree.now.set(p, joinFile(fl));
    });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  moveTo: string | null;
  addLines: string[];
  chunks: Chunk[];
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : l.startsWith('*** Update File: ') ? 'update' : null;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = sectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerLen = kind === 'add' ? '*** Add File: '.length : kind === 'delete' ? '*** Delete File: '.length : '*** Update File: '.length;
    const sec: VSection = { kind, path: line.slice(headerLen).trim(), lineNo: i + 1, moveTo: null, addLines: [], chunks: [] };
    sections.push(sec);
    i += 1;
    // The section's raw lines, up to the next section or `*** End Patch`, its trailing blank lines left out.
    const rawStart = i;
    let rawEnd = i;
    let j = i;
    while (j < last && sectionStart(lines[j]!) === null) {
      if (!blank(lines[j]!)) rawEnd = j + 1;
      j += 1;
    }
    const raw = lines.slice(rawStart, rawEnd);
    i = j;
    if (kind === 'add') {
      raw.forEach((l, k) => {
        if (l.startsWith('+')) sec.addLines.push(l.slice(1));
        else if (l === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${rawStart + k + 1}`);
      });
    } else if (kind === 'delete') {
      raw.forEach((l, k) => {
        throw new Exit2(`error: parse ${rawStart + k + 1}`);
      });
    } else {
      let chunk: Chunk | null = null;
      raw.forEach((l, k) => {
        const lineNo = rawStart + k + 1;
        if (k === 0 && l.startsWith('*** Move to: ')) {
          sec.moveTo = l.slice('*** Move to: '.length).trim();
          return;
        }
        if (l === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: true, items: [] };
            sec.chunks.push(chunk);
          }
          chunk.eof = true;
          chunk = null;
          return;
        }
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          sec.chunks.push(chunk);
          return;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, items: [] };
            sec.chunks.push(chunk);
          }
          chunk.items.push({ type: l === '' ? ' ' : (l[0] as BodyItem['type']), text: l === '' ? '' : l.slice(1), bsAfter: false });
          return;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      });
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => v4aEdit(sec));
}

function v4aEdit(sec: VSection): Edit {
  const p = sec.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.addLines.length === 0 ? '' : `${sec.addLines.join('\n')}\n`);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const src = tree.get(p);
    if (src === null) throw new Fail('missing', p);
    if (sec.kind === 'delete') {
      tree.now.set(p, null);
      return;
    }
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const fl = splitFile(src);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let at = -1;
        const tiers = strictFlag ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let k = cursor; k < fl.lines.length; k += 1) {
            if (lineEq(fl.lines[k]!, chunk.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const oItems = chunk.items.filter((it) => it.type !== '+');
      if (oItems.length === 0) {
        const add = chunk.items.filter((it) => it.type === '+').map((it) => it.text);
        const pos = chunk.eof ? fl.lines.length : Math.min(cursor, fl.lines.length);
        fl.lines.splice(pos, 0, ...add);
        cursor = pos + add.length;
      } else {
        const oTexts = oItems.map((it) => it.text);
        const found = chunk.eof
          ? findTier(fl.lines, oTexts, strictFlag, cursor, (pos) => pos + oTexts.length === fl.lines.length)
          : findTier(fl.lines, oTexts, strictFlag, cursor);
        if (found === null) throw new Fail('no-match', p);
        const pos = found.positions[0]!;
        const seg = spliceBody(fl, pos, chunk.items, found.tier, oTexts[0]!);
        cursor = pos + seg.length;
      }
    }
    const text = joinFile(fl);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, text);
      tree.moves.push({ old: p, next: sec.moveTo });
    } else {
      tree.now.set(p, text);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

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
      if (tree.get(p) !== null) throw new Fail('exists', p);
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
// The command line, the output and the write (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

/** Set by run() from --strict before the readers build their edits; the readers' closures read it as they run. */
let strictFlag = false;

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
  strictFlag = strict;
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
  let edits: Edit[];
  try {
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines)
      : kind === 'search-replace' ? searchReplaceEdits(lines)
      : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const current = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const consumed = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const mv of tree.moves) {
    if (consumed.has(mv.old) || consumed.has(mv.next)) continue;
    if (tree.original(mv.old) !== null && current(mv.old) === null && tree.original(mv.next) === null && current(mv.next) !== null) {
      rows.push({ key: mv.next, text: `R ${mv.old} -> ${mv.next}` });
      consumed.add(mv.old);
      consumed.add(mv.next);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
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
