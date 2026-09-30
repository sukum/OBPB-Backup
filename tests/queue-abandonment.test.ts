import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';
import { OperationsManager } from '../src/operations/operations-manager';
import { BackupFileOperation } from '../src/operations/backup-file-op';
import { AutomaticQueueStore } from '../src/queue/automatic-queue-store';
import { AutomaticQueueProcessor } from '../src/queue/automatic-queue-processor';
import { AutomaticQueueManager } from '../src/queue/automatic-queue-manager';
import { UploadCoordinator } from '../src/upload/upload-coordinator';
import { TaskUploader } from '../src/upload/task-uploader';
import { LocalDataStorage } from '../src/state/local-data-storage';
import { TaskFactory } from '../src/tasks/task-factory';
import { RecentNotesCache } from '../src/state/recent-notes-cache';
import { FailedTasksManager } from '../src/state/failed-tasks-manager';
import { DiffEngine } from '../src/diff/diff-engine';
import { PocketBaseError } from '../src/remote/pocketbase-client';
import { PayloadPreparer } from '../src/preparation/payload-preparer';
import { SingleFileRunner } from '../src/runner/single-file-runner';
import { logger } from './mocks/logger';

function createMockFile(path: string): TFile {
    const file = new TFile();
    file.path = path;
    file.name = path.split('/').pop() || path;
    return file;
}

test('Failed and abandoned queue task does not break upcoming queued tasks for the same path - parentHash resolves to remote', async () => {
    const memory = new Map<string, string>();
    const mockAdapter: any = {
        exists: async (p: string) => memory.has(p),
        mkdir: async () => {},
        read: async (p: string) => memory.get(p) || '',
        write: async (p: string, v: string) => memory.set(p, v),
    };

    const storage = new LocalDataStorage(mockAdapter, ".");
    const queueStore = new AutomaticQueueStore(logger);
    await queueStore.load();

    const coordinator = new UploadCoordinator();
    const recentNotesCache = new RecentNotesCache();
    const failedTasksManager = new FailedTasksManager(storage);
    // To prevent the test run from blocking for 15sec due to setTimeout
    failedTasksManager['debouncedWriteDelay'] = 100;
    await failedTasksManager.initialize();

    const vaultId = 'test-vault';
    const deviceId = 'test-device';
    const taskFactory = new TaskFactory();

    // Initial remote state has version 0
    const remoteHeadEntry = {
        path: 'Note.md',
        vault: vaultId,
        hash: 'sha256:remote-base-v0',
        parentHash: null,
        type: 'snapshot' as const,
        size: 20,
        timestamp: 1000,
        data: '# Base content v0\n',
        dataHash: 'data-hash-v0',
        id: 'obj-v0',
        deterministicId: 'det-v0',
        diffFormat: null,
    };

    const remoteEntries: any[] = [remoteHeadEntry];
    const remoteObjects = new Map<string, any>([[remoteHeadEntry.hash, remoteHeadEntry]]);
    const uploadedEntries: any[] = [];
    const uploadedObjects: any[] = [];

    const mockStore: any = {
        getEntriesWithObjects: async (v: string, p: string) => {
            if (p === 'Note.md') {
                return [...remoteEntries];
            }
            return [];
        },
        getObject: async (v: string, hash: string) => remoteObjects.get(hash) || null,
        putObject: async (obj: any) => {
            uploadedObjects.push(obj);
            remoteObjects.set(obj.hash, obj);
        },
        addEntry: async (entry: any) => {
            uploadedEntries.push(entry);
            remoteEntries.unshift({
                ...entry,
                type: 'diff',
                data: 'diff',
            });
        },
        recordFileRename: async () => {},
    };

    let simulateTask1Failure = true;
    const taskUploader = new TaskUploader(mockStore);

    // Vault files state
    let currentFileContent = '# Version 1 (will fail)\n';
    const noteFile = createMockFile('Note.md');
    const mockApp: any = {
        vault: {
            cachedRead: async () => currentFileContent,
            getAbstractFileByPath: (p: string) => (p === 'Note.md' ? noteFile : null),
        },
    };

    const mockDirtyFiles = {
        beginFlight: () => {},
        endFlight: () => {},
        markClean: async () => {},
    };

    const mockDiffWorker: any = {
        computeDiff: async (oldT: string, newT: string) => DiffEngine.createForwardDiff(oldT, newT),
    };

    const mockReconstruction: any = {
        reconstructVersion: async () => '# Base content v0\n',
    };

    const preparer = new PayloadPreparer({
        vault: mockApp.vault,
        deviceManager: { getVaultId: () => vaultId, getDevice: () => deviceId },
        cache: recentNotesCache,
        store: mockStore,
        diffComputer: mockDiffWorker,
        reconstructionEngine: mockReconstruction,
        getSettings: () => ({ monitoredExtensions: ['md'], minSnapshotDiffBytes: 0, snapshotThreshold: 1, maxDiffsBetweenSnapshots: 50 } as any),
    });

    const realRunner = new SingleFileRunner(
        preparer,
        coordinator,
        taskUploader,
        mockDirtyFiles,
        recentNotesCache,
        logger,
    );

    const runner = {
        execute: async (intent: any) => {
            if (intent.id === 'task-1' && simulateTask1Failure) {
                // Simulate a validation / terminal 400 error that causes task to be abandoned
                throw new PocketBaseError(400, 'validation error');
            }
            return realRunner.execute(intent);
        },
    };

    const processor = new AutomaticQueueProcessor(
        queueStore,
        runner,
        logger,
        {
            failedTasksManager,
            recentNotesCache,
            dirtyFileMarker: mockDirtyFiles,
        }
    );

    const queueManager = new AutomaticQueueManager(queueStore, processor);

    const backupFileOp = new BackupFileOperation({
        vault: mockApp.vault,
        queue: queueManager,
    });

    const operationsManager = new OperationsManager({
        backupFileOp,
    } as any);

    // Pause queue so we can enqueue both tasks without immediate dispatch
    queueManager.pause('test-setup');

    // 1. First debounce event occurs for Note.md (Version 1)
    const task1 = taskFactory.createSaveTask(noteFile);
    task1.id = 'task-1';
    await operationsManager.processDebouncedFile(task1);

    // Verify task1 was enqueued
    const queuedTasksAfter1 = queueStore.getTasks();
    assert.equal(queuedTasksAfter1.length, 1);
    assert.equal(queuedTasksAfter1[0].id, 'task-1');
    assert.equal(queuedTasksAfter1[0].intent.path, 'Note.md');

    // 2. User edits Note.md again to Version 2 before queue is processed
    currentFileContent = '# Version 2 (will succeed)\n';
    const task2 = taskFactory.createSaveTask(noteFile);
    task2.id = 'task-2';
    await operationsManager.processDebouncedFile(task2);

    // Verify task2 was also enqueued
    const queuedTasksAfter2 = queueStore.getTasks();
    assert.equal(queuedTasksAfter2.length, 2);
    assert.equal(queuedTasksAfter2[1].id, 'task-2');
    assert.equal(queuedTasksAfter2[1].intent.path, 'Note.md');

    // 3. Resume queue: task1 will be processed, fail, and be abandoned
    // Then task2 will be processed, its parentHash will be decided from remote (H0), and succeed!
    try {
        queueManager.resume('test-setup');
        await queueManager.process();

        // Verify:
        // a. Queue is now completely empty
        assert.equal(queueStore.count(), 0);

        // b. Task 1 was abandoned and recorded in failed tasks manager
        const failedTasks = failedTasksManager.getFailedTasks();
        assert.equal(failedTasks.length, 1);
        assert.equal(failedTasks[0].id, 'task-1');
        assert.equal(failedTasks[0].likelyReason, 'validation_error');

        // c. Task 2 succeeded and was uploaded
        assert.equal(uploadedObjects.length, 1);
        assert.equal(uploadedEntries.length, 1);
        // Crucial: Task 2's parentHash must be remoteHeadEntry.hash (H0), NOT task-1!
        assert.equal(uploadedObjects[0].parentHash, remoteHeadEntry.hash);
    } finally {
        processor.destroy();
    }
});
