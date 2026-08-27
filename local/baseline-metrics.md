# Baseline Metrics — simplification-review-plan Step 1

Captured 2026-08-26T06:15 UTC before any simplification edits.

## TypeCheck
- `npm run typecheck`: PASS (no errors, 18.77s)

## Tests
- `npm test`: 33 test files, 320 tests passed (Duration 23.90s)
- Previous plan reported 308; current baseline is 320 (new tests added since 308 snapshot)
- Expected after Sentinel removal: ~280 (delete ipc.test + freeze.test suites)

## Coverage (`npm run test:coverage`)
- Statements: 91.6% (2312/2524) — FAILS gate 92%
- Branches: 84.51% (1097/1298) — FAILS gate 85%
- Functions: 93.71% (313/334) — PASS (gate 90%)
- Lines: 93.2% (2139/2295) — PASS (gate 93%)
- Note: Gates 93/92/90/85 defined in package.json. Current baseline slightly below statements/branches gates even before simplification; likely due to newly added code (320 vs 308) or uncovered ipc/freeze branches. Must keep or improve after simplification.

## File totals
- `wc -l src/**/*.ts src/*.ts`: 7566 lines total
- Detailed:
  - anchors: allocator 47, alphabet 46, fingerprints 38, hasher 63, reconcile 87, sequence-map 83
  - document: decode 26, encoding 94, file-kind 56, lines 108
  - filesystem: atomic-write 249, concurrency 11, resolve-target 66
  - integration: freeze 147, ipc 407, protocol 15, session 79, write-hook 99
  - mutation: apply 551, overlap 26, resolve 66, transaction 376, validate 274
  - render: budget 76, diff 91, errors 52, hashline 128, result-details 76, warnings 192
  - served: authorize 162, epoch 41, ledger 275
  - state: database 368, recovery 136, schema 58, snapshots 275, transaction-journal 177, undo 102
  - tools: edit 474, grep 471, insert 351, mutation-types 27, read 149, undo 262, write 468
  - constants 50, paths 39, utils 52
  - index.ts 44 (not in wc glob above? included via src/*.ts? actually top-level)

## Sentinel surface size
- `wc -l src/integration/ipc.ts src/integration/freeze.ts src/integration/protocol.ts`: 407 + 147 + 15 = 569 lines
- Dead-code grep hits (`isFrozen|emitMutation|IPC_PROTOCOL|setContextEpoch`) in src/: 39 hits across:
  - src/tools/edit.ts (6), insert.ts (6), write.ts (6), undo.ts (2)
  - src/integration/ipc.ts (8), freeze.ts (1), protocol.ts (2), session.ts via restoreFreezes/emitContextEpoch (not in this grep but tagged)
  - src/served/epoch.ts setContextEpoch (1)
- Additional tagged symbols: `emitMutationBefore/After/Rejected`, `emitUndoAfter`, `emitContextEpoch`, `mutationEventBase`, `restoreFreezes`, `isFrozen`, `frozenRejection`, `setContextEpoch`
- Expected removal in Step 7: ~550 lines (ipc.ts 407 + freeze.ts 147, plus partial protocol/session/epoch cleanup)

## Dependency map highlights
- file-length >350 lines (complexity hint): mutation/apply.ts 551, tools/edit.ts 474, tools/grep.ts 471, tools/write.ts 468, mutation/transaction.ts 376, state/database.ts 368, tools/insert.ts 351, served/ledger.ts 275, state/snapshots.ts 275, mutation/validate 274, tools/undo 262, filesystem/atomic-write 249
- import fan-in: `src/render/budget.ts` imported by hashline.ts + diff.ts; `src/served/ledger.ts` imported by ~8 files; `src/state/database.ts` imported by 5 state files + transaction + session
- Sentinel dead imports: all 4 mutation tools import from `src/integration/freeze`; edit/insert/write import from `src/integration/ipc` (emitMutation*); session.ts imports restoreFreezes + emitContextEpoch; ipc.ts imports setContextEpoch
- Stable public exports to preserve after merges:
  - document/encoding: detectBom, looksBinary, decodeUtf8Strict, decodeText
  - render/budget+diff+hashline merged engine must keep: renderLinesBounded, renderDiff, renderLinesUnserved, applyOutputBudget (internal)
  - served/epoch: currentEpoch, getContextEpoch, advanceContextEpoch, resetContextEpoch (delete setContextEpoch)
  - integration/protocol: keep HASHLINE_PROTOCOL_ID + HASHLINE_RESULT_PROTOCOL (delete IPC_PROTOCOL_ID)

## Reconciliation against plan2.md (optimizations already applied — do not re-propose)
- [x] Anchor h32 hasher: `src/anchors/hasher.ts` exposes `h32` 32-bit fallback and `getH().h32` used in allocator 34
- [x] Int-ID Myers: `src/anchors/sequence-map.ts:alignSequences` uses integer IDs (allocator uses Set<number>)
- [x] Numeric anchor sets: allocator active/retired are `Set<number>`
- [x] Prepared-statement cache: `src/state/database.ts:57-92` 32-entry LRU WeakMap + prepareCached/cachedPrepare
- [x] PRAGMA synchronous = NORMAL: database.ts openDb sets WAL/NORMAL (check openDb confirms)
- [x] LRU ledger: `src/served/ledger.ts` MAX_SERVED_PER_FILE 5000 / MAX_SERVED_TOTAL 20000
- [x] Chunked precommit: `src/filesystem/atomic-write.ts:precommitVerify` uses streaming hash (verify has hash instead of full buffer alloc)
- [x] Reused TextDecoder: `src/document/encoding.ts` uses module-level decoder
- [x] Single-pass binary detection: `looksBinary` consolidated (encoding.ts)
- [x] Dense integer IDs: allocator uses h32%SPACE
- Remaining plan2 items NOT yet applied and covered by this simplification plan: file-kind+encoding merge, render engine merge, shared mutation lifecycle, sentinel removal, etc.

## Next steps
- Proceed to Step 2 dead re-export removal; handle import rewrites iteratively with typecheck after each deletion.
