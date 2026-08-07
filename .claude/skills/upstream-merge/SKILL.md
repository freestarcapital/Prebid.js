---
name: upstream-merge
description: Use when merging a new upstream Prebid.js release tag into the freestarcapital fork. Prompts for ticket name and release version, rebuilds the tree from pure upstream, re-applies the small fork footprint, resolves the few real overlap conflicts, runs npm install and gulp build.
---

# Upstream Merge

Merges a new upstream Prebid.js release into this fork **without drowning in ~1750
spurious conflicts**.

## Why not a plain `git merge`

This `freestar`/`fsprebid` fork's git history does **not** share commit lineage with
upstream `prebid/Prebid.js` release tags: `git merge-base HEAD <tag>` resolves to an
ancient base (~8.49.0, May 2024) even though the fork tracks 11.x. So a naive
`git merge <tag>` 3-way-merges against that ancient base and produces ~1750 conflicts —
almost the whole tree. **These are noise, not real divergence.**

The fork's actual customizations are small and stable — on the order of ~135 files
(mostly fork-private adapters/modules the fork *adds*, and upstream CI the fork
*deletes*). Only a handful are genuine *modifications* to files upstream also changes;
those are the only real conflicts. The strategy below rebuilds the working tree to pure
upstream, then re-lays the fork footprint on top, so you only hand-merge that handful.

## Inputs — prompt the user for these before starting

1. **TICKET_NAME** — Jira ticket for this merge (e.g. `PFG-5232`). The branch name must
   also contain `agent` or `codex` per the repo's CLAUDE.md branch rule — use e.g.
   `PFG-5232-prebid-11.25.0-agent`.
2. **NEW_TAG** — upstream release tag to merge to. If the user says "latest", pick the
   highest `git tag -l '11.*' | sort -V | tail -1` after fetching (Step 1).

**PREV_TAG** (the upstream tag the fork currently sits on) is auto-detected in Step 2 —
do not ask for it.

## Steps

### 0. Ensure upstream remote is configured
```bash
git remote get-url upstream 2>/dev/null || git remote add upstream https://github.com/prebid/Prebid.js
```

### 1. Fetch upstream tags
```bash
git fetch upstream --tags
git tag -l '11.*' | sort -V | tail -8    # confirm NEW_TAG is available; pick latest if asked
```

### 2. Determine PREV_TAG (current fork base) and start the branch from `main`

`PREV_TAG` is the recent tag whose diff against the fork is *smallest* (that diff **is**
the fork footprint). Check the last couple of tags:
```bash
git checkout main && git pull
for t in <candidate tags>; do echo -n "$t: "; git diff --name-only HEAD $t | wc -l; done
```
The tag with the ~135-file diff is PREV_TAG. Then:
```bash
git checkout -b TICKET_NAME        # e.g. PFG-5232-prebid-11.25.0-agent (must contain 'agent'/'codex')
```

### 3. Classify the fork footprint (read-only, before touching anything)
```bash
git diff --name-status PREV_TAG HEAD > /tmp/fork_footprint.txt   # HEAD = fork main
awk '$1=="D"{print $2}' /tmp/fork_footprint.txt > /tmp/D_files.txt   # fork DELETES (mostly upstream CI)
awk '$1=="A"{print $2}' /tmp/fork_footprint.txt > /tmp/A_files.txt   # fork-private ADDITIONS
awk '$1=="M"{print $2}' /tmp/fork_footprint.txt > /tmp/M_files.txt   # fork MODIFICATIONS

# The only files needing a real 3-way merge = fork-modified ∩ upstream-changed-between-tags:
comm -12 <(sort /tmp/M_files.txt) <(git diff --name-only PREV_TAG NEW_TAG | sort) > /tmp/M_merge.txt
grep -vxF -f /tmp/M_merge.txt /tmp/M_files.txt > /tmp/M_safe.txt      # fork-modified, upstream untouched
cat /tmp/M_merge.txt        # typically 3-6 files, incl. package.json, package-lock.json
```

### 4. Rebuild the tree and re-apply the fork footprint

#### 4.1 Start the merge to set MERGE_HEAD (ignore the conflict spew)
```bash
git merge --no-edit NEW_TAG                 # exits 1 with ~hundreds of conflicts — expected, ignore
git rev-parse -q --verify MERGE_HEAD        # must print a hash (the merge is in progress)
```

#### 4.2 Reset the whole tree to pure upstream (MERGE_HEAD survives)
```bash
git read-tree -u --reset NEW_TAG            # index + worktree become exactly NEW_TAG
git diff --stat NEW_TAG                     # must be empty
```

#### 4.3 Re-apply the fork footprint
```bash
# Remove the files the fork deletes (upstream CI, etc.)
tr '\n' '\0' < /tmp/D_files.txt | xargs -0 git rm -f --ignore-unmatch

# Restore fork additions + fork-modified-but-upstream-untouched files straight from main.
# GOTCHA: `git checkout HEAD -- <list>` is ATOMIC — if any path is missing in HEAD it
# restores NOTHING. Only feed it A + M_safe (all present in HEAD); never include D paths.
cat /tmp/A_files.txt /tmp/M_safe.txt > /tmp/restore.txt
tr '\n' '\0' < /tmp/restore.txt | xargs -0 git checkout HEAD --
```

#### 4.4 Hand-merge the overlap files in `/tmp/M_merge.txt`

For each source/config file (handle `package-lock.json` via `npm i` in 4.6, not here),
do a real 3-way merge. **`git merge-file` needs *seekable* files** — process substitution
(`<(...)`) gives non-seekable pipes and silently produces EMPTY output while exiting 0.
Always write the three versions to real temp files first (ours = fork `main`,
base = PREV_TAG, theirs = NEW_TAG):
```bash
for f in $(cat /tmp/M_merge.txt); do
  [ "$f" = package-lock.json ] && continue
  b=/tmp/m3/$(echo "$f" | tr / _); mkdir -p /tmp/m3
  git show HEAD:"$f"     > "$b.ours"
  git show PREV_TAG:"$f" > "$b.base"
  git show NEW_TAG:"$f"  > "$b.theirs"
  git merge-file -p "$b.ours" "$b.base" "$b.theirs" > "$f"   # rc>0 ⇒ conflict hunks remain
done
git grep -lE '^<<<<<<< |^>>>>>>> ' -- . ':(exclude)package-lock.json'   # find leftover conflicts
```
Resolve any remaining `<<<<<<<` hunks by hand using the **file-specific rules below**
(keep fork edits, take upstream's non-conflicting bumps), then `git add` each file.

#### 4.5 Strip upstream CI (make `.github` match `main`)

The fork runs no upstream CI. **New upstream CI files added since PREV_TAG won't be in
`/tmp/D_files.txt`** (that list predates them), so removing the D list is not enough.
Force `.github` to exactly match fork `main` (usually empty):
```bash
git ls-tree -r --name-only HEAD -- .github | sort > /tmp/github_head.txt
comm -13 /tmp/github_head.txt <(git ls-files -- .github | sort) > /tmp/github_remove.txt
[ -s /tmp/github_remove.txt ] && tr '\n' '\0' < /tmp/github_remove.txt | xargs -0 git rm -f
diff <(git ls-files -- .github | sort) /tmp/github_head.txt && echo "MATCH"
```

#### 4.6 Regenerate the lockfile and stage everything
```bash
npm i                       # rebuilds package-lock.json from the merged package.json
git add -A
```

#### 4.7 Verify the footprint, then commit
```bash
# The staged tree vs NEW_TAG must be ONLY the fork footprint (A + D + the M overrides).
git diff --cached --name-status NEW_TAG | awk '{print $1}' | sort | uniq -c   # ~ 64 A / ~60 D / ~12 M
git grep -lE '^<<<<<<< |^>>>>>>> ' -- . ':(exclude)package-lock.json' || echo "no conflict markers"
git commit --no-edit -m "Upstream merge NEW_TAG"   # MERGE_HEAD present ⇒ real 2-parent merge commit
```

### 5. Verify the build
```bash
npx gulp build   # clean → build-bundle-prod → setupDist; no lint step, so a broken eslint config won't block it
```
A successful build (no errors) confirms the merge is clean.

## File-specific resolution rules (for the 4.4 overlap files)

The general rule for a hand-merged overlap file: **keep the fork's edits, take upstream's
non-conflicting changes**, then notify the user which files needed manual resolution.

#### `package.json`
Ensure these fork entries survive:
- Top-level key (after the `"keywords"` block): `"globalVarName": "fsprebid",`
- In `devDependencies`: `"@babel/plugin-proposal-private-methods": "^7.18.6",`

Take upstream's version bumps to other dependencies.

#### `gulpHelpers.js`
Ensure the module-alias block is present inside `getArgModules()`, right after the
single-JSON-file loading block:
```js
try {
    const moduleAliases = JSON.parse(
        fs.readFileSync('module-alias.json', 'utf8')
    );
    modules = modules.map(module => moduleAliases[module] || module);
} catch (_e) {}
```

#### `src/constants.ts`
Ensure `export const DEBUG_MODE = 'fspb_debug';` (upstream uses `'pbjs_debug'` — always
replace with the fork value).

#### `AUCTION_DEBUG` emission guard (logging helpers)
The fork emits `AUCTION_DEBUG` only when debug is on; upstream emits it unconditionally.
As of upstream 11.18.0 the helpers live in `src/utils/logging.ts`, built by a shared
`makeLogger()` factory, so the guard lives there:
```ts
// src/utils/logging.ts — inside makeLogger()'s returned function:
if (emit && debugTurnedOn()) {
  emitEvent(EVENTS.AUCTION_DEBUG, { type: LEVELS[level] as DebugEvent['type'], arguments: args });
}
```
If a future release relocates these helpers, find the emitter
(`git grep AUCTION_DEBUG -- 'src/*'`) and apply the same `debugTurnedOn()` guard. In
older layouts (≤ 11.13.0) they lived directly in `src/utils.js`. **If the file moved,
`logging.ts` will appear in `/tmp/M_merge.txt` or the leftover-conflict list — always
check where the guarded code moved to.**

#### `src/adapters/bidderFactory.ts` — TTD gzip signaling + GZIP fail-safe fallback
Two fork changes live in the POST branch of `processBidderRequests`. This file is heavily
churned by upstream — expect it in `/tmp/M_merge.txt` most releases; re-apply **by intent,
not by line**:

1. **`gzipViaHeader` opt-in.** The `AdapterRequest.options` type carries
   `gzipViaHeader?: boolean`. When set, core signals compression with a
   `Content-Encoding: gzip` request header (added in the `callAjax` closure via
   `opts.customHeaders`) and **omits** the `?gzip=1` query param. Every other adapter
   (flag unset) keeps `?gzip=1`. Consumed by the TTD adapter (below).

2. **GZIP fail-safe fallback.** The compress branch must never send a gzip-signaled
   request with a bad body. Keep: a `sendUncompressed()` helper (original body, **no**
   gzip signal); the empty-output guard
   (`!compressedPayload || compressedPayload.length === 0`); and the **two-arg**
   `compressDataWithGZip(request.data).then(onFulfilled, onRejected)` form — NOT
   `.then().catch()` (two-arg prevents a double-send if the success callback throws). On
   rejection OR empty output, `logWarn` then `sendUncompressed()`. The no-compression
   `else` also uses `sendUncompressed()`.

Tests: `test/spec/unit/core/bidderFactory_spec.js` → `describe('gzip compression')`.

#### `modules/ttdBidAdapter.js` — TTD gzip enablement (publisher opt-in)
The fork enables gzip compression on TTD, signaled via the header hook above. Keep:
- `DEFAULT_GZIP_ENABLED = false` and `getGzipSetting(bidderCode)` — reads `gzipEnabled`
  from `config.getBidderConfig()` for the active bidder code (honors the `thetradedesk`
  alias via `??`, falls back to canonical `ttd`, parses boolean/string, try/catch →
  default false).
- In `buildRequests`, request `options`: `endpointCompression: getGzipSetting(bidderRequest.bidderCode)`
  and `gzipViaHeader: true`.

The adapter does **NOT** reference `isGzipCompressionSupported`, debug mode, or
`customHeaders` — core owns all of that. (This supersedes any older TTD-gzip note that had
the adapter set `customHeaders`/`isGzipCompressionSupported`.) Tests:
`test/spec/modules/ttdBidAdapter_spec.js` → `describe('gzip compression ...')`.

#### Root docs (`AGENTS.md`, `PR_REVIEW.md`, `CLAUDE.md`)
These aren't fork customizations — the fork has historically tracked upstream for them.
They usually aren't in `/tmp/M_merge.txt` (not fork-modified), so the rebuild leaves them
at NEW_TAG automatically. If a merge run pulls them into the footprint, confirm with the
user whether to take upstream's version (default) or freeze the fork's.

## Verification checklist

- [ ] `git rev-parse MERGE_HEAD` was valid before committing (result is a 2-parent merge commit)
- [ ] `git diff --cached --name-status NEW_TAG` shows **only** the fork footprint (~135 files: A + D + ~12 M)
- [ ] No conflict markers remain (`git grep -lE '^<<<<<<< |^>>>>>>> '`, excluding `package-lock.json`)
- [ ] `package.json` contains `"globalVarName": "fsprebid"` and `"@babel/plugin-proposal-private-methods": "^7.18.6"`
- [ ] `gulpHelpers.js` contains the `module-alias.json` aliasing block
- [ ] `src/constants.ts` has `DEBUG_MODE = 'fspb_debug'`
- [ ] `AUCTION_DEBUG` emission is guarded by `debugTurnedOn()` (in `src/utils/logging.ts` as of 11.18.0; was `src/utils.js` ≤ 11.13.0)
- [ ] `src/adapters/bidderFactory.ts` keeps the `gzipViaHeader` header signaling AND the GZIP fail-safe fallback (`sendUncompressed`, empty-output guard, two-arg `.then(onFulfilled, onRejected)`)
- [ ] `modules/ttdBidAdapter.js` keeps `getGzipSetting`/`DEFAULT_GZIP_ENABLED` and sets `endpointCompression` + `gzipViaHeader: true` (no adapter-side `customHeaders`/`isGzipCompressionSupported`)
- [ ] `.github` matches fork `main` (no upstream workflows/actions/codeql remain)
- [ ] `npm i` ran so `package-lock.json` reflects the merged `package.json`
- [ ] `npx gulp build` exits with no errors
