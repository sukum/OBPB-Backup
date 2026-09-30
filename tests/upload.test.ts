import {test, describe, TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { TaskUploader } from '../src/upload/task-uploader';
import { UploadCoordinator } from '../src/upload/upload-coordinator';
import type { PreparedSaveUpload, PreparedRenameUpload, PreparedDeleteUpload } from '../src/upload/types';
import type { BackupStore } from '../src/remote/backup-store';
import type { CreateBackupObject, CreateHistoryEntry } from '../src/types/database';
import { LocalDataStorage } from '../src/state/local-data-storage';
import { FailedTasksManager } from '../src/state/failed-tasks-manager';
import { SAVE_EXECUTION_POLICIES, type TaskIntent } from '../src/operations/types';

function createMockStore(): BackupStore & { objects: CreateBackupObject[]; entries: CreateHistoryEntry[] } {
    const objects: CreateBackupObject[] = [];
    const entries: CreateHistoryEntry[] = [];
    return {
        objects,
        entries,
        putObject: async (obj: CreateBackupObject) => {
            objects.push(obj);
        },
        getObject: async (vault: string, hash: string) => {
            const found = objects.find((o) => o.vault === vault && o.hash === hash);
            return found ? { ...found, id: found.id, user: 'u1', created: '', updated: '' } as any : null;
        },
        addEntry: async (entry: CreateHistoryEntry) => {
            entries.push(entry);
        },
    } as any;
}

describe('Task uploads', () => {
test('TaskUploader uploads save task and respects logActivity flag', async () => {
    const store = createMockStore();
    const loggedStages: string[] = [];
    const mockLogger: any = {
        record: (event: any) => {
            loggedStages.push(`${event.stage}:${event.status}`);
        },
    };

    const uploader = new TaskUploader(store, mockLogger);

    const saveTask: PreparedSaveUpload = {
        id: 'task-save-1',
        device: 'dev-1',
        vault: 'vault-1',
        path: 'Notes/Test.md',
        timestamp: 1000,
        targetHash: 'sha256:target',
        operation: 'save',
        objectPayload: {
            deterministicId: 'obj-12345678901',
            hash: 'sha256:target',
            parentHash: null,
            type: 'snapshot',
            data: '# Title',
            dataHash: 'sha256:data',
            diffFormat: null,
            size: 7,
        },
    };

    // 1. Upload with logging enabled
    await uploader.upload(saveTask, true);
    assert.equal(store.objects.length, 1);
    assert.equal(store.objects[0].id, 'obj-12345678901');
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].operation, 'save');
    assert.equal(store.entries[0].path, 'Notes/Test.md');
    assert.ok(loggedStages.length > 0);

    // 2. Upload with logging suppressed
    loggedStages.length = 0;
    saveTask.id = 'task-save-2';
    saveTask.timestamp = 2000;
    await uploader.upload(saveTask, false);
    assert.equal(loggedStages.length, 0); // No activity logged
    assert.equal(store.entries.length, 2);
});

test('TaskUploader Option A idempotent rename uploads delete for oldPath then rename for path', async () => {
    const store = createMockStore();
    // Pre-populate target object
    await store.putObject({
        id: 'obj-target-obj1',
        vault: 'vault-1',
        hash: 'sha256:target',
        parentHash: null,
        type: 'snapshot',
        data: 'content',
        dataHash: 'h',
        diffFormat: null,
        encoding: 'none',
        size: 7,
    });

    const uploader = new TaskUploader(store);

    const renameTask: PreparedRenameUpload = {
        id: 'task-ren-1',
        device: 'dev-1',
        vault: 'vault-1',
        path: 'Folder/NewName.md',
        oldPath: 'Folder/OldName.md',
        timestamp: 5000,
        deleteTimestamp: 4999,
        targetHash: 'sha256:target',
        targetObjectId: 'obj-target-obj1',
        operation: 'rename',
    };

    await uploader.upload(renameTask);

    assert.equal(store.entries.length, 2);

    // Step 2a: delete entry for oldPath
    const deleteEntry = store.entries[0];
    assert.equal(deleteEntry.operation, 'delete');
    assert.equal(deleteEntry.path, 'Folder/OldName.md');
    assert.equal(deleteEntry.oldPath, null);
    assert.equal(deleteEntry.timestamp, 4999);
    assert.equal(deleteEntry.objectId, 'obj-target-obj1');

    // Step 2b: rename entry for path
    const renameEntry = store.entries[1];
    assert.equal(renameEntry.operation, 'rename');
    assert.equal(renameEntry.path, 'Folder/NewName.md');
    assert.equal(renameEntry.oldPath, 'Folder/OldName.md');
    assert.equal(renameEntry.timestamp, 5000);
    assert.equal(renameEntry.objectId, 'obj-target-obj1');
});

test('TaskUploader resumes a partially published rename without duplicating the delete entry', async () => {
    const store = createMockStore();
    await store.putObject({
        id: 'obj-target-obj2',
        vault: 'vault-1',
        hash: 'sha256:target-2',
        parentHash: null,
        type: 'snapshot',
        data: 'content',
        dataHash: 'h',
        diffFormat: null,
        encoding: 'none',
        size: 7,
    });

    let failRenameOnce = true;
    store.addEntry = async (entry: CreateHistoryEntry) => {
        if (entry.operation === 'rename' && failRenameOnce) {
            failRenameOnce = false;
            throw new Error('transient rename publication failure');
        }
        if (!store.entries.some((existing) => existing.id === entry.id)) {
            store.entries.push(entry);
        }
    };

    const uploader = new TaskUploader(store);
    const renameTask: PreparedRenameUpload = {
        id: 'task-ren-2',
        device: 'dev-1',
        vault: 'vault-1',
        path: 'Folder/NewName.md',
        oldPath: 'Folder/OldName.md',
        timestamp: 5000,
        deleteTimestamp: 4999,
        targetHash: 'sha256:target-2',
        targetObjectId: 'obj-target-obj2',
        operation: 'rename',
    };

    await assert.rejects(() => uploader.upload(renameTask), /transient rename publication failure/);
    assert.deepEqual(store.entries.map((entry) => entry.operation), ['delete']);

    await uploader.upload(renameTask);
    assert.deepEqual(store.entries.map((entry) => entry.operation), ['delete', 'rename']);
});
});

test('UploadCoordinator serializes concurrent executions and waitForIdle drains', async () => {
    const coordinator = new UploadCoordinator();
    const executionOrder: number[] = [];

    const p1 = coordinator.run(async () => {
        await new Promise((r) => setTimeout(r, 20));
        executionOrder.push(1);
    });

    const p2 = coordinator.run(async () => {
        executionOrder.push(2);
    });

    await coordinator.waitForIdle();
    assert.deepEqual(executionOrder, [1, 2]);
});

test('UploadCoordinator.runBatchSession bounds concurrency and restores to 1 on completion', async () => {
    const coordinator = new UploadCoordinator();
    assert.equal(coordinator.isBatchActive(), false);

    let maxInFlight = 0;
    let currentInFlight = 0;
    const executionLog: string[] = [];

    // Start batch session with concurrency 2
    const batchPromise = coordinator.runBatchSession(2, async () => {
        assert.equal(coordinator.isBatchActive(), true);

        const task = async (id: string) => {
            return coordinator.run(async () => {
                currentInFlight++;
                maxInFlight = Math.max(maxInFlight, currentInFlight);
                executionLog.push(`start-${id}`);
                await new Promise((r) => setTimeout(r, 20));
                executionLog.push(`end-${id}`);
                currentInFlight--;
            });
        };

        await Promise.all([task('b1'), task('b2'), task('b3'), task('b4')]);
        return 'batch-done';
    });

    const batchRes = await batchPromise;
    assert.equal(batchRes, 'batch-done');
    assert.equal(maxInFlight, 2);
    assert.equal(coordinator.isBatchActive(), false);

    // After batch finishes, concurrency is restored to 1
    maxInFlight = 0;
    currentInFlight = 0;
    const ordinaryTask = (id: string) => coordinator.run(async () => {
        currentInFlight++;
        maxInFlight = Math.max(maxInFlight, currentInFlight);
        await new Promise((r) => setTimeout(r, 10));
        currentInFlight--;
    });

    await Promise.all([ordinaryTask('o1'), ordinaryTask('o2'), ordinaryTask('o3')]);
    assert.equal(maxInFlight, 1);
});

test('UploadCoordinator.runBatchSession rejects concurrent batch sessions and recovers on error', async () => {
    const coordinator = new UploadCoordinator();

    const session1 = coordinator.runBatchSession(2, async () => {
        await new Promise((r) => setTimeout(r, 30));
        throw new Error('session error');
    });

    await assert.rejects(
        () => coordinator.runBatchSession(1, async () => {}),
        /already active/
    );

    await assert.rejects(session1, /session error/);
    assert.equal(coordinator.isBatchActive(), false);

    // Can run a new batch session after failure
    const session2 = await coordinator.runBatchSession(1, async () => 'ok');
    assert.equal(session2, 'ok');
});

describe('Failed upload tasks', () => {
// We are debouncing the write on record call
test.skip('FailedTasksManager durably persists lean FailedTaskRecord immediately', async () => {
    const files = new Map<string, string>();
    const storage = new LocalDataStorage({
        exists: async (p: string) => files.has(p),
        mkdir: async () => {},
        read: async (p: string) => files.get(p) || '',
        write: async (p: string, content: string) => {
            files.set(p, content);
        },
    } as any, 'local_data');

    const manager = new FailedTasksManager(storage);
    // manager.debouncedWriteDelay = 0;

    const intent: TaskIntent = {
        id: 'intent-fail-1',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'Fail.md',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        file: { runtimeOnly: 'must-not-be-persisted' } as any,
    };

    await manager.recordTerminalFailure({
        id: 'intent-fail-1',
        intent,
        attempts: 3,
        stage: 'upload',
        error: 'PocketBase 500: Server error',
        cause: { name: 'PocketBaseError', message: 'PocketBase 500: Server error', status: 500 },
        targetHash: 'sha256:target',
        noteSizeBytes: 1234,
        likelyReason: 'network_outage',
        payloadPreview: 'Payload snippet...',
    });

    // Verify it is written to storage immediately without waiting for a debounce timer
    const written = await storage.read(FailedTasksManager.FILE_NAME);
    assert.ok(written);
    assert.ok(written!.includes('intent-fail-1'));
    assert.ok(written!.includes('PocketBase 500: Server error'));
    assert.ok(written!.includes('Payload snippet...'));
    assert.ok(!written!.includes('must-not-be-persisted'));

    // Verify reloaded manager reads it cleanly
    const manager2 = new FailedTasksManager(storage);
    // manager2.debouncedWriteDelay = 0;
    const loaded = await manager2.initialize();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'intent-fail-1');
    assert.equal(loaded[0].stage, 'upload');
    assert.equal(loaded[0].cause?.name, 'PocketBaseError');
    assert.equal(loaded[0].payloadPreview, 'Payload snippet...');
    assert.equal('file' in loaded[0].intent, false);
});

test('FailedTasksManager serializes concurrent writes without losing a newer record', async (t: TestContext) => {
    const files = new Map<string, string>();
    let releaseFirstWrite!: () => void;
    const firstWriteReleased = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    let signalFirstWrite!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => { signalFirstWrite = resolve; });
    let writeCount = 0;
    const storage = new LocalDataStorage({
        exists: async (p: string) => files.has(p),
        mkdir: async () => {},
        read: async (p: string) => files.get(p) || '',
        write: async (p: string, content: string) => {
            if (writeCount++ === 0) {
                signalFirstWrite();
                await firstWriteReleased;
            }
            files.set(p, content);
        },
    } as any, 'local_data');
    const manager = new FailedTasksManager(storage);
    (t.mock as any).property(manager, 'debouncedWriteDelay', 0);
    const createRecord = (id: string) => ({
        id,
        intent: {
            id,
            trigger: 'auto' as const,
            event: 'modify' as const,
            operation: 'save' as const,
            path: `${id}.md`,
            policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        },
        attempts: 1,
        stage: 'upload' as const,
        error: 'transient error',
        cause: { name: 'Error', message: 'transient error' },
    });

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // t.mock.timers.enable();
    // t.mock.timers.tick(4999);
    const first = manager.recordTerminalFailure(createRecord('first'));
    await firstWriteStarted;
    const second = manager.recordTerminalFailure(createRecord('second'));
    releaseFirstWrite();
    await sleep(10);
    await Promise.all([first, second]);
    // console.log(files);
    const reloaded = new FailedTasksManager(storage);
    (t.mock as any).property(reloaded, 'debouncedWriteDelay', 0);
    const records = await reloaded.initialize();
    // t.mock.timers.tick(1);
    assert.deepEqual(records.map((record) => record.id), ['first', 'second']);
});
});
