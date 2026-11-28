# Diff Speed — Diff two texts faster

[![diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/c/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/aramexbit/diff-speed-01-run-20261126-v3/rank.svg)](https://make.fun/c/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/aramexbit/diff-speed-01-run-20261126-v3/reward.svg)](https://make.fun/c/diff-speed-01-run-20261126)

An entry for the [make.fun](https://make.fun/c/diff-speed-01-run-20261126) competition **diff-speed-01-run-20261126**: write a faster drop-in for make.fun's own makefun-diff 1.0.0 that answers exactly as it does on every case.

`solve.js` (Node 22, no dependencies) interns both texts' lines to integer ids once per case, trims the common prefix and suffix, then runs Myers's greedy search — keeping only the furthest x per diagonal, with makefun-diff's own tie-break (the deletion wins ties) — and recovers the edit script by backtracking the stored arrays. The patch is built as pieces in one array joined once. `main.ts` is the harness driver.

v3 (this version): the search is banded. The anchor layer (unique 8-grams, blocks of 32+ lines) gives an optimal script whose diagonal at each edit step tracks the greedy path's diagonal within a few diagonals, so the Myers search is restricted to a band of half-width 64 around that centerline — D * 129 states instead of about D^2 / 2. The band is not trusted blindly: the search must reach the end at exactly d = D and the backtracked path must stay 2 diagonals from the band's edge, or the band widens (x2, to 1024) and, at the widest, the full search runs instead. The answer is therefore always the greedy one. (v2 used the anchor script itself as the answer and was wrong — same edit counts, different hunks; v3 uses it only as the centerline.)

## Run it

```
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Practice-set check (kit): **4/4 answers identical** to makefun-diff 1.0.0; also 4/4 on two fresh generator draws and 28/28 on the edge-case suite (`edge-v3.mjs`), all with no band fallback. ~0.49 s user CPU per 4-case set locally vs ~0.72 s for v1 (~0.32 s vs ~0.56 s net of the null-entry control).
