# 0.2.0 Breaking Migration

The redesign intentionally removes the 0.1 internal core, generic preflight cache, string-derived diagnostics, and coupled runner APIs. Callers must move to the 0.2 command and programmatic workflow surface; there is no fallback or dual execution path.

Config, issue output, generated manifests, and command names are versioned as new contracts. Migration documentation must record each shipped change as old behavior, defect, new behavior, rationale, and the required user edit. It must be generated from the final implementation, not from intermediate design examples.

Generated files are reconciled through an artifact plan. A check or export invocation never updates generated state as a side effect.

## Tsconfig Migration Transaction

`limina migration` requires a clean Git worktree and separates planning from physical writes. Planning keeps one append-only virtual-file snapshot: each config is read once, then parsing, solution-style detection, reference expansion, transformation, and serialization use that captured content. The complete write plan records the original bytes and serialized next content for every modified or skipped config before transaction preflight begins. A late read, reference, transform, or serialization failure therefore leaves every target untouched.

Checker entry discovery during migration uses the same region-scoped selector as graph preparation. References are expanded in this order: resolve the path, ignore missing targets, ignore non-source configs, require an activated region, and only then apply queue and seen handling. Checker `exclude` filters entries only and does not filter references.

When every planned item is skipped, migration returns without filesystem identity checks, transaction directories, replacement, rollback, or cleanup. Physical write constraints apply only to modified items.

### Preflight and Preparation

Modified targets must be writable regular files with one hard link. The logical path below the workspace root may not contain a symlink or junction, and the target's canonical path must remain physically inside the canonical workspace root. The preflight identity combines canonical realpath with device and inode so multiple logical paths cannot select the same physical target; a single accessible case alias remains valid on a case-insensitive filesystem.

Before creating transaction directories, migration captures bytes, SHA-256, file type, link count, full mode, permission bits, uid/gid where supported, and timestamps. It also opens each target with `r+`, so same-directory rename support cannot bypass a read-only target.

Each target parent receives a private same-directory transaction directory created with `mkdtemp()`. On POSIX its mode is verified as `0700`. Next and immutable backup files are created exclusively with initial mode `0600`, then receive the original uid/gid and permission bits. Backups also receive the original timestamp normalized to Node's millisecond/`Date` granularity. Prepared files are synced and closed before the first replacement.

### Replacement and Retry

Commit and rollback share a low-level `replaceFileWithRetry()` primitive. Each invocation has its own bounded attempt budget. Every attempt performs a complete source and target validation before one rename. Retryable validation I/O and retryable rename failures (`EACCES`, `EBUSY`, and `EPERM`) consume the same invocation budget; content, identity, metadata, or canonical-path drift is terminal and is never retried. Replacement never falls back to unlinking the target.

Commit replaces each target with its prepared next file in one rename. The transaction is committed when the final target replacement succeeds.

### Rollback and Cleanup

If replacement fails before the commit point, already replaced targets are rolled back in reverse order. The immutable backup is validated but never consumed as the rename source. Migration creates a separate rollback temp from the captured original bytes and supported metadata, validates the target, rollback temp, and immutable backup before every replacement attempt, then post-verifies the restored target with an independent bounded read-only retry. The immutable backup is removed only after post-verification succeeds.

If rollback validation or post-verification detects external drift, migration does not overwrite the external content. It retains that item's immutable backup and recovery artifacts, continues rolling back unrelated items, and reports the primary, rollback, and cleanup failures separately.

Preparation and pre-commit failure cleanup closes handles, removes partial and unused artifacts, and removes every empty transaction directory while continuing after individual cleanup failures. Recovery artifacts are retained only for items that could not be rolled back safely. Cleanup failures after the commit point do not roll back committed content; they are reported as logger and flow warnings with the retained path.

### Preservation Contract and Limits

Rollback restores original bytes, permission mode, uid/gid where supported, and mtime at Node's millisecond/`Date` granularity. A successfully migrated file may receive a new mtime. Replacement does not promise the original inode, ctime, birth time, ACLs, extended attributes, or complete sub-millisecond timestamp precision.

This transaction is rollback-safe for handled planning, preparation, validation, and replacement failures. It has no durable journal or recovery protocol, so it is not crash-, `SIGKILL`-, or power-loss-atomic across multiple files. Per-attempt validation also cannot eliminate the small TOCTOU window between the final validation operation and `rename()`.
