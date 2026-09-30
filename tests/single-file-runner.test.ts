import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SingleFileRunner } from '../src/runner/single-file-runner';
import { RunnerExecutionError } from '../src/runner/types';
import {
    BASE_EXECUTION_POLICIES,
    SAVE_EXECUTION_POLICIES,
    type TaskIntent,
    type SaveIntent,
    type RenameIntent,
    type DeleteIntent,
} from '../src/operations/types';
import type { PreparedUpload } from '../src/upload/types';
import type { ActivityEvent, ActivityLogger } from '../src/types/state';
import { FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS } from '../src/utils/failed-task-payload-preview';

class MockDirtyFileMarker {
    public flightCounts = new Map<string, number>();
    public cleanedPaths: string[] = [];
    public flightOrder: string[] = [];

    beginFlight(path: string): void {
        this.flightOrder.push(`begin:${path}`);
        const current = this.flightCounts.get(path) ?? 0;
        this.flightCounts.set(path, current + 1);
    }

    endFlight(path: string): void {
        this.flightOrder.push(`end:${path}`);
        const current = this.flightCounts.get(path) ?? 0;
        if (current <= 1) {
            this.flightCounts.delete(path);
        } else {
            this.flightCounts.set(path, current - 1);
        }
    }

    async markClean(path: string): Promise<void> {
        this.cleanedPaths.push(path);
    }
}

class MockNoteStateCache {
    public storage = new Map<string, any>();

    has(path: string): boolean {
        return this.storage.has(path);
    }

    get(path: string): any {
        return this.storage.get(path);
    }

    set(path: string, state: any): void {
        this.storage.set(path, state);
    }

    delete(path: string): boolean {
        return this.storage.delete(path);
    }
}

class MockRunCoordinator {
    public runs: number = 0;
    public inFlightDuringRun: Array<{ [key: string]: number }> = [];
    public markerRef?: MockDirtyFileMarker;

    async run<T>(fn: () => Promise<T>): Promise<T> {
        this.runs++;
        if (this.markerRef) {
            const snapshot: { [key: string]: number } = {};
            for (const [k, v] of this.markerRef.flightCounts.entries()) {
                snapshot[k] = v;
            }
            this.inFlightDuringRun.push(snapshot);
        }
        return await fn();
    }
}

class MockTaskUploader {
    public uploaded: Array<{ upload: PreparedUpload; logActivity?: boolean }> = [];
    public shouldFail: boolean = false;

    async upload(upload: PreparedUpload, logActivity?: boolean): Promise<void> {
        if (this.shouldFail) {
            throw new Error('Upload transport network failure');
        }
        this.uploaded.push({ upload, logActivity });
    }
}

class MockActivityLogger implements ActivityLogger {
    public events: ActivityEvent[] = [];

    record(event: ActivityEvent): void {
        this.events.push(event);
    }
}

function createSamplePreparedUpload(op: 'save' | 'rename' | 'delete', path: string, oldPath?: string): PreparedUpload {
    if (op === 'save') {
        return {
            id: 'sample-save-id',
            operation: 'save',
            vault: 'v1',
            device: 'd1',
            path,
            targetHash: 'hash-123',
            timestamp: 1000,
            objectPayload: {
                deterministicId: 'obj-123',
                hash: 'hash-123',
                dataHash: 'hash-123',
                size: 100,
                data: 'Sample file content for save',
                type: 'snapshot',
                parentHash: null,
                diffFormat: null,
            },
        };
    } else if (op === 'rename') {
        return {
            id: 'sample-rename-id',
            operation: 'rename',
            vault: 'v1',
            device: 'd1',
            path,
            oldPath: oldPath || 'old.md',
            targetHash: 'hash-rename',
            timestamp: 2000,
            deleteTimestamp: 1999,
        };
    } else {
        return {
            id: 'sample-delete-id',
            operation: 'delete',
            vault: 'v1',
            device: 'd1',
            path,
            targetHash: 'hash-del',
            timestamp: 3000,
        };
    }
}

describe("Single File Runner", () => {
test('SingleFileRunner: automatic save claims flight before coordinator, uploads, cleans journal, and updates cache', async () => {
    const marker = new MockDirtyFileMarker();
    const coordinator = new MockRunCoordinator();
    coordinator.markerRef = marker;
    const uploader = new MockTaskUploader();
    const cache = new MockNoteStateCache();
    const logger = new MockActivityLogger();

    const sampleUpload = createSamplePreparedUpload('save', 'note.md');
    const mockPreparer = {
        prepare: async () => ({
            kind: 'ready' as const,
            upload: sampleUpload,
            content: 'Sample file content for save',
            newDiffDepth: 0,
        }),
    };

    const runner = new SingleFileRunner(mockPreparer, coordinator, uploader, marker, cache, logger);

    const intent: SaveIntent = {
        id: 'task-1',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'note.md',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        createdAt: 1000,
    };

    const result = await runner.execute(intent);

    assert.equal(result.status, 'uploaded');
    assert.equal(coordinator.runs, 1);
    // Flight was active during coordinator.run
    assert.equal(coordinator.inFlightDuringRun[0]['note.md'], 1);
    // Flight released in finally
    assert.equal(marker.flightCounts.get('note.md'), undefined);
    assert.deepEqual(marker.cleanedPaths, ['note.md']);
    // Uploader called with shouldLogActivity === true
    assert.equal(uploader.uploaded.length, 1);
    assert.equal(uploader.uploaded[0].logActivity, true);
    // Cache updated
    assert.ok(cache.has('note.md'));
    assert.equal(cache.get('note.md').hash, 'hash-123');
    assert.equal(cache.get('note.md').baseText, 'Sample file content for save');
});

test('SingleFileRunner: stores an empty uploaded note in the cache', async () => {
    const marker = new MockDirtyFileMarker();
    const coordinator = new MockRunCoordinator();
    const uploader = new MockTaskUploader();
    const cache = new MockNoteStateCache();
    const sampleUpload = createSamplePreparedUpload('save', 'Empty.md');
    const runner = new SingleFileRunner({
        prepare: async () => ({
            kind: 'ready' as const,
            upload: sampleUpload,
            content: '',
            newDiffDepth: 0,
        }),
    }, coordinator, uploader, marker, cache);

    await runner.execute({
        id: 'empty-save',
        trigger: 'manual',
        event: 'modify',
        operation: 'save',
        path: 'Empty.md',
        policy: SAVE_EXECUTION_POLICIES.MANUAL_SYNC,
    });

    assert.equal(cache.get('Empty.md').baseText, '');
});

test('SingleFileRunner: manual and batch runs do NOT claim or clear dirty journal entries', async () => {
    const marker = new MockDirtyFileMarker();
    const coordinator = new MockRunCoordinator();
    coordinator.markerRef = marker;
    const uploader = new MockTaskUploader();
    const cache = new MockNoteStateCache();
    const logger = new MockActivityLogger();

    const sampleUpload = createSamplePreparedUpload('save', 'manual.md');
    const mockPreparer = {
        prepare: async () => ({
            kind: 'ready' as const,
            upload: sampleUpload,
            content: 'Manual content',
            newDiffDepth: 0,
        }),
    };

    const runner = new SingleFileRunner(mockPreparer, coordinator, uploader, marker, cache, logger);

    // Manual run
    const manualIntent: SaveIntent = {
        id: 'task-manual',
        trigger: 'manual',
        event: 'modify',
        operation: 'save',
        path: 'manual.md',
        policy: SAVE_EXECUTION_POLICIES.MANUAL_SYNC,
        createdAt: 1000,
    };

    const manualResult = await runner.execute(manualIntent);
    assert.equal(manualResult.status, 'uploaded');
    assert.equal(marker.flightOrder.length, 0, 'Manual intent must never claim flight');
    assert.equal(marker.cleanedPaths.length, 0, 'Manual intent must never mark dirty journal clean');
    assert.equal(uploader.uploaded[0].logActivity, false, 'Activity logging must be suppressed for manual');
    assert.ok(cache.has('manual.md'), 'Manual single-file updates cache');

    // Batch run
    const batchUpload = createSamplePreparedUpload('save', 'batch.md');
    mockPreparer.prepare = async () => ({
        kind: 'ready' as const,
        upload: batchUpload,
        content: 'Batch content',
        newDiffDepth: 0,
    });

    const batchIntent: SaveIntent = {
        id: 'task-batch',
        trigger: 'manual',
        event: 'vault-backup',
        operation: 'save',
        path: 'batch.md',
        policy: SAVE_EXECUTION_POLICIES.BATCH_SNAPSHOT,
        createdAt: 2000,
    };

    const batchResult = await runner.execute(batchIntent);
    assert.equal(batchResult.status, 'uploaded');
    assert.equal(marker.flightOrder.length, 0, 'Batch intent must never claim flight');
    assert.equal(marker.cleanedPaths.length, 0, 'Batch intent must never mark dirty journal clean');
    assert.equal(uploader.uploaded[1].logActivity, false, 'Activity logging must be suppressed for batch');
    assert.equal(cache.has('batch.md'), false, 'Cache update must be bypassed for batch operations');
});

test('SingleFileRunner: batch rename and delete leave the recent-notes cache untouched', async () => {
    const marker = new MockDirtyFileMarker();
    const coordinator = new MockRunCoordinator();
    const uploader = new MockTaskUploader();
    const cache = new MockNoteStateCache();
    const oldRenameState = { path: 'OldName.md', hash: 'old-hash', baseText: 'Old text', diffDepth: 1, timestamp: 500 };
    const deletedState = { path: 'Deleted.md', hash: 'deleted-hash', baseText: 'Deleted text', diffDepth: 0, timestamp: 600 };
    cache.set('OldName.md', oldRenameState);
    cache.set('Deleted.md', deletedState);

    const renameUpload = createSamplePreparedUpload('rename', 'NewName.md', 'OldName.md');
    const deleteUpload = createSamplePreparedUpload('delete', 'Deleted.md');
    const runner = new SingleFileRunner({
        prepare: async (intent: TaskIntent) => intent.operation === 'rename'
            ? { kind: 'ready' as const, upload: renameUpload, content: 'Old text', newDiffDepth: 1 }
            : { kind: 'ready' as const, upload: deleteUpload },
    }, coordinator, uploader, marker, cache);

    await runner.execute({
        id: 'batch-rename',
        trigger: 'manual',
        event: 'vault-backup',
        operation: 'rename',
        path: 'NewName.md',
        oldPath: 'OldName.md',
        policy: BASE_EXECUTION_POLICIES.BATCH,
    });
    await runner.execute({
        id: 'batch-delete',
        trigger: 'manual',
        event: 'vault-sync',
        operation: 'delete',
        path: 'Deleted.md',
        policy: BASE_EXECUTION_POLICIES.BATCH,
    });

    assert.equal(cache.get('OldName.md'), oldRenameState);
    assert.equal(cache.has('NewName.md'), false);
    assert.equal(cache.get('Deleted.md'), deletedState);
    assert.equal(marker.flightOrder.length, 0);
    assert.equal(marker.cleanedPaths.length, 0);
    assert.deepEqual(uploader.uploaded.map(({ logActivity }) => logActivity), [false, false]);
});

test('SingleFileRunner: automatic rename claims both path and oldPath, and cleans both', async () => {
    const marker = new MockDirtyFileMarker();
    const coordinator = new MockRunCoordinator();
    coordinator.markerRef = marker;
    const uploader = new MockTaskUploader();
    const cache = new MockNoteStateCache();
    const logger = new MockActivityLogger();

    cache.set('OldName.md', { path: 'OldName.md', hash: 'old-hash', baseText: 'Old text', diffDepth: 1, timestamp: 500 });

    const sampleUpload = createSamplePreparedUpload('rename', 'NewName.md', 'OldName.md');
    const mockPreparer = {
        prepare: async () => ({
            kind: 'ready' as const,
            upload: sampleUpload,
            content: 'Renamed text',
            newDiffDepth: 1,
        }),
    };

    const runner = new SingleFileRunner(mockPreparer, coordinator, uploader, marker, cache, logger);

    const intent: RenameIntent = {
        id: 'task-rename',
        trigger: 'auto',
        event: 'rename',
        operation: 'rename',
        path: 'NewName.md',
        oldPath: 'OldName.md',
        policy: BASE_EXECUTION_POLICIES.AUTO,
        createdAt: 1000,
    };

    const result = await runner.execute(intent);

    assert.equal(result.status, 'uploaded');
    // Both paths were claimed in flight
    assert.equal(coordinator.inFlightDuringRun[0]['NewName.md'], 1);
    assert.equal(coordinator.inFlightDuringRun[0]['OldName.md'], 1);
    // Both paths released
    assert.equal(marker.flightCounts.get('NewName.md'), undefined);
    assert.equal(marker.flightCounts.get('OldName.md'), undefined);
    // Both paths cleaned from dirty journal
    assert.ok(marker.cleanedPaths.includes('NewName.md'));
    assert.ok(marker.cleanedPaths.includes('OldName.md'));
    // Cache updated: oldPath deleted, newPath added
    assert.equal(cache.has('OldName.md'), false);
    assert.ok(cache.has('NewName.md'));
    assert.equal(cache.get('NewName.md').baseText, 'Renamed text');
});

test('SingleFileRunner: delete operation cleans dirty journal and removes path from cache', async () => {
    const marker = new MockDirtyFileMarker();
    const coordinator = new MockRunCoordinator();
    const uploader = new MockTaskUploader();
    const cache = new MockNoteStateCache();
    const logger = new MockActivityLogger();

    cache.set('Deleted.md', { path: 'Deleted.md', hash: 'del-hash', baseText: 'del', diffDepth: 0, timestamp: 500 });

    const sampleUpload = createSamplePreparedUpload('delete', 'Deleted.md');
    const mockPreparer = {
        prepare: async () => ({
            kind: 'ready' as const,
            upload: sampleUpload,
        }),
    };

    const runner = new SingleFileRunner(mockPreparer, coordinator, uploader, marker, cache, logger);

    const intent: DeleteIntent = {
        id: 'task-del',
        trigger: 'auto',
        event: 'delete',
        operation: 'delete',
        path: 'Deleted.md',
        policy: BASE_EXECUTION_POLICIES.AUTO,
        createdAt: 1000,
    };

    const result = await runner.execute(intent);

    assert.equal(result.status, 'uploaded');
    assert.deepEqual(marker.cleanedPaths, ['Deleted.md']);
    assert.equal(cache.has('Deleted.md'), false);
});

test('SingleFileRunner: unchanged note cleans journal and records completion to activity logger', async () => {
    const marker = new MockDirtyFileMarker();
    const coordinator = new MockRunCoordinator();
    const uploader = new MockTaskUploader();
    const cache = new MockNoteStateCache();
    const logger = new MockActivityLogger();

    const mockPreparer = {
        prepare: async () => ({
            kind: 'unchanged' as const,
            path: 'Unchanged.md',
        }),
    };

    const runner = new SingleFileRunner(mockPreparer, coordinator, uploader, marker, cache, logger);

    const intent: SaveIntent = {
        id: 'task-unchanged',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'Unchanged.md',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        createdAt: 1000,
    };

    const result = await runner.execute(intent);

    assert.equal(result.status, 'unchanged');
    assert.deepEqual(marker.cleanedPaths, ['Unchanged.md']);
    assert.equal(uploader.uploaded.length, 0, 'No upload should be triggered');
    assert.equal(logger.events.length, 1);
    assert.equal(logger.events[0].taskId, 'task-unchanged');
    assert.equal(logger.events[0].status, 'completed');
    assert.equal(logger.events[0].note, 'Unchanged');
});

test('SingleFileRunner: skipped note cleans journal and emits terminal completion to activity tracker', async () => {
    const marker = new MockDirtyFileMarker();
    const coordinator = new MockRunCoordinator();
    const uploader = new MockTaskUploader();
    const cache = new MockNoteStateCache();
    const logger = new MockActivityLogger();

    const mockPreparer = {
        prepare: async () => ({
            kind: 'skipped' as const,
            path: 'BigFile.md',
            reason: 'size_limit_exceeded' as const,
        }),
    };

    const runner = new SingleFileRunner(mockPreparer, coordinator, uploader, marker, cache, logger);

    const intent: SaveIntent = {
        id: 'task-oversize',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'BigFile.md',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        createdAt: 1000,
    };

    const result = await runner.execute(intent);

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'size_limit_exceeded');
    assert.deepEqual(marker.cleanedPaths, ['BigFile.md']);
    assert.equal(uploader.uploaded.length, 0);
    assert.equal(logger.events.length, 1);
    assert.equal(logger.events[0].note, 'ignored: file size');
    assert.equal(logger.events[0].status, 'completed');
});

test('SingleFileRunner: wraps preparation failure in RunnerExecutionError and guarantees endFlight', async () => {
    const marker = new MockDirtyFileMarker();
    const coordinator = new MockRunCoordinator();
    const uploader = new MockTaskUploader();
    const cache = new MockNoteStateCache();

    const mockPreparer = {
        prepare: async () => {
            throw new Error('Corrupt metadata in DB');
        },
    };

    const runner = new SingleFileRunner(mockPreparer, coordinator, uploader, marker, cache);

    const intent: SaveIntent = {
        id: 'task-prep-fail',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'Fail.md',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        createdAt: 1000,
    };

    await assert.rejects(
        async () => await runner.execute(intent),
        (err: any) => {
            assert.ok(err instanceof RunnerExecutionError);
            assert.equal(err.phase, 'preparation');
            assert.match(err.message, /Preparation failed: Corrupt metadata in DB/);
            return true;
        }
    );

    // Flight released despite throw
    assert.equal(marker.flightCounts.get('Fail.md'), undefined);
    assert.equal(marker.cleanedPaths.length, 0, 'Failed task must NOT clean dirty journal');
});

test('SingleFileRunner: wraps upload failure in RunnerExecutionError with bounded payload preview and guarantees endFlight', async () => {
    const marker = new MockDirtyFileMarker();
    const coordinator = new MockRunCoordinator();
    const uploader = new MockTaskUploader();
    uploader.shouldFail = true;
    const cache = new MockNoteStateCache();

    const hugeContent = 'A'.repeat(5000);
    const sampleUpload: PreparedUpload = {
        id: 'task-upload-fail',
        operation: 'save',
        vault: 'v1',
        device: 'd1',
        path: 'UploadFail.md',
        targetHash: 'hash-fail',
        timestamp: 1000,
        objectPayload: {
            deterministicId: 'obj-fail',
            hash: 'hash-fail',
            dataHash: 'hash-fail',
            size: 5000,
            data: hugeContent,
            type: 'snapshot',
            parentHash: null,
            diffFormat: null,
        },
    };

    const mockPreparer = {
        prepare: async () => ({
            kind: 'ready' as const,
            upload: sampleUpload,
            content: hugeContent,
        }),
    };

    const runner = new SingleFileRunner(mockPreparer, coordinator, uploader, marker, cache);

    const intent: SaveIntent = {
        id: 'task-up-fail',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'UploadFail.md',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        createdAt: 1000,
    };

    await assert.rejects(
        async () => await runner.execute(intent),
        (err: any) => {
            assert.ok(err instanceof RunnerExecutionError);
            assert.equal(err.phase, 'upload');
            assert.equal(err.noteSizeBytes, 5000);
            assert.ok(err.payloadPreview);
            assert.equal(err.payloadPreview?.length, FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS, `Payload preview must be bounded to ${FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS} chars`);
            assert.equal(err.preparedUpload, sampleUpload);
            return true;
        }
    );

    // Flight released despite throw
    assert.equal(marker.flightCounts.get('UploadFail.md'), undefined);
    assert.equal(marker.cleanedPaths.length, 0, 'Failed task must NOT clean dirty journal');
    assert.equal(cache.has('UploadFail.md'), false, 'Cache must NOT be updated on upload failure');
});
});
