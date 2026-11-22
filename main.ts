// main.ts is mend, the CLI SPEC.md specifies. This implementation covers all four formats:
// unified diff, SEARCH/REPLACE, V4A patches, and JSON tool calls, with three-tier line matching.
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every(s => s !== '' && s !== '.' && s !== '..');
}

/** Return the trailing newline sequence of text: "", "\n", or "\r\n". */
function trailingSequence(text: string): string {
  if (text.endsWith('\r\n')) return '\r\n';
  if (text.endsWith('\n')) return '\n';
  return '';
}

/** Join lines with lineEnding, strip trailing lineEnding sequences, append trailingSeq. */
function preserveEnding(lines: string[], lineEnding: string, trailingSeq: string): string {
  if (lines.length === 0) return trailingSeq;
  let out = lines.join(lineEnding);
  while (out.endsWith(lineEnding)) out = out.slice(0, -lineEnding.length);
  return out + trailingSeq;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ============================================================
// §5  Three-tier line matching with re-indentation
// ============================================================

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.trim();
}

function leadingIndent(line: string): string {
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : '';
}

/** Find occurrences of oldLines in fileLines at the first tier (0,1,2) where at least one exists.
 *  Returns { tier, positions[] } where positions are 0-based start indices. */
function findMatches(fileLines: string[], oldLines: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const fileKeys = fileLines.map(l => tierKey(l, tier));
    const oldKeys = oldLines.map(l => tierKey(l, tier));
    const positions: number[] = [];
    for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (fileKeys[i + j] !== oldKeys[j]) { ok = false; break; }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** Re-indent newLines at tier 2: replace leading P (old first line's indent) with F (file first matched line's indent). */
function reindentTier2(newLines: string[], oldLines: string[], matchPos: number, fileLines: string[]): string[] {
  const F = leadingIndent(fileLines[matchPos]);
  const P = leadingIndent(oldLines[0]);
  if (P === '') return newLines.slice();
  return newLines.map(nl => {
    if (nl === '' || nl.trim() === '') return nl;
    if (nl.startsWith(P)) return F + nl.slice(P.length);
    return nl;
  });
}

/** Apply a hunk body to fileLines at matchPos.
 *  body: hunk body lines (start with ' ', '-', '+', '\', or empty).
 *  Returns { lines, noNewlineAtEnd } where lines is the new file content lines.
 *  Context lines are written as the file's own matched line.
 *  At tier 2, non-context (+) lines are re-indented. */
function applyHunkBody(fileLines: string[], oldLines: string[], matchPos: number, tier: number, body: string[]): { lines: string[]; noNewlineAtEnd: boolean } {
  const out: string[] = [];
  out.push(...fileLines.slice(0, matchPos));
  let fi = matchPos;
  let noNewlineAtEnd = false;
  const newPlusLines: string[] = [];  // collect + lines for tier-2 re-indent
  for (const bl of body) {
    if (bl.startsWith('\\')) { noNewlineAtEnd = true; continue; }
    if (bl.startsWith(' ') || bl === '') {
      // context: use file's own matched line
      out.push(fileLines[fi]);
      fi++;
    } else if (bl.startsWith('-')) {
      // old line: skip (don't write), advance file pointer
      fi++;
    } else if (bl.startsWith('+')) {
      newPlusLines.push(bl.slice(1));
    }
  }
  // tier-2 re-indent: re-indent the + lines using F/P from first matched line
  let finalPlus: string[];
  if (tier === 2) {
    finalPlus = reindentTier2(newPlusLines, oldLines, matchPos, fileLines);
  } else {
    finalPlus = newPlusLines.slice();
  }
  // Now we need to interleave context lines (file's own) and + lines (new) in body order.
  // The above loop already handles context/old/+ in order, but I collected + separately.
  // Let me redo: build out by walking body again but with re-indented + lines.
  const out2: string[] = [];
  out2.push(...fileLines.slice(0, matchPos));
  fi = matchPos;
  let pi = 0;
  for (const bl of body) {
    if (bl.startsWith('\\')) continue;
    if (bl.startsWith(' ') || bl === '') {
      out2.push(fileLines[fi]);
      fi++;
    } else if (bl.startsWith('-')) {
      fi++;
    } else if (bl.startsWith('+')) {
      out2.push(finalPlus[pi]);
      pi++;
    }
  }
  out2.push(...fileLines.slice(fi));
  return { lines: out2, noNewlineAtEnd };
}

// ============================================================
// §6  Unified diff parsing and application
// ============================================================

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  isMove: boolean;
  hunks: UnifiedHunk[];
}

interface UnifiedHunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  body: string[];
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  let current: UnifiedSection | null = null;

  const flushSection = () => { if (current) { sections.push(current); current = null; } };

  const parsePath = (line: string): string | null => {
    const after = line.slice(4);
    const tab = after.indexOf('\t');
    const path = (tab >= 0 ? after.slice(0, tab) : after).trim();
    if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
    if (path === '/dev/null') return null;
    return path;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      flushSection();
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      current = { oldPath: m[1], newPath: m[2], isCreate: false, isDelete: false, isMove: false, hunks: [] };
      i++;
    } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const oldPath = parsePath(line);
      const newPath = parsePath(lines[i + 1]);
      if (!current) {
        flushSection();
        current = { oldPath, newPath, isCreate: false, isDelete: false, isMove: false, hunks: [] };
      } else {
        if (oldPath !== null) current.oldPath = oldPath;
        if (newPath !== null) current.newPath = newPath;
      }
      i += 2;
    } else if (current && line.startsWith('rename from ')) {
      const p = line.slice(12).trim();
      if (!p.startsWith('/') && !p.includes('\\') && p.split('/').every(s => s && s !== '.' && s !== '..')) current.oldPath = p;
      i++;
    } else if (current && line.startsWith('rename to ')) {
      const p = line.slice(10).trim();
      if (!p.startsWith('/') && !p.includes('\\') && p.split('/').every(s => s && s !== '.' && s !== '..')) current.newPath = p;
      i++;
    } else if (current && line.startsWith('new file mode')) {
      current.isCreate = true;
      i++;
    } else if (current && line.startsWith('deleted file mode')) {
      current.isDelete = true;
      i++;
    } else if (current && line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UnifiedHunk = {
        oldStart: parseInt(m[1], 10),
        oldLen: m[2] ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newLen: m[4] ? parseInt(m[4], 10) : 1,
        body: []
      };
      i++;
      while (i < lines.length) {
        const bl = lines[i];
        if (bl.startsWith('diff --git ') || (bl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ '))) break;
        if (bl.startsWith('@@')) break;
        if (/^[ \-+\\]/.test(bl) || bl === '') { hunk.body.push(bl); i++; } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      current.hunks.push(hunk);
    } else {
      i++;
    }
  }
  flushSection();

  for (const s of sections) {
    const op = s.oldPath, np = s.newPath;
    if (op !== null && np !== null && op !== np) s.isMove = true;
    else if (op === null && np !== null) s.isCreate = true;
    else if (op !== null && np === null) s.isDelete = true;
  }
  return sections;
}

function hunkOldLines(hunk: UnifiedHunk): string[] {
  const old: string[] = [];
  for (const bl of hunk.body) {
    if (bl.startsWith('\\')) continue;
    if (bl.startsWith(' ') || bl === '') old.push(bl.startsWith(' ') ? bl.slice(1) : '');
    else if (bl.startsWith('-')) old.push(bl.slice(1));
  }
  return old;
}

function applyUnifiedSection(tree: Tree, section: UnifiedSection, strict: boolean): Fail | null {
  const op = section.oldPath;
  const np = section.newPath;
  for (const p of [op, np].filter((p): p is string => p !== null)) {
    if (!safe(p)) return new Fail('unsafe', p);
  }

  if (section.isCreate) {
    if (np === null) return new Fail('parse', 'create without new path');
    if (tree.get(np) !== null) return new Fail('exists', np);
    let fileLines: string[] = [];
    let noNewlineAtEnd = false;
    for (const hunk of section.hunks) {
      const oldLines = hunkOldLines(hunk);
      if (oldLines.length > 0) return new Fail('no-match', np);
      const { lines, noNewlineAtEnd: nn } = applyHunkBody([], [], 0, 0, hunk.body);
      fileLines.push(...lines);
      noNewlineAtEnd = nn;
    }
    tree.now.set(np, preserveEnding(fileLines, '\n', noNewlineAtEnd ? '' : '\n'));
    return null;
  }

  if (section.isDelete) {
    if (op === null || tree.get(op) === null) return new Fail('missing', op ?? '');
    tree.now.set(op, null);
    return null;
  }

  if (section.isMove) {
    if (op === null || np === null) return new Fail('parse', 'move without both paths');
    if (tree.get(op) === null) return new Fail('missing', op);
    if (tree.get(np) !== null) return new Fail('exists', np);
    const origText = tree.get(op)!;
    const origBr = origText.includes('\r\n') ? '\r\n' : '\n';
    const origLines = origText === '' ? [] : origText.split(origBr);
    let workLines = [...origLines];
    let d = 0;
    let noNewlineAtEnd = false;
    for (const hunk of section.hunks) {
      const oldLines = hunkOldLines(hunk);
      const A = hunk.oldStart;
      if (oldLines.length === 0) {
        const insertAt = Math.min(A + d, workLines.length);
        const newLines: string[] = [];
        let insertNN = false;
        for (const bl of hunk.body) {
          if (bl.startsWith('\\')) { insertNN = true; continue; }
          if (bl.startsWith('+')) newLines.push(bl.slice(1));
        }
        if (insertNN) noNewlineAtEnd = true;
        workLines.splice(insertAt, 0, ...newLines);
        d += newLines.length;
      } else {
        const res = findMatches(workLines, oldLines, strict);
        if (!res) return new Fail('no-match', op);
        let bestPos = res.positions[0];
        let bestDist = Math.abs(bestPos - (A - 1 + d));
        for (const pos of res.positions) {
          const dist = Math.abs(pos - (A - 1 + d));
          if (dist < bestDist || (dist === bestDist && pos < bestPos)) { bestDist = dist; bestPos = pos; }
        }
        const { lines, noNewlineAtEnd: hunkNN } = applyHunkBody(workLines, oldLines, bestPos, res.tier, hunk.body);
        workLines = lines;
        if (hunkNN) noNewlineAtEnd = true;
        d += hunk.body.filter(b => b.startsWith('+') && !b.startsWith('\\')).length -
              hunk.body.filter(b => b.startsWith('-') && !b.startsWith('\\')).length;
      }
    }
    const outText = workLines.length === 0 ? '' : preserveEnding(workLines, origBr, noNewlineAtEnd ? '' : trailingSequence(origText));
    tree.now.set(op, null);
    tree.now.set(np, outText);
    return null;
  }

  // Change (single path)
  if (op === null) return new Fail('parse', 'change without path');
  if (tree.get(op) === null) return new Fail('missing', op);
  const origText = tree.get(op)!;
  const origBr = origText.includes('\r\n') ? '\r\n' : '\n';
  const origLines = origText === '' ? [] : origText.split(origBr);
  let workLines = [...origLines];
  let d = 0;
  let noNewlineAtEnd = false;
  for (const hunk of section.hunks) {
    const oldLines = hunkOldLines(hunk);
    const A = hunk.oldStart;
    if (oldLines.length === 0) {
      const insertAt = Math.min(A + d, workLines.length);
      const newLines: string[] = [];
      let insertNN = false;
      for (const bl of hunk.body) {
        if (bl.startsWith('\\')) { insertNN = true; continue; }
        if (bl.startsWith('+')) newLines.push(bl.slice(1));
      }
      if (insertNN) noNewlineAtEnd = true;
      workLines.splice(insertAt, 0, ...newLines);
      d += newLines.length;
    } else {
      const res = findMatches(workLines, oldLines, strict);
      if (!res) return new Fail('no-match', op);
      let bestPos = res.positions[0];
      let bestDist = Math.abs(bestPos - (A - 1 + d));
      for (const pos of res.positions) {
        const dist = Math.abs(pos - (A - 1 + d));
        if (dist < bestDist || (dist === bestDist && pos < bestPos)) { bestDist = dist; bestPos = pos; }
      }
      const { lines, noNewlineAtEnd: hunkNN } = applyHunkBody(workLines, oldLines, bestPos, res.tier, hunk.body);
      workLines = lines;
      if (hunkNN) noNewlineAtEnd = true;
      d += hunk.body.filter(b => b.startsWith('+') && !b.startsWith('\\')).length -
            hunk.body.filter(b => b.startsWith('-') && !b.startsWith('\\')).length;
    }
  }
  const outText = workLines.length === 0 ? '' : preserveEnding(workLines, origBr, noNewlineAtEnd ? '' : trailingSequence(origText));
  tree.now.set(op, outText);
  return null;
}

// ============================================================
// §7  SEARCH/REPLACE blocks
// ============================================================

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  searchLineNo: number;
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let lastReplaceEnd = -1;
  let prevPath: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimEnd() !== '<<<<<<< SEARCH') continue;
    let eq = -1, rep = -1;
    for (let j = i + 1; j < lines.length; j++) { if (lines[j].trimEnd() === '=======') { eq = j; break; } }
    if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
    for (let j = eq + 1; j < lines.length; j++) { if (lines[j].trimEnd() === '>>>>>>> REPLACE') { rep = j; break; } }
    if (rep < 0) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let j = i - 1; j > lastReplaceEnd; j--) {
      const l = lines[j].trim();
      if (l === '') continue;
      if (l.startsWith('```')) continue;
      path = l;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    prevPath = path;
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    blocks.push({ path: path!, oldLines, newLines, searchLineNo: i + 1 });
    lastReplaceEnd = rep;
    i = rep;
  }
  return blocks;
}

function applySRBlock(tree: Tree, block: SRBlock, strict: boolean): Fail | null {
  const p = block.path;
  if (!safe(p)) return new Fail('unsafe', p);
  if (block.oldLines.length === 0) {
    if (tree.get(p) !== null) return new Fail('exists', p);
    tree.now.set(p, preserveEnding(block.newLines, '\n', '\n'));
    return null;
  }
  const text = tree.get(p);
  if (text === null) return new Fail('missing', p);
  const br = text.includes('\r\n') ? '\r\n' : '\n';
  const fileLines = text === '' ? [] : text.split(br);
  const res = findMatches(fileLines, block.oldLines, strict);
  if (!res) return new Fail('no-match', p);
  if (res.positions.length !== 1) return new Fail('ambiguous', p);
  // All old lines are context in SEARCH (they're all being replaced), so write newLines as-is (tier 2 re-indent applies to all)
  let finalNew = block.newLines.slice();
  if (res.tier === 2) {
    finalNew = reindentTier2(block.newLines, block.oldLines, res.positions[0], fileLines);
  }
  const newFileLines = [...fileLines.slice(0, res.positions[0]), ...finalNew, ...fileLines.slice(res.positions[0] + block.oldLines.length)];
  const outText = newFileLines.length === 0 ? '' : preserveEnding(newFileLines, br, trailingSequence(text));
  tree.now.set(p, outText);
  return null;
}

// ============================================================
// §8  V4A patches
// ============================================================

interface V4ASection {
  type: 'add' | 'delete' | 'update';
  path: string;
  moveTo?: string;
  chunks: V4AChunk[];
}

interface V4AChunk {
  anchor: string | null;
  oldLines: string[];
  newLines: string[];
  contextFlags: boolean[];
  body: string[];
  isEof: boolean;
  startLine: number;
}

function parseV4A(lines: string[]): V4ASection[] {
  const firstNonBlank = lines.findIndex(l => !blank(l));
  if (firstNonBlank < 0 || lines[firstNonBlank].trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${firstNonBlank >= 0 ? firstNonBlank + 1 : 1}`);
  }
  const lastNonBlank = [...lines].reverse().findIndex(l => !blank(l));
  if (lastNonBlank < 0 || lines[lines.length - 1 - lastNonBlank].trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const sections: V4ASection[] = [];
  let i = firstNonBlank + 1;
  let current: V4ASection | null = null;
  let inChunk = false;
  let chunkAnchor: string | null = null;
  let chunkOld: string[] = [];
  let chunkNew: string[] = [];
  let chunkContext: boolean[] = [];
  let chunkBody: string[] = [];
  let chunkIsEof = false;
  let chunkStartLine = 0;

  const flushChunk = () => {
    if (inChunk && current) {
      current.chunks.push({
        anchor: chunkAnchor,
        oldLines: chunkOld,
        newLines: chunkNew,
        contextFlags: chunkContext,
        body: chunkBody.slice(),
        isEof: chunkIsEof,
        startLine: chunkStartLine
      });
      inChunk = false;
      chunkAnchor = null;
      chunkOld = [];
      chunkNew = [];
      chunkContext = [];
      chunkBody = [];
      chunkIsEof = false;
    }
  };

  const flushSection = () => {
    if (current) {
      flushChunk();
      sections.push(current);
      current = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    if (line.trim() === '*** End Patch') break;

    if (line.startsWith('*** Add File: ')) {
      flushSection();
      const path = line.slice(14).trim();
      if (!safe(path)) throw new Exit2(`error: parse ${i + 1}`);
      current = { type: 'add', path, chunks: [] };
      i++;
      const addLines: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.startsWith('***')) break;
        if (l.startsWith('+')) { addLines.push(l.slice(1)); }
        else if (l === '') { addLines.push(''); }
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      current.chunks.push({ anchor: null, oldLines: [], newLines: addLines, contextFlags: [], body: addLines.map(l => '+' + l), isEof: false, startLine: i + 1 });
      flushSection();
    } else if (line.startsWith('*** Delete File: ')) {
      flushSection();
      const path = line.slice(17).trim();
      if (!safe(path)) throw new Exit2(`error: parse ${i + 1}`);
      current = { type: 'delete', path, chunks: [] };
      i++;
      flushSection();
    } else if (line.startsWith('*** Update File: ')) {
      flushSection();
      const path = line.slice(17).trim();
      if (!safe(path)) throw new Exit2(`error: parse ${i + 1}`);
      current = { type: 'update', path, chunks: [] };
      i++;
      if (i < lines.length && lines[i].startsWith('*** Move to: ')) {
        current.moveTo = lines[i].slice(13).trim();
        if (!safe(current.moveTo!)) throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (i < lines.length) {
        const l = lines[i];
        if (blank(l)) { i++; continue; }
        if (l.startsWith('***')) break;
        if (l.startsWith('@@')) {
          flushChunk();
          chunkAnchor = l.slice(2).trim();
          chunkStartLine = i + 1;
          inChunk = true;
          i++;
        } else if (l.startsWith('*** End of File')) {
          if (!inChunk) { chunkIsEof = true; chunkStartLine = i + 1; inChunk = true; }
          else { chunkIsEof = true; }
          flushChunk();
          i++;
        } else if (/^[ \-+]/.test(l) || l === '') {
          if (!inChunk) { chunkAnchor = null; chunkStartLine = i + 1; inChunk = true; }
          if (l.startsWith(' ')) { const c = l.slice(1); chunkOld.push(c); chunkNew.push(c); chunkContext.push(true); }
          else if (l.startsWith('-')) { chunkOld.push(l.slice(1)); chunkContext.push(false); }
          else if (l.startsWith('+')) { chunkNew.push(l.slice(1)); chunkContext.push(false); }
          else { chunkOld.push(''); chunkNew.push(''); chunkContext.push(true); }
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  flushSection();
  return sections;
}

function applyV4ASection(tree: Tree, section: V4ASection, strict: boolean): Fail | null {
  const p = section.path;
  if (!safe(p)) return new Fail('unsafe', p);
  if (section.moveTo && !safe(section.moveTo)) return new Fail('unsafe', section.moveTo);

  if (section.type === 'add') {
    if (tree.get(p) !== null) return new Fail('exists', p);
    const lines: string[] = [];
    for (const ch of section.chunks) lines.push(...ch.newLines);
    tree.now.set(p, preserveEnding(lines, '\n', '\n'));
    return null;
  }

  if (section.type === 'delete') {
    if (tree.get(p) === null) return new Fail('missing', p);
    tree.now.set(p, null);
    return null;
  }

  // update
  if (tree.get(p) === null) return new Fail('missing', p);
  if (section.moveTo && tree.get(section.moveTo!) !== null) return new Fail('exists', section.moveTo!);
  const origText = tree.get(p)!;
  const origBr = origText.includes('\r\n') ? '\r\n' : '\n';
  let workLines = origText === '' ? [] : origText.split(origBr);
  let cursor = 0;

  for (const ch of section.chunks) {
    if (ch.anchor !== null) {
      const res = findMatches(workLines.slice(cursor), [ch.anchor], strict);
      if (!res) return new Fail('no-match', p);
      cursor = cursor + res.positions[0] + 1;
    }
    if (ch.oldLines.length === 0) {
      if (ch.isEof) cursor = workLines.length;
      let finalNew = ch.newLines.slice();
      if (strict === false) {
        // V4A insert: no old lines, no tier matching needed; write as-is
      }
      workLines.splice(cursor, 0, ...finalNew);
      cursor += ch.newLines.length;
    } else {
      const searchSpace = workLines.slice(cursor);
      const res = findMatches(searchSpace, ch.oldLines, strict);
      if (!res) return new Fail('no-match', p);
      let matchPos = cursor + res.positions[0];
      if (ch.isEof && matchPos + ch.oldLines.length !== workLines.length) {
        const eofPositions = res.positions.filter(pos => cursor + pos + ch.oldLines.length === workLines.length);
        if (eofPositions.length === 0) return new Fail('no-match', p);
        matchPos = cursor + eofPositions[0];
      }
      const { lines } = applyHunkBody(workLines, ch.oldLines, matchPos, res.tier, ch.body);
      workLines = lines;
      cursor = matchPos + ch.newLines.length;
    }
  }

  const outText = workLines.length === 0 ? '' : preserveEnding(workLines, origBr, trailingSequence(origText));
  if (section.moveTo) {
    tree.now.set(p, null);
    tree.now.set(section.moveTo, outText);
  } else {
    tree.now.set(p, outText);
  }
  return null;
}

// ============================================================
// §9  JSON edits
// ============================================================

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
  const first = lines.findIndex(l => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
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
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ============================================================
// Main run function
// ============================================================

function detect(lines: string[]): string | null {
  const first = lines.findIndex(l => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some(l => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

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
  let edits: Edit[];
  try {
    if (kind === 'json') {
      edits = jsonEdits(text, lines);
    } else if (kind === 'unified') {
      const sections = parseUnified(lines);
      if (sections.length === 0) throw new Exit2('error: parse 1');
      edits = sections.map(sec => (tree: Tree) => {
        const err = applyUnifiedSection(tree, sec, strict);
        if (err) throw err;
      });
    } else if (kind === 'search-replace') {
      const blocks = parseSearchReplace(lines);
      if (blocks.length === 0) throw new Exit2('error: parse 1');
      edits = blocks.map(blk => (tree: Tree) => {
        const err = applySRBlock(tree, blk, strict);
        if (err) throw err;
      });
    } else if (kind === 'v4a') {
      const sections = parseV4A(lines);
      if (sections.length === 0) throw new Exit2('error: parse 1');
      edits = sections.map(sec => (tree: Tree) => {
        const err = applyV4ASection(tree, sec, strict);
        if (err) throw err;
      });
    } else {
      edits = [];
    }
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
  if (fails.length > 0) return { code: 1, out: [...fails.map(f => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map(l => `${l}\n`).join(''));
  process.exitCode = r.code;
}