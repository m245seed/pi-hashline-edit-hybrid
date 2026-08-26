## Context

Deep technical review of pi-hashline-edit-hybrid — a fail-closed, hash-anchored text mutation system for Pi coding agents. The extension provides persistent 4-character line anchors, served-state authorization, atomic mutations, crash recovery, and stale-safe undo via SQLite persistence.

Six parallel scouts explored: core tools, state management, mutation engine, anchor system, rendering/served state, and integration/filesystem/document layers. Findings cover performance bottlenecks, memory optimization, algorithmic improvements, code duplication, validation gaps, and architectural refinements.

## Approach

### 1. Performance Optimizations

**Anchor System — Hash Computation & Allocation**
- Replace per-line `createHash("sha256")` with batched or reusable hasher in `src/anchors/fingerprints.ts:lineFingerprintHex`. 50k+ lines create 50k separate crypto instances causing GC pressure.
- Switch `src/anchors/hasher.ts:xxh64` from BigInt modulo to `h32()` which operates on 32-bit integers without BigInt allocations per line.
- Store active/retired anchor sets as `Set<number>` instead of `Set<string>` in `src/anchors/allocator.ts:AnchorAllocator` to avoid string conversions (`idxToAnchor`) during collision probing.
- Convert SHA-256 hex fingerprints (64-char strings) to integer IDs before passing to `Diff.diffArrays` in `src/anchors/sequence-map.ts:alignSequences` to reduce Myers diff string comparison overhead from O(N·D).
- Work with raw `Uint8Array` fingerprints instead of 64-char hex strings in `src/anchors/fingerprints.ts:decodeFingerprintHexes` to reduce memory 4-8x for large files.

**State Management — Database Operations**
- Introduce prepared statement cache in `src/state/database.ts` to avoid re-parsing SQL on every `snapshots.ts`, `transaction-journal.ts`, `undo.ts` call.
- Replace synchronous `Atomics.wait` sleep in `database.ts:68-79:sleepSync` with async retry or non-blocking backoff to avoid halting event loop during SQLite contention.
- Change `PRAGMA synchronous = FULL` to `PRAGMA synchronous = NORMAL` in WAL mode (`database.ts:84`) for crash-durability with lower latency.
- Add index on `pending_transactions.created_at` for `ORDER BY` query in `transaction-journal.ts:141`.

**Mutation Engine — Diff & Allocation**
- Restrict `Diff.diffArrays` in `src/mutation/apply.ts:351:buildDiffRows` to modified ranges plus context instead of full-file O(N·M) LCS on large files with small edits.
- Eliminate redundant full-document string reconstructions: `joinTextLines` called twice (`apply.ts:107,185`) then immediately `splitTextLines` (`apply.ts:240`). Operate directly on line arrays when terminators are uniform.
- Replace `new Set(anchorState.anchors)` and `preservedOld` Set in `apply.ts:245,249` with boolean `Uint8Array` to avoid thousands of allocations on large files.

**Core Tools — Grep & Validation**
- Fix O(N²) linear scan in `src/tools/grep.ts:373:runRipgrep` where `entries.find((e) => e.lineNumber === num)` is called per match. Use `Map<number, LineEntry>`.
- Defer or skip full `loadAnchoredFile` reconciliation in `grep.ts:182-192` for files that won't be immediately mutated.
- Batch `renderLinesUnserved` calls in `grep.ts:208-223` across contiguous match ranges instead of per-line rendering.
- Eliminate redundant split-then-join in `src/tools/write.ts:98-106:encodeContent`.

**Rendering — Budget & Diff**
- Compute UTF-8 byte length once per row; currently computed in `src/render/diff.ts:44,47,58` then recomputed in `src/render/budget.ts:48:applyOutputBudget`.
- Remove redundant `.slice()` on fresh array in `diff.ts:64`.
- Avoid array slices in `src/render/warnings.ts:53-83:detectBoundaryDuplication` by comparing via indexed loops, eliminating O(K²) allocations.
- Skip full-document array allocation in `warnings.ts:135-151:computePostTransactionTexts` for localized edits.
- Eliminate intermediate `CandidateRow` wrappers in `budget.ts:40-57:applyOutputBudget` via direct iterative accumulation.

**Served State — Ledger & Authorization**
- Cap `ServedEntry` storage or add LRU eviction in `src/served/ledger.ts:56-61,64-73` to prevent unbounded memory growth from storing `exactText` and timestamps for every line in long sessions.
- Replace nested loop in `ledger.ts:135-155:reconcileServed` with O(N+M) two-pointer sweep instead of O(N·M).
- Hoist `ledger.get(path)` and `staleAnchors.get(path)` outside per-line loop in `src/served/authorize.ts:45-64:checkRangeServed`.

**Document Processing**
- Replace `text.split(/(\\r\\n|\\n|\\r)/)` in `src/document/lines.ts:splitTextLines` with index-based scanning to avoid allocating 200k-element arrays for 100k-line files.
- Combine binary sniffing and control character counting in `src/document/encoding.ts:looksBinary` into single pass.
- Reuse module-level `TextDecoder` instance in `encoding.ts:decodeUtf8Strict` instead of creating per call.

**Filesystem**
- Replace full-file buffer allocation in `src/filesystem/atomic-write.ts:precommitVerify` with streaming or hash comparison for large files.
- Fix `snapshots.ts:94:decodeRetiredBlob` to wrap `blob` once before loop instead of `Buffer.from(blob)` per retired anchor.
- Write fingerprints directly with `out.write(hex, offset, "hex")` in `snapshots.ts:60-66:encodeFingerprintsBlob` instead of `Buffer.from(hex)` per line.

### 2. Code Quality & Maintainability

**Reduce Tool Duplication**
- Extract shared mutation lifecycle boilerplate from `src/tools/edit.ts`, `insert.ts`, `write.ts`: freeze checks, mutation queue locking, IPC emission (`emitMutationBefore/After/Rejected`), warning regex extraction, metrics construction.
- Create shared `mutationTargetPath` helper for `toCwd` + `resolveTarget` used identically in all six tools.
- Unify `MutationMetrics` object construction duplicated across edit/insert/undo.

**Validation Consistency**
- Add `rejectUnknownFields()` to `src/tools/read.ts:60-67`, `grep.ts:80-97`, `write.ts:109-126`, `undo.ts:57-60` to match strict shape checking in edit/insert.
- Apply `DISPLAY_LIKE_RE` validation in `write.ts` to reject pasted anchor prefixes when overwriting files.
- Consolidate hex revision validation: `write.ts:119-124` duplicates `validate.ts:153-160:assertExpectedRevision`.

**Error Handling Uniformity**
- Align `src/tools/undo.ts:74-135` error delivery to match edit/insert pattern: throw Error instead of returning `{ isError: true }` objects for `E_NO_UNDO` and `E_UNDO_STALE`.
- Decide whether `read.ts:76-96` treating `offset > totalLines` as success (`OFFSET_BEYOND_EOF`) vs error is intended behavior or inconsistency.

**API Clarity**
- Make `src/render/diff.ts:70:renderDiff` pure like `hashline.ts:81:renderLinesBounded` by removing internal `serveLines` side effect, or document/rename to signal mutation.
- Remove redundant dual properties `servedRows` and `servedRowCount` in `src/render/result-details.ts:28-34,51-54`.

### 3. Robustness & Safety

**Concurrency & Race Conditions**
- Fix write-hook race: `src/integration/write-hook.ts:46:loadAnchoredFile` lacks `withFileMutationQueue` lock, allowing simultaneous mutations to race during anchor reconciliation.
- Handle unordered async freeze persistence in `src/integration/freeze.ts:persistFreezes` where rapid updates spawn unhandled promises that may resolve out of order.
- Address TOCTOU in `src/filesystem/resolve-target.ts:resolveTarget` where intermediary path segments can change between `lstat` calls.
- Fix hardlink write race in `atomic-write.ts:writeInPlace` where `open(..., "w")` truncates before writing, exposing concurrent readers to temporary corruption.

**Transaction & State Correctness**
- Prevent nested retry-within-transaction failure: `src/state/snapshots.ts:182-195:finalizeTransaction` calls `withBusyRetry` inside `withTransaction`, which fails if transaction lock was lost.
- Fix global DB connection race in `database.ts:45,123-149:openStore` where concurrent calls with different paths or rapid reloads can close active connections during in-flight queries.
- Delete stale snapshot row in `src/state/recovery.ts:114-122` when file modification diverges from both before/after checksums, matching `ENOENT` branch behavior.

**Schema Evolution**
- Implement migration pipeline for `database.ts:89-98` schema version checks instead of hard-failing with `SchemaVersionError`. Use `PRAGMA user_version` or step-wise migration functions for release upgrades.

**Filesystem Edge Cases**
- Handle environments where directory fsync fails in `src/filesystem/atomic-write.ts:syncDir` (unsupported on some POSIX filesystems).
- Add TTL or cache size limit to `atomic-write.ts:prepareTempWrite:sweptDirs` to avoid unbounded memory and enable periodic temp cleanup.

### 4. Validation & Input Handling

**Strengthen Validation**
- Enforce unknown-field rejection in read/grep/write/undo tools to match edit/insert strictness.
- Add display-like content checks to write tool to prevent accidental anchor prefix pastes.
- Fast-path control character and lone surrogate checks in `src/mutation/validate.ts` to avoid per-line regex execution — iterate characters or batch string scans.

**Optimize Validation Ordering**
- Run fast structural shape checks before expensive stale anchor rendering and served range authorization in mutation tools to enable earlier short-circuit.

### 5. Memory Management

**Large File Handling**
- Implement served ledger size cap or LRU eviction to prevent unbounded session memory growth.
- Work with compact fingerprint representations (raw bytes or integer IDs) instead of 64-char hex strings.
- Use streaming comparison or hash verification instead of full-file buffer allocation in precommit verification.
- Avoid unnecessary full-document array allocations in boundary duplication detection for localized edits.

**Allocation Reduction**
- Prefer numeric sets/bitsets over string sets for anchor tracking during collision probing and preservation mapping.
- Eliminate intermediate wrapper objects (CandidateRow, temporary line arrays, redundant string conversions).
- Reuse prepared statements, TextDecoder instances, and other stateful objects across invocations.

## Critical Files

Primary targets for each improvement area:

**Performance Hot Paths**
- `src/anchors/fingerprints.ts` — Hash batching, raw fingerprint representation
- `src/anchors/hasher.ts` — Switch to h32, eliminate BigInt
- `src/anchors/allocator.ts` — Numeric anchor sets
- `src/anchors/sequence-map.ts` — Integer-ID diffing
- `src/mutation/apply.ts` — Restrict diff scope, eliminate string round-trips, numeric preservation sets
- `src/state/database.ts` — Prepared statement cache, async retries, synchronous pragma
- `src/tools/grep.ts` — Fix O(N²) lookup, batch rendering, defer reconciliation
- `src/render/budget.ts` — Single byte length computation, eliminate wrappers
- `src/render/warnings.ts` — Index-based boundary comparison
- `src/served/ledger.ts` — LRU cap, O(N+M) reconciliation
- `src/document/lines.ts` — Index-based line splitting

**Code Quality & Duplication**
- `src/tools/edit.ts`, `insert.ts`, `write.ts` — Extract shared mutation lifecycle
- `src/mutation/validate.ts` — Centralize validation for all tools
- `src/tools/undo.ts` — Unify error handling
- `src/render/diff.ts` — Pure vs side-effecting API clarity

**Robustness & Concurrency**
- `src/integration/write-hook.ts` — Add mutation queue lock
- `src/integration/freeze.ts` — Serialize async persistence
- `src/state/database.ts` — Fix connection swap race
- `src/state/snapshots.ts` — Fix nested retry-in-transaction
- `src/state/recovery.ts` — Delete stale snapshots consistently
- `src/filesystem/atomic-write.ts` — Streaming precommit, hardlink write safety, directory sync handling
- `src/filesystem/resolve-target.ts` — TOCTOU mitigation

## Verification

Each optimization category requires specific verification:

**Performance Benchmarks**
- Create benchmark suite with 1k, 10k, 50k line files measuring read/edit/grep/reconcile/undo latency and memory before/after optimizations.
- Profile anchor allocation, fingerprinting, and diff operations on large files with CPU flamegraphs.
- Measure DB query performance with prepared statement cache vs re-parsing.

**Correctness Tests**
- Existing test suite (`npm run test`) must pass unchanged after each refactor.
- Property/fuzz tests verify transactional atomicity, anchor determinism, and crash recovery remain intact.
- Concurrency tests with simultaneous mutations verify race condition fixes don't break serialization guarantees.
- Schema migration test verifies upgrade path from v1 to hypothetical v2.

**Memory Profiling**
- Heap snapshots before/after served ledger cap showing bounded growth in long sessions.
- Allocation profiles showing reduced temporary object creation in hot paths.

**Integration Verification**
- IPC protocol compatibility with Sentinel remains unchanged.
- External write hook reconciliation maintains served state correctness.
- Crash recovery scenarios (interrupted rename, partial SQLite commit) exercise journal promotion/discard logic.

## Assumptions

- Optimizations maintain exact behavioral contracts: anchor determinism, byte-level undo fidelity, served authorization semantics.
- Performance improvements target real-world agent workloads: 1k-50k line files, multi-file grep with 100+ matches, long-running sessions with many edits.
- Breaking changes to extension API or Pi integration surface require coordination with Pi coding agent maintainers.
- Schema migration strategy assumes forward-only upgrades (no downgrade support needed).
- Concurrency fixes assume Pi agent mutation queue provides file-level serialization; extension must add additional locking only where Pi guarantees are insufficient.
- Memory caps (served ledger, temp sweep cache) use conservative defaults that don't break legitimate workflows while preventing unbounded growth.
