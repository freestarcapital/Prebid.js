---
name: upstream-merge
description: Use when merging a new upstream Prebid.js release tag into the freestarcapital fork. Prompts for ticket name and release version, runs git fetch/merge, resolves known fork-specific conflicts, runs npm install and gulp build.
---

# Upstream Merge

Automates merging a new upstream Prebid.js release into this fork.

## Inputs — prompt the user for these before starting

1. **TICKET_NAME** — branch name for this merge (e.g. `PFG-1234-prebid-10.22.0`)
2. **TAG_NAME** — upstream release tag to merge (e.g. `10.22.0`)

## Steps

### 0. Ensure upstream remote is configured
```bash
git remote get-url upstream 2>/dev/null || git remote add upstream https://github.com/prebid/Prebid.js
```

### 1. Fetch upstream tags
```bash
git fetch upstream --tags
```

### 2. Create and checkout new branch
```bash
git checkout -b TICKET_NAME
```

### 3. Merge the release tag
```bash
git merge TAG_NAME
```

If there are no conflicts, skip to Step 5.

### 4. Resolve merge conflicts

After the merge, check conflict status:
```bash
git status
```

For each conflicted file, apply the rules below, then stage it:
```bash
git add <file>
```

#### General conflict resolution rule

**When our fork's edits conflict with upstream: keep our fork's edits, accept upstream changes that don't conflict, then notify the user.**

After resolving all conflicts, report to the user:
- Which files had conflicts beyond the known rules below
- What fork-specific edits were preserved in each

The file-specific rules below take precedence for known files.

#### 4a. `package.json` conflicts

Ensure these two entries are present after resolving:

**Top-level key** (after `"keywords"` block):
```json
"globalVarName": "fsprebid",
```

**First entry in `devDependencies`**:
```json
"@babel/plugin-proposal-private-methods": "^7.18.6",
```

Accept all upstream changes to other sections; keep our fork additions.

#### 4b. `gulpHelpers.js` conflicts

Ensure the module aliasing block is present inside `getArgModules()`, immediately after the single-JSON-file loading block (around line 65):

```js
try {
    const moduleAliases = JSON.parse(
        fs.readFileSync('module-alias.json', 'utf8')
    );
    modules = modules.map(module => moduleAliases[module] || module);
} catch (_e) {}
```

Accept all other upstream changes to this file.

#### 4c. `src/constants.ts` conflicts

Ensure the debug mode constant uses the fork's custom value:

```ts
export const DEBUG_MODE = 'fspb_debug';
```

Upstream uses `'pbjs_debug'` — always replace with `'fspb_debug'`.

#### 4d. `src/utils.js` conflicts

Ensure `logWarn()` and `logError()` wrap the `AUCTION_DEBUG` event emission in a `debugTurnedOn()` guard. Upstream emits unconditionally; our fork only emits when debug is on:

```js
// In logWarn():
if (debugTurnedOn()) {
  emitEvent(EVENTS.AUCTION_DEBUG, { type: 'WARNING', arguments: arguments });
}

// In logError():
if (debugTurnedOn()) {
  emitEvent(EVENTS.AUCTION_DEBUG, { type: 'ERROR', arguments: arguments });
}
```

Accept all other upstream changes to this file.

#### 4e. Install dependencies and stage package-lock.json

Run `npm i` **before** completing the merge commit so that `package-lock.json` is included in the merge commit:

```bash
npm i
git add .
```

#### 4f. Complete the merge
```bash
git merge --continue
```

Or if `--continue` is not applicable (all conflicts already staged):
```bash
git commit -m "chore: merge upstream TAG_NAME"
```

### 5. Verify the build
```bash
npx gulp build
```

A successful build (no errors) confirms the merge is clean.

## Verification checklist

- [ ] `package.json` contains `"globalVarName": "fsprebid"`
- [ ] `package.json` contains `"@babel/plugin-proposal-private-methods": "^7.18.6"` in `devDependencies`
- [ ] `gulpHelpers.js` contains the `module-alias.json` aliasing block
- [ ] `src/constants.ts` has `DEBUG_MODE = 'fspb_debug'`
- [ ] `src/utils.js` has `debugTurnedOn()` guard around `AUCTION_DEBUG` events in `logWarn()` and `logError()`
- [ ] `npx gulp build` exits with no errors
