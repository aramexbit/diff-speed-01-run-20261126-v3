// diff-speed-01: a faster drop-in for makefun-diff 1.0.0 (make.fun's own line diff).
//
// The task: for an input { old, new }, two texts, return exactly the patch makefun-diff
// 1.0.0 returns, as one JSON string. The patch format and the edit script's rule are the
// ones makefun-diff's own header states: lines are cut after every "\n" (a last line with
// no "\n" is a line too); the common prefix is kept, then the common suffix of what is
// left; between them Myers's greedy search runs, keeping on each diagonal the path that
// reaches furthest into the old text and, when a deletion and an insertion reach the same
// point, the deletion's; it never moves past either text's end, prunes no edge diagonal,
// and follows every run of equal lines as far as it goes; the first path to reach both
// ends is the script. The patch then lists hunks with up to 3 kept lines of context,
// deletions before insertions in each change run, and a "%" line after a line that ends
// its text with no newline.
//
// Why the house baseline is slow, and what this file does differently:
// The baseline walks the search with one small linked-list object per diagonal step
// (a path object per (d, k), plus a component object per run), so a case with a few
// thousand edits allocates millions of objects and the garbage collector dominates.
// This file keeps the search's state in flat typed arrays instead: lines are interned
// to integer ids once per case (a shared map for both texts, so equal lines share one
// id and every comparison is an int compare), the search keeps only the furthest x per
// diagonal in a compact Int32Array per d (stored x + 2, so 0 means "no path"), and the
// edit script is recovered afterwards by walking those stored arrays backwards and
// re-applying the same tie-break. No object is allocated inside the search loop, and
// the patch is built as pieces in one array joined once, without a concatenation per
// printed line. The search itself is the same greedy rule, so the script it finds is
// the same script; only the bookkeeping is cheaper.
//
// Nothing is cached from one case to the next: every map and array here is created
// fresh inside run().
//
// v3: the banded search. The anchor layer (from v2) gives an optimal script
// whose diagonal at each edit step, k_anchor(d), tracks the greedy path's
// diagonal closely, so the Myers search is restricted to a band of
// half-width 64 around that centerline — D * 129 states instead of about
// D^2 / 2. The band is not trusted blindly: the search must reach the end
// at exactly d = D and the backtracked path must stay 2 diagonals from the
// band's edge, or the band widens (x2, to 1024) and, at the widest, the
// full search runs instead. The answer is therefore always the greedy one.

/** The run kinds inside an edit script. */
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

/** The patch's first word. */
const FORMAT = 'makefun-diff/1';

// ---------------------------------------------------------------- tokenize + intern

/**
 * One text, cut into lines and interned: parts is text.split('\n'), last its last
 * index, count the line count, ids the line ids. A line is parts[i] with a "\n" for
 * i < last, and parts[last] with no "\n" when it is not empty (the text then ends
 * with no newline). Two maps keep the two shapes apart, so a bare last line never
 * shares an id with a line of the same content that ends with "\n": the two are
 * different lines, and the search must not treat them as equal.
 */
function splitLines(text, mapW, mapB, next) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const count = last + (parts[last] !== '' ? 1 : 0);
  const ids = new Int32Array(count);
  for (let i = 0; i < last; i++) {
    const s = parts[i];
    let id = mapW.get(s);
    if (id === undefined) {
      id = next.v++;
      mapW.set(s, id);
    }
    ids[i] = id;
  }
  if (parts[last] !== '') {
    const s = parts[last];
    let id = mapB.get(s);
    if (id === undefined) {
      id = next.v++;
      mapB.set(s, id);
    }
    ids[last] = id;
  }
  return { parts, last, count, ids };
}

// ---------------------------------------------------------------- Myers's search

/**
 * The edit script between two slices of interned line ids, as forward-order runs
 * [{ kind, count }]. a and b are Int32Array views of the slices, of lengths n and m.
 *
 * The search stores one compact array per d: Vs[d][j] holds the furthest old index
 * reached on diagonal k = 2j - d, stored as x + 2 so 0 means "no path on that
 * diagonal". Only the diagonals with the right parity exist, so Vs[d] has d + 1
 * entries and all of them together take about D^2 / 2 integers. The step from
 * level d - 1 follows the header's rule exactly: the deletion's candidate is the
 * path on diagonal k - 1 one old line further (Vs[d-1][j-1]), the insertion's is
 * the path on diagonal k + 1 at the same old index (Vs[d-1][j]); a candidate is
 * only a candidate when its step stays inside its text; the further into the old
 * text wins, and the deletion wins a tie. The snake then follows every run of
 * equal lines as far as it goes. The first (d, k) to reach both ends wins, in the
 * same k order the header's loop uses.
 *
 * Backtracking re-applies the same rule from the stored arrays: at (d, k) the
 * predecessor is the one the forward step would have picked, the step itself is
 * one deletion or insertion, and the lines between the step and the stored x are
 * the snake's kept lines. Runs are collected backwards and reversed, merging
 * neighbours of the same kind (a zero-length snake between two steps of one kind
 * is one run, as the header's path-merging does).
 */
function myersRuns(a, b, n, m) {
  if (n === 0 && m === 0) return [];
  const Vs = [];
  // d = 0: the initial snake from (-1, -1).
  let x = -1;
  while (x + 1 < n && x + 1 < m && a[x + 1] === b[x + 1]) x++;
  const v0 = new Int32Array(1);
  v0[0] = x + 2;
  Vs.push(v0);
  let D = 0;
  let kF = 0;
  if (x + 1 < n || x + 1 < m) {
    let found = false;
    for (let d = 1; d <= n + m && !found; d++) {
      const V = new Int32Array(d + 1);
      const Vp = Vs[d - 1];
      for (let j = 0; j <= d; j++) {
        const k = 2 * j - d;
        const delS = j - 1 >= 0 ? Vp[j - 1] : 0;
        const insS = j <= d - 1 ? Vp[j] : 0;
        const canDel = delS !== 0 && delS - 1 < n;
        const canIns = insS !== 0 && insS - 2 - k < m;
        if (!canDel && !canIns) continue;
        // The deletion's x after its step is delS - 1, the insertion's stays insS - 2.
        const byDel = canDel ? delS - 1 : -2;
        const byIns = canIns ? insS - 2 : -2;
        let xx;
        if (byDel >= byIns) xx = delS - 1;
        else xx = insS - 2;
        let y = xx - k;
        while (xx + 1 < n && y + 1 < m && a[xx + 1] === b[y + 1]) {
          xx++;
          y++;
        }
        V[j] = xx + 2;
        if (xx + 1 >= n && y + 1 >= m) {
          D = d;
          kF = k;
          found = true;
          break;
        }
      }
      Vs.push(V);
    }
  }
  // Backtrack from (D, kF), collecting runs in reverse.
  const rev = [];
  let d = D;
  let k = kF;
  while (d > 0) {
    const j = (k + d) >> 1;
    const xx = Vs[d][j] - 2;
    const Vp = Vs[d - 1];
    const delS = j - 1 >= 0 ? Vp[j - 1] : 0;
    const insS = j <= d - 1 ? Vp[j] : 0;
    const canDel = delS !== 0 && delS - 1 < n;
    const canIns = insS !== 0 && insS - 2 - k < m;
    const byDel = canDel ? delS - 1 : -2;
    const byIns = canIns ? insS - 2 : -2;
    if (byDel >= byIns) {
      const keep = xx - (delS - 1);
      if (keep > 0) rev.push({ kind: KEEP, count: keep });
      rev.push({ kind: DELETE, count: 1 });
      k--;
    } else {
      const keep = xx - (insS - 2);
      if (keep > 0) rev.push({ kind: KEEP, count: keep });
      rev.push({ kind: INSERT, count: 1 });
      k++;
    }
    d--;
  }
  // d = 0: the initial snake kept lines 0 .. Vs[0][0] - 2.
  const first = Vs[0][0] - 2;
  if (first + 1 > 0) rev.push({ kind: KEEP, count: first + 1 });
  const runs = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const r = rev[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  return runs;
}

// ---------------------------------------------------------------- anchors (v2)

// The anchor layer, taken from v2: the search is O(D^2) and D is a few
// thousand, so the search dominates; the texts are 20-40k lines with only
// 3-10% changed, so most of the text is long unchanged runs. A k-gram that
// occurs exactly once in each text pins a block; extended while the lines
// keep matching, a block of T lines or more becomes an anchor. Moved blocks
// are 4-30 lines, so T = 32 keeps them out of the anchor set.
//
// v2 used the assembled anchor script as the answer and FAILED (0/4
// practice: same deleted/inserted totals, but 3-5 hunks per case differ —
// the greedy tie-break slides on repeated lines near an anchor/gap
// boundary). Here the anchor script is used ONLY as the banded search's
// centerline, never as the answer.

/** A k-gram is this many consecutive interned lines. */
const ANCHOR_K = 8;
/** An extended block becomes an anchor at this many lines. */
const ANCHOR_T = 32;

/** Rolling hash base (mod 2^32, via Math.imul and >>> 0). */
const HASH_P = 31;

/**
 * The rolling k-gram hashes of ids[0..n), one per starting position: h[i]
 * covers ids[i..i+K). A Uint32Array of length max(0, n - K + 1).
 */
function kgramHashes(ids, n, K) {
  const count = n - K + 1;
  const out = new Uint32Array(Math.max(0, count));
  if (count <= 0) return out;
  let pow = 1;
  for (let t = 0; t < K - 1; t++) pow = Math.imul(pow, HASH_P) >>> 0;
  let h = 0;
  for (let t = 0; t < K; t++) h = (Math.imul(h, HASH_P) + (ids[t] + 1)) >>> 0;
  out[0] = h;
  for (let i = 1; i < count; i++) {
    const top = Math.imul(ids[i - 1] + 1, pow) >>> 0;
    h = (Math.imul((h - top) >>> 0, HASH_P) + (ids[i + K - 1] + 1)) >>> 0;
    out[i] = h;
  }
  return out;
}

/**
 * First position + count per k-gram hash, packed as first + count * 100000
 * (both are under 100000 here: at most ~40000 lines a case). A count of 1
 * reads as a value under 200000.
 */
function kgramIndex(hashes) {
  const map = new Map();
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i];
    const v = map.get(h);
    if (v === undefined) map.set(h, i + 100000);
    else map.set(h, (v % 100000) + (Math.floor(v / 100000) + 1) * 100000);
  }
  return map;
}

/**
 * The middle split into gaps and anchors, as segments in order:
 * { gap: true, a0, b0, n, m } or { gap: false, a0, b0, len }.
 * a and b are the middle's interned ids, of lengths n and m.
 *
 * A left-to-right walk: a k-gram unique in both texts, whose new position is
 * still ahead of the frontier, is verified line by line (a hash collision
 * must not anchor), extended backward to the gap's start and forward while
 * the lines keep matching, and kept as an anchor when it reaches T lines.
 * Anything else advances one line. The walk is linear apart from the
 * extensions, and every line is extended over at most a few times.
 */
function anchorSegments(a, b, n, m) {
  const K = ANCHOR_K;
  const T = ANCHOR_T;
  const segments = [];
  if (n < K || m < K) {
    segments.push({ gap: true, a0: 0, b0: 0, n, m });
    return segments;
  }
  const ha = kgramHashes(a, n, K);
  const hb = kgramHashes(b, m, K);
  const idxA = kgramIndex(ha);
  const idxB = kgramIndex(hb);
  let ga = 0; // the gap's start in a (the end of the last anchor)
  let gb = 0; // the gap's start in b
  let i = 0;
  while (i + K <= n) {
    const ea = idxA.get(ha[i]);
    const eb = idxB.get(ha[i]);
    // Unique in both texts (a value under 200000 is a count of 1), and its new
    // position is still ahead of the frontier.
    if (ea !== undefined && eb !== undefined && ea < 200000 && eb < 200000) {
      const posB = eb % 100000;
      if (posB >= gb) {
        let ok = true;
        for (let t = 0; t < K; t++) {
          if (a[i + t] !== b[posB + t]) { ok = false; break; }
        }
        if (ok) {
          let a0 = i;
          let b0 = posB;
          while (a0 > ga && b0 > gb && a[a0 - 1] === b[b0 - 1]) { a0--; b0--; }
          let len = 0;
          while (a0 + len < n && b0 + len < m && a[a0 + len] === b[b0 + len]) len++;
          if (len >= T) {
            segments.push({ gap: true, a0: ga, b0: gb, n: a0 - ga, m: b0 - gb });
            segments.push({ gap: false, a0, b0, len });
            ga = a0 + len;
            gb = b0 + len;
            i = ga;
            continue;
          }
        }
      }
    }
    i++;
  }
  segments.push({ gap: true, a0: ga, b0: gb, n: n - ga, m: m - gb });
  return segments;
}

// ---------------------------------------------------------------- banded search (v3)

// The banded search: the anchor script is optimal, so its diagonal at each
// edit step, k_anchor(d), tracks the greedy path's diagonal closely — the
// two scripts differ only by tie-break slides on repeated lines, a few
// diagonals at most. So the full Myers search can be restricted to a band
// of half-width W around that centerline: D * (2W + 1) states instead of
// about D^2 / 2. The forward step and the backtrack re-apply myersRuns's
// rule exactly (deletion wins ties, the same canDel/canIns bounds, the same
// snake), so when the band holds the greedy path, the recovered script is
// the greedy script, byte for byte.
//
// The band is not trusted blindly: the search must reach the end at exactly
// d = D (the anchor script's edit count), and the backtracked path must stay
// at least BAND_MARGIN diagonals from the band's edge at every step. If
// either fails, the band widens (x2, to BAND_WMAX) and the search repeats;
// at the widest band the caller falls back to the full search. The entry
// therefore never returns a wrong answer — the band is a speedup, and the
// full search is the safety net.

/** The band's half-width for the first attempt. */
const BAND_W0 = 64;
/** The widest band tried before falling back to the full search. */
const BAND_WMAX = 1024;
/** The path must stay this far from the band's edge, or the band widens. */
const BAND_MARGIN = 2;

/** Debug only: what the last run() used (band half-width, whether it fell back to the full search, the smallest edge distance on the backtracked path). */
export const bandStats = { W: 0, fellBack: false, minDist: -1 };

/**
 * The centerline k_anchor(d) for d = 0..D, from the anchor script's runs:
 * a DELETE step is d+1, k+1; an INSERT step is d+1, k-1; a KEEP changes
 * neither. D is the runs' total DELETE + INSERT count, and center[D] is
 * n - m, the final diagonal.
 */
function centerline(runs, D) {
  const center = new Int32Array(D + 1);
  let d = 0;
  let k = 0;
  for (const r of runs) {
    if (r.kind === KEEP) continue;
    for (let i = 0; i < r.count; i++) {
      d++;
      k += r.kind === DELETE ? 1 : -1;
      center[d] = k;
    }
  }
  return center;
}

/**
 * The edit script between two slices of interned line ids, as forward-order
 * runs [{ kind, count }], from a banded Myers search — or null when the band
 * was not wide enough to trust, so the caller widens it or falls back to
 * the full search.
 *
 * a and b are Int32Array views of the slices, of lengths n and m. center[d]
 * is the anchor script's diagonal at step d, for d = 0..D, and W the band's
 * half-width: at step d only diagonals in [center[d]-W, center[d]+W] are
 * computed, in the same increasing order myersRuns uses. The V history is
 * one flat Int32Array, (D+1) rows of 2W+1, stored x + 2 (0 = no path),
 * exactly as myersRuns stores its Vs. A predecessor outside the band reads
 * as 0 (no path), which can only underestimate a diagonal's furthest x —
 * never overestimate it — so a too-narrow band fails by not reaching the
 * end, or by a path that hugs the edge, both of which return null here.
 *
 * On success the return is { runs, minDist }: the runs, and the smallest
 * distance from the band's edge the backtracked path ever had.
 */
function bandedRuns(a, b, n, m, center, D, W) {
  if (n === 0 && m === 0) return { runs: [], minDist: W };
  const width = 2 * W + 1;
  const V = new Int32Array((D + 1) * width);
  const kEnd = n - m;
  // d = 0: the initial snake from (-1, -1), on diagonal 0.
  let x = -1;
  while (x + 1 < n && x + 1 < m && a[x + 1] === b[x + 1]) x++;
  const base0 = center[0] - W;
  V[0 * width + (0 - base0)] = x + 2;
  let Dfound = -1;
  let kF = 0;
  if (x + 1 >= n && x + 1 >= m) {
    Dfound = 0;
    kF = 0;
  } else {
    let found = false;
    for (let d = 1; d <= D && !found; d++) {
      const base = center[d] - W;
      const basePrev = center[d - 1] - W;
      const row = d * width;
      const rowPrev = (d - 1) * width;
      let k = center[d] - W;
      if (((k + d) % 2) !== 0) k++;
      for (; k <= center[d] + W; k += 2) {
        const idx = k - base;
        const idxDel = k - 1 - basePrev;
        const idxIns = k + 1 - basePrev;
        const delS = idxDel >= 0 && idxDel < width ? V[rowPrev + idxDel] : 0;
        const insS = idxIns >= 0 && idxIns < width ? V[rowPrev + idxIns] : 0;
        const canDel = delS !== 0 && delS - 1 < n;
        const canIns = insS !== 0 && insS - 2 - k < m;
        if (!canDel && !canIns) continue;
        // The deletion's x after its step is delS - 1, the insertion's stays insS - 2.
        const byDel = canDel ? delS - 1 : -2;
        const byIns = canIns ? insS - 2 : -2;
        let xx;
        if (byDel >= byIns) xx = delS - 1;
        else xx = insS - 2;
        let y = xx - k;
        while (xx + 1 < n && y + 1 < m && a[xx + 1] === b[y + 1]) {
          xx++;
          y++;
        }
        V[row + idx] = xx + 2;
      }
      // Termination: only the end diagonal can reach both ends.
      const idxEnd = kEnd - base;
      if (idxEnd >= 0 && idxEnd < width && V[row + idxEnd] !== 0) {
        const xx = V[row + idxEnd] - 2;
        if (xx + 1 >= n && xx - kEnd + 1 >= m) {
          Dfound = d;
          kF = kEnd;
          found = true;
        }
      }
    }
    if (!found) return null;
  }
  if (Dfound !== D) return null;
  // Backtrack from (D, kF), exactly as myersRuns does, with the edge check.
  const rev = [];
  let minDist = W;
  let d = D;
  let k = kF;
  while (d > 0) {
    const base = center[d] - W;
    const idx = k - base;
    const dist = idx < width - 1 - idx ? idx : width - 1 - idx;
    if (dist < BAND_MARGIN) return null;
    if (dist < minDist) minDist = dist;
    const xx = V[d * width + idx] - 2;
    const basePrev = center[d - 1] - W;
    const idxDel = k - 1 - basePrev;
    const idxIns = k + 1 - basePrev;
    if (idxDel < 0 || idxDel >= width || idxIns < 0 || idxIns >= width) return null;
    const delS = V[(d - 1) * width + idxDel];
    const insS = V[(d - 1) * width + idxIns];
    const canDel = delS !== 0 && delS - 1 < n;
    const canIns = insS !== 0 && insS - 2 - k < m;
    if (!canDel && !canIns) return null;
    const byDel = canDel ? delS - 1 : -2;
    const byIns = canIns ? insS - 2 : -2;
    if (byDel >= byIns) {
      const keep = xx - (delS - 1);
      if (keep > 0) rev.push({ kind: KEEP, count: keep });
      rev.push({ kind: DELETE, count: 1 });
      k--;
    } else {
      const keep = xx - (insS - 2);
      if (keep > 0) rev.push({ kind: KEEP, count: keep });
      rev.push({ kind: INSERT, count: 1 });
      k++;
    }
    d--;
  }
  // d = 0: the initial snake kept lines 0 .. V[0][0] - 2.
  const first = V[0 * width + (0 - base0)] - 2;
  if (first + 1 > 0) rev.push({ kind: KEEP, count: first + 1 });
  const runs = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const r = rev[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  return { runs, minDist };
}

// ---------------------------------------------------------------- the patch

/** One patch line, as pieces: its op, the line's text, and its ending. */
function pushLine(out, op, parts, last, i) {
  out.push(op);
  out.push(parts[i]);
  if (i < last) out.push('\n');
  else out.push('\n%\n');
}

/** make.fun's own patch of the two texts, from their lines and the full runs. */
function buildPatch(a, b, runs, n, m) {
  // The change runs: each a stretch of deletions and insertions between two kept
  // lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }
  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) pushLine(out, '=', a.parts, a.last, at);
      for (let i = 0; i < c.dels; i++) pushLine(out, '-', a.parts, a.last, c.o + i);
      for (let i = 0; i < c.ins; i++) pushLine(out, '+', b.parts, b.last, c.p + i);
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) pushLine(out, '=', a.parts, a.last, at);
  }
  return out.join('');
}

// ---------------------------------------------------------------- the entry point

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const mapW = new Map();
  const mapB = new Map();
  const next = { v: 0 };
  const a = splitLines(input.old, mapW, mapB, next);
  const b = splitLines(input.new, mapW, mapB, next);
  const n = a.count;
  const m = b.count;
  const ai = a.ids;
  const bi = b.ids;
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && ai[prefix] === bi[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && ai[n - 1 - suffix] === bi[m - 1 - suffix]) suffix++;
  const am = ai.subarray(prefix, n - suffix);
  const bm = bi.subarray(prefix, m - suffix);
  const nm = n - prefix - suffix;
  const mm = m - prefix - suffix;
  // The anchor script for the middle (v2's layer). It is optimal, so its
  // total edit count is the true D — but it is NOT the greedy script, so it
  // is used only as the banded search's centerline, never as the answer.
  const anchorRuns = [];
  let Dmid = 0;
  for (const s of anchorSegments(am, bm, nm, mm)) {
    if (s.gap) {
      if (s.n === 0 && s.m === 0) continue;
      for (const r of myersRuns(am.subarray(s.a0, s.a0 + s.n), bm.subarray(s.b0, s.b0 + s.m), s.n, s.m)) {
        anchorRuns.push(r);
        if (r.kind !== KEEP) Dmid += r.count;
      }
    } else {
      anchorRuns.push({ kind: KEEP, count: s.len });
    }
  }
  // The middle's edit script: the banded search, widening on overflow, with
  // the full search as the last resort. The answer is always exact.
  let middle;
  if (nm === 0 && mm === 0) {
    middle = [];
    bandStats.W = 0;
    bandStats.fellBack = false;
    bandStats.minDist = -1;
  } else {
    const center = centerline(anchorRuns, Dmid);
    let found = null;
    let W = BAND_W0;
    while (found === null) {
      found = bandedRuns(am, bm, nm, mm, center, Dmid, W);
      if (found === null) {
        if (W >= BAND_WMAX) break;
        W *= 2;
      }
    }
    if (found !== null) {
      middle = found.runs;
      bandStats.W = W;
      bandStats.fellBack = false;
      bandStats.minDist = found.minDist;
    } else {
      middle = myersRuns(am, bm, nm, mm);
      bandStats.W = W;
      bandStats.fellBack = true;
      bandStats.minDist = -1;
    }
  }
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  for (const r of middle) runs.push(r);
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });
  return buildPatch(a, b, runs, n, m);
}
