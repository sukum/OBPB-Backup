import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotPolicy } from '../src/policies/snapshot-policy';
import { RestoreSafetyPolicy } from '../src/policies/restore-safety-policy';
import { FileFilterPolicy } from '../src/policies/file-filter-policy';
import { RetentionPolicy } from '../src/policies/retention-policy';
import { DEFAULT_SETTINGS, PBBackupSettings } from '../src/types/settings';
import { ActivityRecord } from '../src/types/state';
import {
    BASE_EXECUTION_POLICIES,
    SAVE_EXECUTION_POLICIES,
    type TaskIntent,
} from '../src/operations/types';
import type { CachedNoteState } from '../src/types/state';
import type { EntriesWithObjectsViewRecord } from '../src/types/database';


test('SnapshotPolicy evaluates 16 KB floor and 50 diff limit correctly', () => {
    const defaultSettings: PBBackupSettings = {
        ...DEFAULT_SETTINGS,
        serverUrl: '',
        userEmail: '',
        vaultId: 'v1',
        debounceIntervalMs: 30000,
        maxWaitMs: 300000,
        maxDiffsBetweenSnapshots: 50,
        monitoredExtensions: ['md', 'canvas'],
        maxFileSizeMb: 5,
        safetyBackupBeforeRestore: true,
    };

    // 1. Initial version (no diffDepth): always snapshot
    assert.equal(SnapshotPolicy.isSnapshotRequired(1000, undefined, defaultSettings), true);

    // 2. Diff depth under bound: diffDepth = 4 < 50 -> false (keep using diffs)
    assert.equal(SnapshotPolicy.isSnapshotRequired(2100, 4, defaultSettings), false);

    // 3. Version bound cap: diffDepth >= 50 -> true (create snapshot)
    assert.equal(SnapshotPolicy.isSnapshotRequired(102000, 50, defaultSettings), true);

    // 4. Missing parent hash: always snapshot
    assert.equal(SnapshotPolicy.isSnapshotRequired(2100, 4, defaultSettings, false), true);

    // 5. Large file bounds
    assert.equal(SnapshotPolicy.shouldSkipFile(11 * 1024 * 1024), true); // > 10MB
    assert.equal(SnapshotPolicy.isSnapshotOnly(6 * 1024 * 1024, defaultSettings), true); // 5-10MB
});


test('RestoreSafetyPolicy resolves override and setting precedence', () => {
    const enabled: PBBackupSettings = { ...DEFAULT_SETTINGS, safetyBackupBeforeRestore: true };
    const disabled: PBBackupSettings = { ...DEFAULT_SETTINGS, safetyBackupBeforeRestore: false };

    // Falls back to the persisted setting when no override is given
    assert.equal(RestoreSafetyPolicy.shouldTakeSafetyBackup(enabled), true);
    assert.equal(RestoreSafetyPolicy.shouldTakeSafetyBackup(disabled), false);

    // Explicit per-call override wins over the persisted setting
    assert.equal(RestoreSafetyPolicy.shouldTakeSafetyBackup(disabled, true), true);
    assert.equal(RestoreSafetyPolicy.shouldTakeSafetyBackup(enabled, false), false);
});


test('FileFilterPolicy and RetentionPolicy evaluate rules accurately', () => {
    // 1. FileFilterPolicy tests
    assert.equal(FileFilterPolicy.isIgnored('.obsidian/workspace.json'), true);
    assert.equal(FileFilterPolicy.isIgnored('.git/config'), true);
    assert.equal(FileFilterPolicy.isIgnored('.trash/OldNote.md'), true);
    assert.equal(FileFilterPolicy.isIgnored('Subfolder/.hidden/file.md'), true);
    assert.equal(FileFilterPolicy.isIgnored('Notes/Daily/2026-09-09.md'), false);

    assert.equal(FileFilterPolicy.isMonitored('Notes/Note.md', ['md', 'canvas']), true);
    assert.equal(FileFilterPolicy.isMonitored('Canvas/Design.CANVAS', ['.md', '.canvas']), true);
    assert.equal(FileFilterPolicy.isMonitored('Image.png', ['md']), false);
    assert.equal(FileFilterPolicy.isMonitored('.obsidian/app.json', ['json', 'md']), false);

    // 2. RetentionPolicy tests
    const records = [
        { id: '1', timestamp: 100, status: 'completed' },
        { id: '2', timestamp: 200, status: 'ongoing' },
        { id: '3', timestamp: 300, status: 'completed' },
        { id: '4', timestamp: 400, status: 'cancelled' },
        { id: '5', timestamp: 500, status: 'ongoing' },
    ] as ActivityRecord[];

    // Trimming to limit 3 should preserve both 'ongoing' (2, 5) and the newest completed (4)
    const trimmedActivity = RetentionPolicy.trimActivityRecords(records , 3);
    assert.equal(trimmedActivity.length, 3);
    assert.ok(trimmedActivity.find((r) => r.id === '2'));
    assert.ok(trimmedActivity.find((r) => r.id === '5'));
    assert.ok(trimmedActivity.find((r) => r.id === '4'));
    assert.equal(trimmedActivity.find((r) => r.id === '1'), undefined);

});



test('ErrorClassificationPolicy separates outages from task-specific failures', async () => {
    const { ErrorClassificationPolicy } = await import('../src/policies/error-classification-policy');
    const { PocketBaseError } = await import('../src/remote/pocketbase-client');

    assert.equal(ErrorClassificationPolicy.classify(new Error('connection refused')), 'connectivity');
    assert.equal(ErrorClassificationPolicy.classify(new PocketBaseError(503, 'Unavailable')), 'connectivity');
    assert.equal(ErrorClassificationPolicy.classify(new PocketBaseError(401, 'Unauthorized')), 'authentication');
    assert.equal(ErrorClassificationPolicy.classify(new PocketBaseError(400, 'Bad request')), 'validation');
    assert.equal(ErrorClassificationPolicy.classify(new PocketBaseError(429, 'Slow down')), 'rate_limited');
    assert.equal(ErrorClassificationPolicy.classify(new PocketBaseError(404, 'Missing')), 'terminal_request');
});

test('ErrorClassificationPolicy diagnoses likelyReason from structured errors', async () => {
    const { ErrorClassificationPolicy } = await import('../src/policies/error-classification-policy');
    const { PocketBaseError } = await import('../src/remote/pocketbase-client');

    // PocketBase field-level oversize validation code → size_limit
    assert.equal(
        ErrorClassificationPolicy.diagnose(new PocketBaseError(400, 'Failed to create record.', {
            data: { data: { code: 'validation_max_length', message: 'Exceeds max length.' } },
        })),
        'size_limit'
    );
    // Oversize hint echoed in response text → size_limit
    assert.equal(
        ErrorClassificationPolicy.diagnose(new PocketBaseError(400, 'Failed: validation_max_length')),
        'size_limit'
    );
    // Plain 400/422 validation failures → validation_error
    assert.equal(ErrorClassificationPolicy.diagnose(new PocketBaseError(400, 'Invalid schema')), 'validation_error');
    assert.equal(ErrorClassificationPolicy.diagnose(new PocketBaseError(422, 'Unprocessable')), 'validation_error');
    // Server/timeout statuses → network_outage
    assert.equal(ErrorClassificationPolicy.diagnose(new PocketBaseError(503, 'Unavailable')), 'network_outage');
    assert.equal(ErrorClassificationPolicy.diagnose(new PocketBaseError(408, 'Timeout')), 'network_outage');
    // Statusless failures fall back to message hints
    assert.equal(ErrorClassificationPolicy.diagnose(new Error('Network request failed')), 'network_outage');
    assert.equal(ErrorClassificationPolicy.diagnose(new Error('request timeout')), 'network_outage');
    assert.equal(ErrorClassificationPolicy.diagnose(new Error('connection refused')), 'other');
});

test('SkipUnchangedPolicy evaluates skip conditions purely based on intent', async () => {
    const { SkipUnchangedPolicy } = await import('../src/policies/skip-unchanged-policy');

    // 1. Manual snapshot: never skip unchanged
    assert.equal(
        SkipUnchangedPolicy.shouldSkipIfUnchanged({
            id: 't-1',
            trigger: 'manual',
            event: 'modify',
            operation: 'save',
            path: 'Note.md',
            mode: 'snapshot',
            policy: SAVE_EXECUTION_POLICIES.MANUAL_SNAPSHOT,
        }),
        false
    );

    // 2. Manual auto/diff ("Sync Note Now"): skips unchanged
    assert.equal(
        SkipUnchangedPolicy.shouldSkipIfUnchanged({
            id: 't-2',
            trigger: 'manual',
            event: 'modify',
            operation: 'save',
            path: 'Note.md',
            mode: 'auto',
            policy: SAVE_EXECUTION_POLICIES.MANUAL_SYNC,
        }),
        true
    );
    assert.equal(
        SkipUnchangedPolicy.shouldSkipIfUnchanged({
            id: 't-3',
            trigger: 'manual',
            event: 'modify',
            operation: 'save',
            path: 'Note.md',
            mode: 'diff',
            policy: SAVE_EXECUTION_POLICIES.MANUAL_SYNC,
        }),
        true
    );

    // 3. Vault backup: blind snapshot, never skip
    assert.equal(
        SkipUnchangedPolicy.shouldSkipIfUnchanged({
            id: 't-4',
            trigger: 'manual',
            event: 'vault-backup',
            operation: 'save',
            path: 'Note.md',
            policy: SAVE_EXECUTION_POLICIES.BATCH_SNAPSHOT,
        }),
        false
    );

    // 4. Vault sync: skips unchanged
    assert.equal(
        SkipUnchangedPolicy.shouldSkipIfUnchanged({
            id: 't-5',
            trigger: 'manual',
            event: 'vault-sync',
            operation: 'save',
            path: 'Note.md',
            policy: SAVE_EXECUTION_POLICIES.BATCH_SYNC,
        }),
        true
    );

    // 5. Automatic debounced modify: skips unchanged
    assert.equal(
        SkipUnchangedPolicy.shouldSkipIfUnchanged({
            id: 't-6',
            trigger: 'auto',
            event: 'modify',
            operation: 'save',
            path: 'Note.md',
            policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        }),
        true
    );

    // 6. Recovery: skips unchanged
    assert.equal(
        SkipUnchangedPolicy.shouldSkipIfUnchanged({
            id: 't-7',
            trigger: 'auto',
            event: 'recovery',
            operation: 'save',
            path: 'Note.md',
            policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        }),
        true
    );

    // 7. Renames and deletes represent topology changes, never skip
    assert.equal(
        SkipUnchangedPolicy.shouldSkipIfUnchanged({
            id: 't-8',
            trigger: 'auto',
            event: 'rename',
            operation: 'rename',
            path: 'New.md',
            oldPath: 'Old.md',
            policy: BASE_EXECUTION_POLICIES.AUTO,
        }),
        false
    );
    assert.equal(
        SkipUnchangedPolicy.shouldSkipIfUnchanged({
            id: 't-9',
            trigger: 'auto',
            event: 'delete',
            operation: 'delete',
            path: 'Note.md',
            policy: BASE_EXECUTION_POLICIES.AUTO,
        }),
        false
    );
});

test('BaseResolutionPolicy evaluates remote and cache entries accurately', async () => {
    const { BaseResolutionPolicy } = await import('../src/policies/base-resolution-policy');

    const cached: CachedNoteState = {
        path: 'Note.md',
        hash: 'sha256:same',
        baseText: 'hello cached',
        diffDepth: 3,
        timestamp: 1000,
    };

    // 1. Cache hit and unchanged -> skip_unchanged
    assert.deepEqual(
        BaseResolutionPolicy.evaluate('sha256:same', true, cached),
        { action: 'skip_unchanged', parentHash: 'sha256:same', prevTimestamp: 1000 }
    );

    // 2. Cache hit with skipIfUnchanged = false -> use_cached_base
    assert.deepEqual(
        BaseResolutionPolicy.evaluate('sha256:same', false, cached),
        { action: 'use_cached_base', baseText: 'hello cached', parentHash: 'sha256:same', diffDepth: 3, prevTimestamp: 1000 }
    );

    // 3. Cache hit with changed hash -> use_cached_base
    assert.deepEqual(
        BaseResolutionPolicy.evaluate('sha256:different', true, cached),
        { action: 'use_cached_base', baseText: 'hello cached', parentHash: 'sha256:same', diffDepth: 3, prevTimestamp: 1000 }
    );

    // 4. Remote entry with delete operation -> initial_snapshot
    const deleteEntry: any = {
        id: 'e1',
        vault: 'v1',
        path: 'Note.md',
        oldPath: null,
        operation: 'delete',
        device: 'd1',
        timestamp: 2000,
        hash: 'sha256:del',
        parentHash: null,
        type: 'snapshot',
        data: '',
        dataHash: '',
        diffFormat: null,
        size: 0,
    };
    assert.deepEqual(
        BaseResolutionPolicy.evaluate('sha256:any', true, undefined, [deleteEntry]),
        { action: 'initial_snapshot', parentHash: null, prevTimestamp: 2000 }
    );

    // 5. Remote entry unchanged -> skip_unchanged
    const snapshotEntry: any = {
        id: 'e2',
        vault: 'v1',
        path: 'Note.md',
        oldPath: null,
        operation: 'save',
        device: 'd1',
        timestamp: 2500,
        hash: 'sha256:remote-same',
        parentHash: null,
        type: 'snapshot',
        data: 'content',
        dataHash: 'h',
        diffFormat: null,
        size: 7,
    };
    assert.deepEqual(
        BaseResolutionPolicy.evaluate('sha256:remote-same', true, undefined, [snapshotEntry]),
        { action: 'skip_unchanged', parentHash: 'sha256:remote-same', prevTimestamp: 2500 }
    );

    // 6. Remote entries with diffs -> reconstruct_remote_base with diffDepth
    const diffEntry1: any = {
        ...snapshotEntry,
        id: 'e3',
        timestamp: 3000,
        hash: 'sha256:d1',
        parentHash: snapshotEntry.hash,
        type: 'diff',
    };
    const diffEntry2: any = {
        ...snapshotEntry,
        id: 'e4',
        timestamp: 3500,
        hash: 'sha256:d2',
        parentHash: diffEntry1.hash,
        type: 'diff',
    };
    // Chain: diffEntry2 (depth 2) -> diffEntry1 (depth 1) -> snapshotEntry (depth 0)
    assert.deepEqual(
        BaseResolutionPolicy.evaluate('sha256:new', true, undefined, [diffEntry2, diffEntry1, snapshotEntry]),
        { action: 'reconstruct_remote_base', parentHash: 'sha256:d2', diffDepth: 2, prevTimestamp: 3500 }
    );

    // 7. Remote entries broken chain (no snapshot ancestor found) -> snapshot_fallback
    assert.deepEqual(
        BaseResolutionPolicy.evaluate('sha256:new', true, undefined, [diffEntry2, diffEntry1]),
        { action: 'snapshot_fallback', parentHash: 'sha256:d2', prevTimestamp: 3500, reason: 'broken_chain' }
    );

    // 8. A snapshot elsewhere in the response is not enough: the latest diff
    // must reach it through parentHash links.
    const disconnectedDiff: any = {
        ...diffEntry2,
        id: 'e5',
        hash: 'sha256:disconnected',
        parentHash: 'sha256:missing-parent',
        timestamp: 3600,
    };
    assert.deepEqual(
        BaseResolutionPolicy.evaluate('sha256:new', true, undefined, [disconnectedDiff, snapshotEntry]),
        { action: 'snapshot_fallback', parentHash: 'sha256:disconnected', prevTimestamp: 3600, reason: 'broken_chain' }
    );

    // 9. No cache and empty remote entries -> initial_snapshot
    assert.deepEqual(
        BaseResolutionPolicy.evaluate('sha256:new', true, undefined, []),
        { action: 'initial_snapshot', parentHash: null }
    );
    assert.deepEqual(
        BaseResolutionPolicy.evaluate('sha256:new', true, undefined, undefined),
        { action: 'initial_snapshot', parentHash: null }
    );
});
