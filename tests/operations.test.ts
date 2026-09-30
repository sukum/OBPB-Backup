import { test, TestContext, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { QueuePauseResume } from '../src/operations/types';
import { Hasher } from '../src/hashing/hasher';
import { DiffEngine } from '../src/diff/diff-engine';
import { LocalDataStorage } from '../src/state/local-data-storage';
import { DeviceManager } from '../src/state/device-manager';
import { RecentNotesCache } from '../src/state/recent-notes-cache';
import { TaskFactory } from '../src/tasks/task-factory';
import { TFile, TFolder } from 'obsidian';
import { StartupRecoveryOperation } from '../src/operations/startup-recovery-op';
import { SAVE_EXECUTION_POLICIES } from '../src/operations/types';
import type { FailedTaskRecord } from '../src/types/state';

function mockFile(path: string): TFile {
    const file = new TFile();
    file.path = path;
    file.name = path.split('/').pop() || path;
    return file;
}

function mockQueuePauseResume(): QueuePauseResume {
    return {
        pause: (reason?: string | undefined) => {},
        resume: (reason?: string | undefined) => {},
    };
}

function mockUploadCoordinator(): any {
    return {
        runBatchSession: async (concurrency: number, executeSession: () => Promise<any>) => {
            return await executeSession();
        },
    };
}

function mockBatchFailureReportManager(): any {
    return {
        write: async (report: any) => {},
    };
}

describe('Batch backup/sync', () => {
test('OperationsManager backupVault performs blind snapshot across all monitored files', async () => {
    const { OperationsManager } = await import('../src/operations/operations-manager');

    const fileA = mockFile('DocA.md');
    const fileB = mockFile('DocB.md');
    const fileC = mockFile('Image.png'); // unmonitored

    const fileContents: Record<string, string> = {
        'DocA.md': '# Document A content',
        'DocB.md': '# Document B content',
    };

    const enqueuedTasks: any[] = [];
    const recentNotesCache = new RecentNotesCache();

    const mockApp: any = {
        vault: {
            getFiles: () => [fileA, fileB, fileC],
            cachedRead: async (f: any) => fileContents[f.path] || '',
            getAbstractFileByPath: (p: string) => (p === 'DocA.md' ? fileA : p === 'DocB.md' ? fileB : null),
        },
    };

    const mockDeviceManager: any = {
        getVaultId: () => 'vault-test',
        getDevice: () => 'dev-test',
    };

    const mockQueueManager: any = {
        enqueue: async (t: any) => enqueuedTasks.push(t),
        getPendingCount: () => enqueuedTasks.length,
        processQueue: async () => {},
        waitForTasks: async () => {},
        pause: async () => {},
        resume: async () => {},
    };

    const { BackupVaultOperation } = await import('../src/operations/backup-vault-op');
    const { VaultBatchCoordinator } = await import('../src/operations/vault-batch-coordinator');

    const backupVaultOp = new BackupVaultOperation({
        vault: mockApp.vault,
        getSettings: () => ({ monitoredExtensions: ['md', 'canvas'] } as any),
        runner: {
            execute: async (intent) => ({ status: 'uploaded', intent }),
        },
    });

    const vaultBatchCoordinator = new VaultBatchCoordinator({
        automaticQueueManager: mockQueueManager,
        uploadCoordinator: mockUploadCoordinator(),
        batchFailureReportManager: mockBatchFailureReportManager(),
        backupVaultOp,
        syncVaultOp: {} as any,
        getSettings: () => ({ batchConcurrency: 3 }),
    });

    const manager = new OperationsManager({
        vaultBatchCoordinator,
    } as any);

    const result = await manager.backupVault();

    // DocA and DocB should be snapshotted; Image.png should be ignored
    assert.equal(result.totalFiles, 2);
    assert.equal(result.uploaded, 2);
    assert.equal(enqueuedTasks.length, 0, 'manual batch preparation is no longer sent through a queue');
});


// Skipped: OperationsManager.syncVault was decomposed into SyncVaultOperation, SingleFileRunner, and PayloadPreparer. Diff computation and unchanged skipping are handled by PayloadPreparer and SingleFileRunner (covered by tests/payload-preparer.test.ts, tests/single-file-runner.test.ts, and Step 6 SyncVaultOperation Phase 2 tests).
test.skip('OperationsManager syncVault creates snapshots for new files, diffs for modified, skips unchanged, and deletes missing', async () => {
    const { OperationsManager } = await import('../src/operations/operations-manager');

    // Setup 4 files:
    // 1. NewNote.md (unindexed -> snapshot)
    // 2. Modified.md (indexed but changed -> diff)
    // 3. Unchanged.md (indexed and identical -> skip)
    // 4. Deleted.md (in index, but missing from vault -> delete)

    const fileNew = mockFile('NewNote.md');
    const fileMod = mockFile('Modified.md');
    const fileUnchanged = mockFile('Unchanged.md');

    const diskContents: Record<string, string> = {
        'NewNote.md': '# Brand new file',
        'Modified.md': '# Base line\nModified line added',
        'Unchanged.md': '# Constant text',
    };

    const enqueuedTasks: any[] = [];
    const recentNotesCache = new RecentNotesCache();

    // Remote latest state
    const baseModText = '# Base line\n';
    const modHash = await Hasher.computeHash(baseModText);
    const unchText = '# Constant text';
    const unchHash = await Hasher.computeHash(unchText);

    const mockStore: any = {
        getLatestFiles: async () => [
            { path: 'Modified.md', hash: modHash, timestamp: 1000, operation: 'save' },
            { path: 'Unchanged.md', hash: unchHash, timestamp: 1000, operation: 'save' },
            { path: 'Deleted.md', hash: 'sha256:deleted123', timestamp: 1000, operation: 'save' },
        ],
        getLatestEntry: async (_v: string, p: string) => {
            if (p === 'Deleted.md') {
                return { path: 'Deleted.md', hash: 'sha256:deleted123', timestamp: 1000, operation: 'save' };
            }
            return null;
        },
        getEntriesWithObjects: async (_v: string, path: string) => path === 'Modified.md'
            ? [{ type: 'snapshot', hash: modHash, timestamp: 1000 }]
            : [],
    };

    const mockApp: any = {
        vault: {
            getFiles: () => [fileNew, fileMod, fileUnchanged],
            cachedRead: async (f: any) => diskContents[f.path] || '',
            getAbstractFileByPath: (p: string) => {
                if (p === 'NewNote.md') return fileNew;
                if (p === 'Modified.md') return fileMod;
                if (p === 'Unchanged.md') return fileUnchanged;
                return null; // Deleted.md missing!
            },
        },
    };

    const mockDeviceManager: any = {
        getVaultId: () => 'vault-test',
        getDevice: () => 'dev-test',
    };

    const mockQueueManager: any = {
        enqueue: async (t: any) => enqueuedTasks.push(t),
        getPendingCount: () => enqueuedTasks.length,
        processQueue: async () => {},
        waitForTasks: async () => {},
    };

    const mockDiffWorker: any = {
        computeDiff: async (oldT: string, newT: string) => DiffEngine.createForwardDiff(oldT, newT),
    };

    const mockReconstruction: any = {
        reconstructVersion: async () => baseModText,
    };

    const manager = new OperationsManager({
        app: mockApp,
        deviceManager: mockDeviceManager,
        taskFactory: new TaskFactory(),
        recentNotesCache,
        dirtyFileManager: { markClean: async () => {} } as any,
        debounceController: { flushAll: async () => {}, cancel: () => {} } as any,
        diffWorkerClient: mockDiffWorker,
        queueManager: mockQueueManager,
        reconstructionEngine: mockReconstruction,
        getSettings: () => ({ monitoredExtensions: ['md'] } as any),
        store: mockStore,
    } as any);

    const result = await manager.syncVault();

    assert.equal(result.totalFiles, 3);
    assert.equal(result.uploaded, 2); // NewNote (snapshot) + Modified (diff)
    assert.equal(result.unchanged, 1);
    assert.equal(result.deleted, 1);  // Deleted.md

    assert.equal(enqueuedTasks.length, 0, 'sync preparation is session-only');
});


test('OperationsManager executes bulk operations in batches and honors stop requests', async () => {
    const { OperationsManager } = await import('../src/operations/operations-manager');

    const files = ['F1.md', 'F2.md', 'F3.md', 'F4.md', 'F5.md'].map(mockFile);

    const fileContents: Record<string, string> = {
        'F1.md': '1', 'F2.md': '2', 'F3.md': '3', 'F4.md': '4', 'F5.md': '5'
    };

    const mockApp: any = {
        vault: {
            getFiles: () => files,
            cachedRead: async (f: any) => fileContents[f.path],
            getAbstractFileByPath: (p: string) => files.find(f => f.path === p) || null,
        },
    };

    const mockDeviceManager: any = {
        getVaultId: () => 'v-test',
        getDevice: () => 'd-test',
    };
    const recentNotesCache = new RecentNotesCache();

    const batchCalls: string[][] = [];
    const mockQueue: any = {
        enqueue: async (t: any) => {},
        getPendingCount: () => 0,
        processQueue: async () => {},
        waitForTasks: async (taskIds: string[]) => {
            batchCalls.push([...taskIds]);
        },
        getSynchronizer: () => ({
            waitForTasks: async ({ taskIds }: { taskIds: string[] }) => {
                batchCalls.push([...taskIds]);
            },
        }),
    };

    // Test 1: Full batching (batchConcurrency = 2 over 5 files -> 3 batches of sizes 2, 2, 1)
    const { BackupVaultOperation } = await import('../src/operations/backup-vault-op');
    const { VaultBatchCoordinator } = await import('../src/operations/vault-batch-coordinator');

    const backupVaultOp1 = new BackupVaultOperation({
        vault: mockApp.vault,
        getSettings: () => ({ monitoredExtensions: ['md'], batchConcurrency: 2 } as any),
        runner: {
            execute: async (intent) => ({ status: 'uploaded', intent }),
        },
    });

    const coordinator1 = new VaultBatchCoordinator({
        automaticQueueManager: mockQueuePauseResume(),
        uploadCoordinator: mockUploadCoordinator(),
        batchFailureReportManager: mockBatchFailureReportManager(),
        backupVaultOp: backupVaultOp1,
        syncVaultOp: {} as any,
        getSettings: () => ({ batchConcurrency: 3 }),
    });

    const manager = new OperationsManager({
        vaultBatchCoordinator: coordinator1,
    } as any);

    const fullResult = await manager.backupVault();
    assert.equal(fullResult.totalFiles, 5);
    assert.equal(fullResult.uploaded, 5);
    assert.equal(fullResult.stopped, false);
    assert.equal(batchCalls.length, 0, 'manual batches upload directly and never wait on the legacy queue');

    // Test 2: Stop button honored mid-run
    batchCalls.length = 0;
    let processedCount = 0;

    const backupVaultOp2 = new BackupVaultOperation({
        vault: mockApp.vault,
        getSettings: () => ({ monitoredExtensions: ['md'], batchConcurrency: 2 } as any),
        runner: {
            execute: async (intent) => ({ status: 'uploaded', intent }),
        },
    });

    const coordinator2 = new VaultBatchCoordinator({
        automaticQueueManager: mockQueuePauseResume(),
        uploadCoordinator: mockUploadCoordinator(),
        batchFailureReportManager: mockBatchFailureReportManager(),
        backupVaultOp: backupVaultOp2,
        syncVaultOp: {} as any,
        getSettings: () => ({ batchConcurrency: 3 }),
    });

    const stopManager = new OperationsManager({
        vaultBatchCoordinator: coordinator2,
    } as any);

    const stopResult = await stopManager.backupVault((cur, tot, p) => {
        processedCount++;
        // Trigger stop after 2nd file
        if (processedCount === 2) {
            stopManager.stopVaultOperation();
        }
    });

    assert.equal(stopResult.stopped, true);
    assert.equal(stopResult.processed, 2);
    assert.equal(stopResult.uploaded, 2);
    assert.ok(stopResult.processed < 5, 'Halted reading further files from vault');
});
});

describe('Manual batch report', () => {
test('OperationsManager writes a manual batch report with failure counts', async (t: TestContext) => {
    const { OperationsManager } = await import('../src/operations/operations-manager');
    const { BackupVaultOperation } = await import('../src/operations/backup-vault-op');
    const { VaultBatchCoordinator } = await import('../src/operations/vault-batch-coordinator');
    const file = mockFile('failed.md');
    const reports: any[] = [];

    const backupVaultOp = new BackupVaultOperation({
        vault: { getFiles: () => [file], getAbstractFileByPath: () => file, cachedRead: async () => 'content' } as any,
        getSettings: () => ({ monitoredExtensions: ['md'], batchConcurrency: 1 } as any),
        runner: {
            execute: async () => { throw new Error('upload failed'); },
        },
    });

    const vaultBatchCoordinator = new VaultBatchCoordinator({
        automaticQueueManager: mockQueuePauseResume(),
        uploadCoordinator: mockUploadCoordinator(),
        backupVaultOp,
        syncVaultOp: {} as any,
        batchFailureReportManager: { write: async (report: any) => { reports.push(report); return 'report.json'; } } as any,
        getSettings: () => ({ batchConcurrency: 3 }),
    });

    const manager = new OperationsManager({
        vaultBatchCoordinator,
    } as any);

    t.mock.method(console, 'error', () => {});
    const result = await manager.backupVault();
    assert.equal(result.failed, 1);
    assert.equal(result.notAttempted, 0);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].failed, 1);
    assert.equal(reports[0].failures[0].path, 'failed.md');
});
});

describe('OperationsManager - backup file', () => {
// Skipped: BackupFileOperation and OperationsManager.backupFileNow were refactored to delegate to ManualFileOperation and SingleFileRunner. Remote parent hash recovery on cache miss is now handled inside PayloadPreparer (covered by tests/payload-preparer.test.ts).
test.skip('OperationsManager recovers parent hash and timestamp from remote on cache miss', async () => {
    const { OperationsManager } = await import('../src/operations/operations-manager');

    const memoryFiles = new Map<string, string>();
    const mockAdapter: any = {
        exists: async (p: string) => memoryFiles.has(p),
        mkdir: async () => {},
        read: async (p: string) => memoryFiles.get(p) || '',
        write: async (p: string, data: string) => {
            memoryFiles.set(p, data);
        },
        append: async (p: string, data: string) => {
            memoryFiles.set(p, (memoryFiles.get(p) || '') + data);
        },
        remove: async (p: string) => {
            memoryFiles.delete(p);
        },
    };

    const storage = new LocalDataStorage(mockAdapter, 'test-plugin');
    const deviceManager = new DeviceManager(storage);
    await deviceManager.initialize('vault-recovery-test');
    const recentNotesCache = new RecentNotesCache();

    const remoteLatestEntry = {
        id: 'remote-1',
        vault: 'vault-recovery-test',
        path: 'Doc.md',
        operation: 'save' as const,
        device: 'other-device',
        timestamp: 5000,
        hash: 'sha256:remote-base-hash',
        type: 'snapshot' as const,
        size: 50,
    };

    const mockStore: any = {
        getLatestEntry: async (v: string, p: string) => {
            if (p === 'Doc.md') return remoteLatestEntry;
            return null;
        },
        getEntriesWithObjects: async (v: string, p: string) => {
            if (p === 'Doc.md') {
                return [
                    {
                        path: 'Doc.md',
                        vault: v,
                        hash: remoteLatestEntry.hash,
                        parentHash: null,
                        type: 'snapshot',
                        size: remoteLatestEntry.size,
                        timestamp: remoteLatestEntry.timestamp,
                        data: 'Initial text from remote',
                    },
                ];
            }
            return [];
        },
    };

    const enqueuedTasks: any[] = [];
    const mockQueue: any = {
        enqueue: async (t: any) => enqueuedTasks.push(t),
    };

    const docContent = 'Updated text after cache loss';
    const docFile = new TFile();
    docFile.path = 'Doc.md';
    docFile.name = 'Doc.md';

    const mockApp: any = {
        vault: {
            cachedRead: async () => docContent,
        },
    };

    const baseText = 'Initial text from remote';
    const mockReconstruction: any = {
        reconstructVersion: async (v: string, p: string, targetHash: string) => {
            assert.equal(targetHash, remoteLatestEntry.hash);
            return baseText;
        },
    };

    const mockDiffWorker: any = {
        computeDiff: async (oldT: string, newT: string) => DiffEngine.createForwardDiff(oldT, newT),
    };

    const backupManager = new (OperationsManager as any)({
        app: mockApp,
        deviceManager,
        taskFactory: new TaskFactory(),
        recentNotesCache,
        dirtyFileManager: { markClean: async () => {} } as any,
        debounceController: { handleModified: async () => {} } as any,
        diffWorkerClient: mockDiffWorker,
        queueManager: mockQueue,
        reconstructionEngine: mockReconstruction,
        getSettings: () => ({ monitoredExtensions: ['md'], minSnapshotDiffBytes: 0, snapshotThreshold: 1, maxDiffsBetweenSnapshots: 50 } as any),
        store: mockStore,
    });

    const task: any = await backupManager.backupFileNow(docFile);
    assert.ok(task);
    assert.equal(task!.operation, 'save');
    assert.equal(task!.objectPayload?.parentHash, remoteLatestEntry.hash);
    assert.ok(task!.timestamp > remoteLatestEntry.timestamp);
    assert.equal(task!.objectPayload?.type, 'diff');

    // Verify recentNotesCache was organically populated
    const cachedMeta = recentNotesCache.get('Doc.md');
    assert.ok(cachedMeta);
    assert.equal(cachedMeta!.hash, task!.targetHash);
    assert.equal(cachedMeta!.diffDepth, 1);
    assert.equal(cachedMeta!.baseText, docContent);
});


// Skipped: Modular methods baseTextFromCache, baseTextFromRemote, snapshotPayload, diffPayload were removed from BackupFileOperation and migrated to pure policies and PayloadPreparer (covered by tests/payload-preparer.test.ts and tests/single-file-runner.test.ts).
test.skip('BackupFileOperation modular methods baseTextFromCache, baseTextFromRemote, snapshotPayload, diffPayload operate correctly', async (t: TestContext) => {
    const { BackupFileOperation } = await import('../src/operations/backup-file-op');

    const cleanMarked: string[] = [];
    const loggedRecords: any[] = [];
    const enqueuedTasks: any[] = [];
    const recentNotesCache = new RecentNotesCache();

    const mockVaultFiles: Record<string, string> = {
        'Note1.md': '# Hello World\r\nSecond Line\r\n',
        'Large.md': 'A'.repeat(11 * 1024 * 1024), // > 10MB
        'Ignore.pdf': 'PDF binary data',
    };

    const mockApp: any = {
        vault: {
            cachedRead: async (f: any) => mockVaultFiles[f.path] || '',
        },
    };

    const mockDeviceManager: any = {
        getVaultId: () => 'vault-test-123',
        getDevice: () => 'device-test-abc',
    };

    const mockDirtyFileManager: any = {
        markClean: async (p: string) => { cleanMarked.push(p); },
    };

    const mockLogger: any = {
        record: (rec: any) => { loggedRecords.push(rec); },
    };

    const mockDiffWorkerClient: any = {
        computeDiff: async (oldText: string, newText: string) => DiffEngine.createForwardDiff(oldText, newText),
    };

    const mockReconstructionEngine: any = {
        reconstructVersion: async (_v: string, _p: string, hash: string) => {
            if (hash === 'sha256:fail') throw new Error('Reconstruction failed');
            return DiffEngine.normalizeNewlines('# Reconstructed Base Text\r\n');
        },
    };

    const mockStore: any = {
        getEntriesWithObjects: async (_v: string, p: string) => {
            if (p === 'ColdError.md') throw new Error('Network timeout');
            if (p === 'Sync.md') {
                return [{ type: 'snapshot', hash: 'sha256:remote-parent', timestamp: 2000 }];
            }
            if (p === 'ManualDiff.md') {
                return [
                    { type: 'diff', hash: 'sha256:manual-head', timestamp: 4000 },
                    { type: 'diff', hash: 'sha256:manual-parent', timestamp: 3000 },
                    { type: 'snapshot', hash: 'sha256:manual-base', timestamp: 2000 },
                ];
            }
            if (p === 'Incomplete.md') {
                return [
                    { type: 'diff', hash: 'sha256:incomplete-head', timestamp: 4000 },
                    { type: 'diff', hash: 'sha256:incomplete-parent', timestamp: 3000 },
                ];
            }
            if (p === 'ColdChain.md') {
                return [
                    { type: 'diff', hash: 'sha256:entry3', timestamp: 3000 },
                    { type: 'diff', hash: 'sha256:entry2', timestamp: 2000 },
                    { type: 'snapshot', hash: 'sha256:entry1', timestamp: 1000 },
                ];
            }
            return [];
        },
    };

    const ctx: any = {
        vault: mockApp.vault,
        deviceManager: mockDeviceManager,
        recentNotesCache,
        dirtyFileManager: mockDirtyFileManager,
        debounceController: { handleModified: async () => {} },
        diffWorkerClient: mockDiffWorkerClient,
        queueManager: { enqueue: async (t: any) => enqueuedTasks.push(t) },
        reconstructionEngine: mockReconstructionEngine,
        getSettings: () => ({
            monitoredExtensions: ['md'],
            snapshotThreshold: 0.5,
            minSnapshotDiffBytes: 16384,
            maxDiffsBetweenSnapshots: 50,
            maxFileSizeMb: 10,
        }),
        logger: mockLogger,
        store: mockStore,
        taskFactory: new TaskFactory(),
    };

    const op: any = new (BackupFileOperation as any)(ctx);

    // 1. Test readAndValidateFile
    const unmonitoredResult = await op.readAndValidateFile({ path: 'Ignore.pdf', name: 'Ignore.pdf' } as any);
    assert.equal(unmonitoredResult, null);
    assert.ok(cleanMarked.includes('Ignore.pdf'));

    const oversizedResult = await op.readAndValidateFile({ path: 'Large.md', name: 'Large.md' } as any);
    assert.equal(oversizedResult, null);
    assert.ok(cleanMarked.includes('Large.md'));

    const validResult = await op.readAndValidateFile({ path: 'Note1.md', name: 'Note1.md' } as any);
    assert.ok(validResult !== null);
    assert.equal(validResult!.content, DiffEngine.normalizeNewlines('# Hello World\r\nSecond Line\r\n')); // Normalized CRLF to LF
    assert.equal(validResult!.fileSizeBytes, validResult!.content.length);

    // 2. Test baseTextFromCache
    const noteHash = await Hasher.computeHash(validResult!.content);

    // 2a: Cache miss
    const cacheMiss = await op.baseTextFromCache('Note1.md', noteHash, true);
    assert.equal(cacheMiss.isUnchanged, false);
    assert.equal(cacheMiss.baseText, null);
    assert.equal(cacheMiss.parentHash, null);

    // Populate cache for Note1.md
    recentNotesCache.set('Note1.md', {
        path: 'Note1.md',
        hash: noteHash,
        baseText: validResult!.content,
        diffDepth: 3,
        timestamp: 1500,
    });

    // 2b: Cache hit & unchanged
    const cacheUnchanged = await op.baseTextFromCache('Note1.md', noteHash, true);
    assert.equal(cacheUnchanged.isUnchanged, true);
    assert.equal(cacheUnchanged.parentHash, noteHash);
    assert.equal(cacheUnchanged.diffDepth, 3);
    assert.ok(cleanMarked.includes('Note1.md'));

    // 2c: Cache hit & changed
    const cacheChanged = await op.baseTextFromCache('Note1.md', 'sha256:different-hash', true);
    assert.equal(cacheChanged.isUnchanged, false);
    assert.equal(cacheChanged.parentHash, noteHash);
    assert.equal(cacheChanged.baseText, validResult!.content);
    assert.equal(cacheChanged.diffDepth, 3);
    assert.equal(cacheChanged.prevTimestamp, 1500);

    // 3. Test baseTextFromRemote
    // 3a: Manual sync unchanged
    const manualUnchanged = await op.baseTextFromRemote(
        'Sync.md', 'sha256:matching', { hash: 'sha256:matching', timestamp: 2000 }, true, 'vault-test-123'
    );
    assert.equal(manualUnchanged.isUnchanged, true);
    assert.equal(manualUnchanged.parentHash, 'sha256:matching');

    // 3b: Manual sync changed with reconstruction
    const manualChanged = await op.baseTextFromRemote(
        'Sync.md', 'sha256:different', { hash: 'sha256:remote-parent', timestamp: 2000 }, true, 'vault-test-123'
    );
    assert.equal(manualChanged.isUnchanged, false);
    assert.equal(manualChanged.parentHash, 'sha256:remote-parent');
    assert.equal(manualChanged.baseText, DiffEngine.normalizeNewlines('# Reconstructed Base Text\r\n'));
    assert.equal(manualChanged.diffDepth, 0);
    assert.equal(manualChanged.kind, 'resolved');

    const manualDiffHead = await op.baseTextFromRemote(
        'ManualDiff.md', 'sha256:new', { hash: 'sha256:manual-head', timestamp: 4000 }, true, 'vault-test-123'
    );
    assert.equal(manualDiffHead.diffDepth, 2);
    assert.equal(manualDiffHead.kind, 'resolved');

    const incompleteManualChain = await op.baseTextFromRemote(
        'Incomplete.md', 'sha256:new', { hash: 'sha256:incomplete-head', timestamp: 4000 }, true, 'vault-test-123'
    );
    assert.equal(incompleteManualChain.kind, 'snapshot-fallback');
    assert.equal(incompleteManualChain.diffDepth, undefined);
    assert.equal(incompleteManualChain.baseText, null);

    // 3c: Cold path scanning diff chain (2 diffs after snapshot -> diffDepth = 2)
    const coldChain = await op.baseTextFromRemote('ColdChain.md', 'sha256:new', undefined, true, 'vault-test-123');
    assert.equal(coldChain.isUnchanged, false);
    assert.equal(coldChain.parentHash, 'sha256:entry3');
    assert.equal(coldChain.prevTimestamp, 3000);
    assert.equal(coldChain.diffDepth, 2);
    assert.equal(coldChain.baseText, DiffEngine.normalizeNewlines('# Reconstructed Base Text\r\n'));

    // 3d: Cold path network error fallback
    // t.mock.method(console, 'error', () => {});
    const originalConsoleWarn = console.warn;
    console.warn = () => {}; // Silence logs
    const coldError = await op.baseTextFromRemote('ColdError.md', 'sha256:new', undefined, true, 'vault-test-123');
    assert.equal(coldError.isUnchanged, false);
    assert.equal(coldError.baseText, null);
    assert.equal(coldError.parentHash, null);
    console.warn = originalConsoleWarn; // Restore original console.warn

    // 4. Test snapshotPayload
    const snapPayload = await op.snapshotPayload('vault-test-123', noteHash, validResult!.content, null, validResult!.fileSizeBytes);
    assert.equal(snapPayload.type, 'snapshot');
    assert.equal(snapPayload.hash, noteHash);
    assert.equal(snapPayload.parentHash, null);
    assert.equal(snapPayload.data, validResult!.content);

    // 5. Test diffPayload
    const baseTextForDiff = DiffEngine.normalizeNewlines('# Hello World\r\n');
    const modifiedTextForDiff = DiffEngine.normalizeNewlines('# Hello World\r\nSecond Line\r\n');
    const baseHashForDiff = await Hasher.computeHash(baseTextForDiff);
    const modHashForDiff = await Hasher.computeHash(modifiedTextForDiff);

    const diffPayloadResult = await op.diffPayload(
        'vault-test-123',
        baseHashForDiff,
        modHashForDiff,
        baseTextForDiff,
        modifiedTextForDiff,
        modifiedTextForDiff.length
    );
    assert.equal(diffPayloadResult.type, 'diff');
    assert.equal(diffPayloadResult.parentHash, baseHashForDiff);
    assert.equal(diffPayloadResult.hash, modHashForDiff);
    assert.ok(diffPayloadResult.data.includes('+Second Line'));

    t.mock.method(console, 'warn', () => {});
    // const originalConsoleWarn = console.warn; // Already declared above
    // console.warn = () => {}; // Silence logs // Not working
    // 5b: Diff verification mismatch throws
    const badDiffWorkerOp: any = new (BackupFileOperation as any)({
        ...ctx,
        diffWorkerClient: {
            computeDiff: async () => 'corrupted patch content @@',
        },
    });
    await assert.rejects(
        badDiffWorkerOp.diffPayload('vault-test-123', baseHashForDiff, modHashForDiff, baseTextForDiff, modifiedTextForDiff, 100),
        /Diff verification mismatch/
    );
    // console.warn = originalConsoleWarn; // Restore original console.warn

    // 6. Test createPayload with fallback
    // 6a: Under threshold -> creates diff
    const createdDiff = await op.createPayload(
        'vault-test-123',
        modifiedTextForDiff,
        modHashForDiff,
        modifiedTextForDiff.length,
        baseTextForDiff,
        baseHashForDiff,
        2,
        { mode: 'auto', skipIfUnchanged: true, baseSource: 'cache-then-remote', updateRecentNotesCache: true }
    );
    assert.equal(createdDiff.objectPayload.type, 'diff');
    assert.equal(createdDiff.newDiffDepth, 3);

    // 6b: Verification failure triggers graceful fallback to snapshot with diffDepth = 0
    const createdFallback = await badDiffWorkerOp.createPayload(
        'vault-test-123',
        modifiedTextForDiff,
        modHashForDiff,
        modifiedTextForDiff.length,
        baseTextForDiff,
        baseHashForDiff,
        2,
        { mode: 'auto', skipIfUnchanged: true, baseSource: 'cache-then-remote', updateRecentNotesCache: true }
    );
    assert.equal(createdFallback.objectPayload.type, 'snapshot');
    assert.equal(createdFallback.newDiffDepth, 0);

    // 7. Test execute end-to-end orchestration
    recentNotesCache.clear();
    const noteFile = new TFile();
    noteFile.path = 'Note1.md';
    noteFile.name = 'Note1.md';
    const saveTask = ctx.taskFactory.createSaveTask(noteFile);
    const task: any = await op.execute(
        { source: 'debounce', task: saveTask },
        { mode: 'auto', skipIfUnchanged: true, baseSource: 'cache-then-remote', updateRecentNotesCache: true }
    );
    assert.ok(task !== null);
    assert.equal(task!.vault, 'vault-test-123');
    assert.equal(task!.path, 'Note1.md');
    assert.equal(task!.operation, 'save');
    assert.equal(task!.objectPayload?.type, 'snapshot'); // Initial backup is snapshot
});
});

describe('OperationsManager UI actions', () => {
test('OperationsManager routes UI actions (reconstruct, restore, queue controls, debounce flush) seamlessly', async () => {
    let reconstructCalledWith: any = null;
    let restoreCalledWith: any = null;
    let queuePaused = false;
    let retryNowCalled = false;
    let retryTaskIdCalled: string | null = null;
    let flushAllCalled = false;
    let flushFileCalled: string | null = null;
    let processQueueCalled = false;

    const mockReconstructionEngine: any = {
        reconstructVersion: async (vaultId: string, path: string, hash: string, entries?: any[]) => {
            reconstructCalledWith = { vaultId, path, hash, entries };
            return 'reconstructed text content';
        },
    };

    const mockRestoreManager: any = {
        restoreVersion: async (vaultId: string, path: string, hash: string, options?: any) => {
            restoreCalledWith = { vaultId, path, hash, options };
            return { status: 'modified', path };
        },
    };

    const mockQueueManager: any = {
        pause: () => { queuePaused = true; },
        resume: () => { queuePaused = false; },
        isPaused: () => queuePaused,
        retryNow: async () => { retryNowCalled = true; },
        retryTask: async (id: string) => { retryTaskIdCalled = id; },
        process: async () => { processQueueCalled = true; },
        enqueue: async () => {},
    };

    const mockDebounceController: any = {
        flushAll: async () => { flushAllCalled = true; },
        flushFile: async (path: string) => { flushFileCalled = path; },
        cancel: () => {},
        schedule: async () => {},
    };

    const mockApp: any = {
        vault: {
            cachedRead: async () => 'test content',
            modify: async () => {},
            create: async () => {},
            getAbstractFileByPath: (p: string) => ({ path: p, name: p }),
            getFiles: () => [],
            adapter: { exists: async () => true },
        },
    };

    const { OperationsManager } = await import('../src/operations/operations-manager');
    const ops = new OperationsManager({
        app: mockApp,
        deviceManager: { getVaultId: () => 'vault-test', getDevice: () => 'device-test' } as any,
        taskFactory: new TaskFactory(),
        recentNotesCache: new (await import('../src/state/recent-notes-cache')).RecentNotesCache(),
        dirtyFileManager: { markClean: async () => {}, markDirty: async () => {} } as any,
        debounceController: mockDebounceController,
        diffWorkerClient: { computeDiff: async () => '' } as any,
        automaticQueueManager: mockQueueManager,
        reconstructionEngine: mockReconstructionEngine,
        getSettings: () => ({ safetyBackupBeforeRestore: true } as any),
        restoreManager: mockRestoreManager,
        manualFileOp: {
            backupFileNow: async () => null,
            snapshotFileNow: async () => null,
        } as any,
    } as any);

    // 1. Reconstruct version
    const content = await ops.reconstructVersion('vault-test', 'Doc.md', 'sha256:abc');
    assert.equal(content, 'reconstructed text content');
    assert.deepEqual(reconstructCalledWith, { vaultId: 'vault-test', path: 'Doc.md', hash: 'sha256:abc', entries: undefined });

    // 2. Restore version (options are passed through to the restore manager untouched)
    const restoreRes = await ops.restoreVersion('vault-test', 'Doc.md', 'sha256:abc', { takeSafetyBackup: false });
    assert.equal(restoreCalledWith.vaultId, 'vault-test');
    assert.equal(restoreCalledWith.path, 'Doc.md');
    assert.equal(restoreCalledWith.hash, 'sha256:abc');
    assert.deepEqual(restoreCalledWith.options, { takeSafetyBackup: false });
    assert.deepEqual(restoreRes, { status: 'modified', path: 'Doc.md' });

    // 3. Queue controls
    assert.equal(ops.isQueuePaused(), false);
    ops.pauseQueue();
    assert.equal(ops.isQueuePaused(), true);
    ops.resumeQueue();
    assert.equal(ops.isQueuePaused(), false);

    await ops.retryUploadQueue();
    assert.equal(retryNowCalled, true);

    // 4. Debounce flushing
    await ops.flushDebouncedFiles();
    assert.equal(flushAllCalled, true);

    await ops.flushDebouncedFiles('Specific.md');
    assert.equal(flushFileCalled, 'Specific.md');

    await ops.flushAndProcessQueue();
    assert.equal(processQueueCalled, true);
});
});

describe('Startup Recovery Operation', () => {
test('StartupRecoveryOperation.execute handles empty dirty log gracefully', async (t: TestContext) => {
    let loadCalled = false;
    let markCleanCalled = false;
    let processCalled = false;

    const mockDirtyFileManager: any = {
        load: async () => {
            loadCalled = true;
            return [];
        },
        markClean: async () => {
            markCleanCalled = true;
        },
    };

    const recoveryOp = new StartupRecoveryOperation({
        vault: { getAbstractFileByPath: () => null } as any,
        dirtyFileManager: mockDirtyFileManager,
        queue: { enqueue: async () => {} } as any,
    });

    t.mock.method(console, 'log', () => {});
    await recoveryOp.execute();
    assert.equal(loadCalled, true);
    assert.equal(markCleanCalled, false);
    assert.equal(processCalled, false);
});

test('StartupRecoveryOperation.execute processes existing TFiles, skips missing files, and preserves active tasks', async (t: TestContext) => {
    const existingFile = mockFile('Notes/Recovered.md');
    const enqueuedIntents: any[] = [];
    let savedAllEntries: any[] | null = null;

    const mockDirtyFileManager: any = {
        load: async () => [
            { operation: 'SAVE' as const, path: 'Notes/Recovered.md' },
            { operation: 'SAVE' as const, path: 'Notes/Missing.md' },
        ],
        markClean: async () => {},
        saveAll: async (entries: any[]) => {
            savedAllEntries = entries;
        },
    };

    const mockApp: any = {
        vault: {
            getAbstractFileByPath: (p: string) => (p === 'Notes/Recovered.md' ? existingFile : null),
        },
    };

    const recoveryOp = new StartupRecoveryOperation({
        vault: mockApp.vault,
        dirtyFileManager: mockDirtyFileManager,
        queue: {
            enqueue: async (intent: any) => {
                enqueuedIntents.push(intent);
            },
        },
    });
    
    t.mock.method(console, 'log', () => {});
    await recoveryOp.execute();

    assert.equal(enqueuedIntents.length, 2);
    const saveIntent = enqueuedIntents.find((it) => it.operation === 'save');
    assert.ok(saveIntent);
    assert.equal(saveIntent.path, 'Notes/Recovered.md');
    assert.equal(saveIntent.event, 'recovery');

    const deleteIntent = enqueuedIntents.find((it) => it.operation === 'delete');
    assert.ok(deleteIntent);
    assert.equal(deleteIntent.path, 'Notes/Missing.md');
    assert.equal(deleteIntent.event, 'recovery');

    assert.ok(savedAllEntries);
    assert.equal((savedAllEntries as any).length, 2);
});

// Skipped: processRecoveredFile callback was removed from StartupRecoveryOperation in the refactored control flow. Dirty journal cleanup is now owned by the runner/uploader upon task completion, not during startup recovery enqueue.
test.skip('StartupRecoveryOperation.execute catches processRecoveredFile errors and still cleans dirty path', async (t: TestContext) => {
    const failingFile = mockFile('Notes/Failing.md');
    const cleanedPaths: string[] = [];

    const mockDirtyFileManager: any = {
        load: async () => ['Notes/Failing.md'],
        markClean: async (p: string) => {
            cleanedPaths.push(p);
        },
    };

    const mockApp: any = {
        vault: {
            getAbstractFileByPath: () => failingFile,
        },
    };

    const taskFactory = new TaskFactory();
    const recoveryOp = new StartupRecoveryOperation({
        vault: mockApp.vault,
        deviceManager: { getVaultId: () => 'vault-id', getDevice: () => 'device-id' } as any,
        dirtyFileManager: mockDirtyFileManager,
        taskFactory,
        processRecoveredFile: async () => {
            throw new Error('Upload queue unavailable during recovery');
        },
    } as any);
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    await recoveryOp.execute();
    assert.deepEqual(cleanedPaths, ['Notes/Failing.md']);
});

test('OperationsManager.runStartupRecovery delegates to startupRecoveryOp and enqueues task', async (t: TestContext) => {
    const { OperationsManager } = await import('../src/operations/operations-manager');
    const file = mockFile('CrashNote.md');
    const cleanedPaths: string[] = [];
    const enqueuedIntents: any[] = [];

    const mockDirtyFileManager: any = {
        load: async () => [{ operation: 'SAVE' as const, path: 'CrashNote.md' }],
        markClean: async (p: string) => {
            cleanedPaths.push(p);
        },
        markDirty: async () => {},
        saveAll: async () => {},
    };

    const mockApp: any = {
        vault: {
            getFiles: () => [file],
            getAbstractFileByPath: (p: string) => (p === 'CrashNote.md' ? file : null),
            cachedRead: async () => '# Crashed Content',
        },
    };

    const mockQueueManager: any = {
        enqueue: async (t: any) => enqueuedIntents.push(t),
        getPendingCount: () => enqueuedIntents.length,
    };

    const startupRecoveryOp = new StartupRecoveryOperation({
        vault: mockApp.vault,
        dirtyFileManager: mockDirtyFileManager,
        queue: mockQueueManager,
    });

    const ops = new OperationsManager({
        app: mockApp,
        taskFactory: new TaskFactory(),
        deviceManager: { getVaultId: () => 'vault-test', getDevice: () => 'dev-test' } as any,
        recentNotesCache: new RecentNotesCache(),
        store: { getHistory: async () => [] } as any,
        dirtyFileManager: mockDirtyFileManager,
        debounceController: { cancel: async () => {} } as any,
        diffWorkerClient: { computeDiff: async () => '' } as any,
        automaticQueueManager: mockQueueManager,
        reconstructionEngine: {} as any,
        getSettings: () => ({ monitoredExtensions: ['md'], safetyBackupBeforeRestore: true } as any),
        restoreManager: {} as any,
        startupRecoveryOp,
    } as any);

    t.mock.method(console, 'log', () => {});
    await ops.runStartupRecovery();

    assert.equal(enqueuedIntents.length, 1);
    assert.equal(enqueuedIntents[0].path, 'CrashNote.md');
    assert.equal(enqueuedIntents[0].operation, 'save');
    assert.equal(enqueuedIntents[0].event, 'recovery');
    assert.deepEqual(Array.from(new Set(cleanedPaths)), []);
});
});

describe('OperationsManager File Rename', () => {
// Skipped: OperationsManager.handleFileRename no longer emits separate delete and rename tasks to the queue. It enqueues a single atomic RenameIntent, and two-step publication is handled by TaskUploader under the upload lock (covered by tests/upload.test.ts).
test.skip('OperationsManager.handleFileRename emits delete task for oldPath and rename task for newPath', async () => {
    const { OperationsManager } = await import('../src/operations/operations-manager');
    const oldPath = 'Docs/OldTitle.md';
    const newPath = 'Docs/NewTitle.md';
    const file = mockFile(newPath);

    const enqueuedTasks: any[] = [];
    const cancelledDebounces: string[] = [];
    const cleanedDirtyPaths: string[] = [];
    const recentNotesCache = new RecentNotesCache();

    recentNotesCache.set(oldPath, {
        path: oldPath,
        hash: 'sha256:original-content-hash',
        baseText: '# Original Title\n',
        diffDepth: 2,
        timestamp: 1000,
    });

    const mockApp: any = {
        vault: {
            getAbstractFileByPath: (p: string) => (p === newPath ? file : null),
        },
    };

    const taskFactory = new TaskFactory();

    const ops = new (OperationsManager as any)({
        app: mockApp,
        taskFactory,
        deviceManager: { getVaultId: () => 'vault-test', getDevice: () => 'dev-test' } as any,
        recentNotesCache,
        dirtyFileManager: {
            markClean: async (p: string) => { cleanedDirtyPaths.push(p); },
            markDirty: async () => {},
            load: async () => [],
        },
        debounceController: {
            cancel: (p: string) => { cancelledDebounces.push(p); },
            schedule: async () => {},
            flushAll: async () => {},
            flushFile: async () => {},
        },
        diffWorkerClient: {} as any,
        automaticQueueManager: {
            enqueue: async (t: any) => enqueuedTasks.push(t),
            getPendingCount: () => enqueuedTasks.length,
        } as any,
        reconstructionEngine: {} as any,
        getSettings: () => ({ monitoredExtensions: ['md'] } as any),
    });

    await ops.handleFileRename(file, oldPath);

    // Should emit 2 tasks: delete for oldPath, then rename for newPath
    assert.equal(enqueuedTasks.length, 2, 'Should enqueue both delete and rename tasks');

    const deleteTask = enqueuedTasks[0];
    assert.equal(deleteTask.path, oldPath);
    assert.equal(deleteTask.operation, 'delete');
    assert.equal(deleteTask.targetHash, 'sha256:original-content-hash');

    const renameUploadTask = enqueuedTasks[1];
    assert.equal(renameUploadTask.path, newPath);
    assert.equal(renameUploadTask.oldPath, oldPath);
    assert.equal(renameUploadTask.operation, 'rename');
    assert.equal(renameUploadTask.targetHash, 'sha256:original-content-hash');

    // Strict monotonic ordering: deleteTask timestamp must precede renameTask timestamp
    assert.ok(deleteTask.timestamp < renameUploadTask.timestamp, 'Delete timestamp must precede rename timestamp');

    // oldPath must be cleared from recentNotesCache, and newPath populated
    assert.equal(recentNotesCache.has(oldPath), false, 'oldPath must be removed from cache');
    assert.equal(recentNotesCache.has(newPath), true, 'newPath must be present in cache');
    assert.equal(recentNotesCache.get(newPath)!.hash, 'sha256:original-content-hash');

    // oldPath debounce and dirty state must be cancelled
    assert.ok(cancelledDebounces.includes(oldPath), 'Debounce on oldPath must be cancelled');
    assert.ok(cleanedDirtyPaths.includes(oldPath), 'oldPath must be marked clean in dirty journal');
});
});

describe('BackupFileOperation baseTextFromRemote', () => {
// Skipped: BackupFileOperation.baseTextFromRemote was removed in the refactor. Remote deletion handling for parentHash is now managed by PayloadPreparer and tested in tests/payload-preparer.test.ts.
test.skip('BackupFileOperation.baseTextFromRemote resets parentHash to null when latest remote entry is a deletion', async () => {
    const { BackupFileOperation } = await import('../src/operations/backup-file-op');
    const mockStore: any = {
        getEntriesWithObjects: async (vault: string, path: string) => {
            if (path === 'Resurrected.md') {
                return [
                    {
                        id: 'entry-del',
                        vault,
                        path: 'Resurrected.md',
                        operation: 'delete',
                        hash: 'sha256:old-dead-hash',
                        timestamp: 5000,
                        type: 'snapshot',
                        data: '# Old Deleted Text\n',
                    },
                    {
                        id: 'entry-save',
                        vault,
                        path: 'Resurrected.md',
                        operation: 'save',
                        hash: 'sha256:old-dead-hash',
                        timestamp: 4000,
                        type: 'snapshot',
                        data: '# Old Deleted Text\n',
                    },
                ];
            }
            return [];
        },
    };

    const taskFactory = new TaskFactory();
    const op: any = new (BackupFileOperation as any)({
        vault: {} as any,
        deviceManager: { getVaultId: () => 'vault-test', getDevice: () => 'dev-test' } as any,
        taskFactory,
        recentNotesCache: new RecentNotesCache(),
        dirtyFileManager: { markClean: async () => {}, markDirty: async () => {}, load: async () => [] },
        diffWorkerClient: {} as any,
        reconstructionEngine: {} as any,
        getSettings: () => ({ monitoredExtensions: ['md'] } as any),
        store: mockStore,
    });

    // 1. New content different from deleted content
    const resDifferent = await op.baseTextFromRemote('Resurrected.md', 'sha256:brand-new-hash', undefined, true, 'vault-test');
    assert.equal(resDifferent.kind, 'missing');
    assert.equal(resDifferent.baseText, null);
    assert.equal(resDifferent.parentHash, null);
    assert.equal(resDifferent.isUnchanged, false);
    assert.equal(resDifferent.prevTimestamp, 5000);

    // 2. Recreated with identical content to old deleted file: must NOT be skipped as unchanged!
    const resIdentical = await op.baseTextFromRemote('Resurrected.md', 'sha256:old-dead-hash', undefined, true, 'vault-test');
    assert.equal(resIdentical.kind, 'missing');
    assert.equal(resIdentical.baseText, null);
    assert.equal(resIdentical.parentHash, null);
    assert.equal(resIdentical.isUnchanged, false);
    assert.equal(resIdentical.prevTimestamp, 5000);
});
});

describe('Edge Cases', () => {
// Skipped: Legacy end-to-end rename and re-creation flow relied on 2-step queue emission and obsolete BackupFileOperation.execute options. This behavior is covered by tests/upload.test.ts and tests/payload-preparer.test.ts.
test.skip('Full cycle: A.md renamed to B.md, then new A.md created starts with parentHash = null snapshot', async () => {
    const { OperationsManager } = await import('../src/operations/operations-manager');
    const { BackupFileOperation } = await import('../src/operations/backup-file-op');

    // Simulate PocketBase remote entries
    const remoteEntries: Record<string, any[]> = {};

    const mockStore: any = {
        getEntriesWithObjects: async (vault: string, path: string) => {
            return remoteEntries[path] || [];
        },
        getLatestEntry: async (vault: string, path: string) => {
            const list = remoteEntries[path] || [];
            return list[0] || null;
        },
    };

    const enqueuedTasks: any[] = [];
    const recentNotesCache = new RecentNotesCache();

    // 1. Initial save of A.md
    const fileA = mockFile('A.md');
    const taskFactory = new TaskFactory();
    const mockApp: any = {
        vault: {
            getFiles: () => [fileA],
            getAbstractFileByPath: (p: string) => (p === 'A.md' ? fileA : null),
            cachedRead: async () => '# Initial A content\n',
        },
    };

    const ops = new (OperationsManager as any)({
        app: mockApp,
        taskFactory,
        deviceManager: { getVaultId: () => 'vault-test', getDevice: () => 'dev-test' } as any,
        recentNotesCache,
        dirtyFileManager: { markClean: async () => {}, markDirty: async () => {}, load: async () => [] },
        debounceController: { cancel: () => {}, schedule: async () => {}, flushAll: async () => {}, flushFile: async () => {} },
        diffWorkerClient: { computeDiff: async () => '' } as any,
        automaticQueueManager: {
            enqueue: async (t: any) => enqueuedTasks.push(t),
            getPendingCount: () => enqueuedTasks.length,
        } as any,
        reconstructionEngine: {} as any,
        getSettings: () => ({ monitoredExtensions: ['md'] } as any),
        store: mockStore,
    });

    // Populate remote entry for A.md (as if initial backup uploaded)
    const hashA1 = await Hasher.computeHash('# Initial A content\n');
    remoteEntries['A.md'] = [
        { id: 'entry-1', path: 'A.md', operation: 'save', hash: hashA1, timestamp: 1000, type: 'snapshot', data: '# Initial A content\n' },
    ];
    recentNotesCache.set('A.md', {
        path: 'A.md',
        hash: hashA1,
        baseText: '# Initial A content\n',
        diffDepth: 0,
        timestamp: 1000,
    });

    // 2. Rename A.md to B.md
    const fileB = mockFile('B.md');
    mockApp.vault.getAbstractFileByPath = (p: string) => (p === 'B.md' ? fileB : null);

    await ops.handleFileRename(fileB, 'A.md');

    assert.equal(enqueuedTasks.length, 2);
    const delTask = enqueuedTasks[0];
    const renTask = enqueuedTasks[1];
    assert.equal(delTask.operation, 'delete');
    assert.equal(delTask.path, 'A.md');
    assert.equal(renTask.operation, 'rename');
    assert.equal(renTask.path, 'B.md');

    // Simulate remote upload of the delete and rename tasks
    remoteEntries['A.md'].unshift({
        id: 'entry-del-A',
        path: 'A.md',
        operation: 'delete',
        hash: hashA1,
        timestamp: delTask.timestamp,
        type: 'snapshot',
    });
    remoteEntries['B.md'] = [
        { id: 'entry-ren-B', path: 'B.md', old_path: 'A.md', operation: 'rename', hash: hashA1, timestamp: renTask.timestamp, type: 'snapshot' },
    ];

    // 3. User creates a brand-new A.md
    const newFileA = mockFile('A.md');
    mockApp.vault.getAbstractFileByPath = (p: string) => (p === 'A.md' ? newFileA : null);
    mockApp.vault.cachedRead = async () => '# Completely new document\n';

    const newSaveTask: any = taskFactory.createSaveTask(newFileA);

    const backupFileOp: any = new (BackupFileOperation as any)({
        vault: mockApp.vault,
        deviceManager: { getVaultId: () => 'vault-test', getDevice: () => 'dev-test' } as any,
        taskFactory,
        recentNotesCache,
        dirtyFileManager: { markClean: async () => {}, markDirty: async () => {}, load: async () => [] },
        diffWorkerClient: { computeDiff: async () => '' } as any,
        reconstructionEngine: {} as any,
        getSettings: () => ({ monitoredExtensions: ['md'] } as any),
        store: mockStore,
    });

    const resultTask: any = await backupFileOp.execute({ source: 'debounce', task: newSaveTask }, {
        mode: 'auto',
        skipIfUnchanged: true,
        baseSource: 'cache-then-remote',
        updateRecentNotesCache: true,
    });

    assert.ok(resultTask !== null);
    assert.equal(resultTask!.operation, 'save');
    assert.equal(resultTask!.path, 'A.md');
    // Must be a full snapshot with parentHash = null!
    assert.equal(resultTask!.objectPayload?.type, 'snapshot');
    assert.equal(resultTask!.objectPayload?.parentHash, null);
});
});

describe('Step 6 Operations Decomposition: VaultBatchCoordinator', () => {
    test('VaultBatchCoordinator enforces mutual exclusion and rejects concurrent runs', async () => {
        const { VaultBatchCoordinator } = await import('../src/operations/vault-batch-coordinator');
        let unblockBackup: () => void = () => {};
        const backupGate = new Promise<void>((resolve) => {
            unblockBackup = resolve;
        });

        const mockBackupVaultOp: any = {
            execute: async () => {
                await backupGate;
                return { totalFiles: 1, processed: 1, uploaded: 1, unchanged: 0, skipped: 0, deleted: 0 };
            },
        };
        const mockSyncVaultOp: any = {
            execute: async () => ({ totalFiles: 0, processed: 0, uploaded: 0, unchanged: 0, skipped: 0, deleted: 0 }),
        };

        const coordinator = new VaultBatchCoordinator({
            automaticQueueManager: mockQueuePauseResume(),
            uploadCoordinator: mockUploadCoordinator(),
            batchFailureReportManager: mockBatchFailureReportManager(),
            backupVaultOp: mockBackupVaultOp,
            syncVaultOp: mockSyncVaultOp,
            getSettings: () => ({ batchConcurrency: 3 }),
        });

        assert.equal(coordinator.isOperationRunning(), false);
        const backupPromise = coordinator.backupVault();
        assert.equal(coordinator.isOperationRunning(), true);

        // Attempting concurrent sync should throw
        await assert.rejects(
            async () => coordinator.syncVault(),
            /already running/
        );

        unblockBackup();
        await backupPromise;
        assert.equal(coordinator.isOperationRunning(), false);
    });

    test('VaultBatchCoordinator pauses queue with manual-batch, waits for idle, and resumes on finish', async () => {
        const { VaultBatchCoordinator } = await import('../src/operations/vault-batch-coordinator');
        const pauseEvents: string[] = [];
        const resumeEvents: string[] = [];
        let idleWaited = false;

        const coordinator = new VaultBatchCoordinator({
            automaticQueueManager: {
                pause: (r?: string) => pauseEvents.push(r || ''),
                resume: (r?: string) => resumeEvents.push(r || ''),
            } as any,
            uploadCoordinator: {
                waitForIdle: async () => { idleWaited = true; },
                async runBatchSession (concurrency: number, sessionFn: any) {
                    await this.waitForIdle();
                    return await sessionFn();
                },
                isBatchActive: () => true,
            },
            backupVaultOp: {
                execute: async () => {
                    assert.equal(idleWaited, true, 'uploadCoordinator.waitForIdle must be called before op runs');
                    return { totalFiles: 2, processed: 2, uploaded: 2, unchanged: 0, skipped: 0, deleted: 0 };
                },
            } as any,
            syncVaultOp: {} as any,
            batchFailureReportManager: mockBatchFailureReportManager(),
            getSettings: () => ({ batchConcurrency: 3 }),
        });

        await coordinator.backupVault();
        assert.deepEqual(pauseEvents, ['manual-batch']);
        assert.deepEqual(resumeEvents, ['manual-batch']);
    });

    test('VaultBatchCoordinator runs guarded vault op inside uploadCoordinator.runBatchSession with configured concurrency', async () => {
        const { VaultBatchCoordinator } = await import('../src/operations/vault-batch-coordinator');
        let sessionConcurrency = 0;
        let opExecuted = false;

        const mockUploadCoordinator = {
            runBatchSession: async (concurrency: number, sessionFn: any) => {
                sessionConcurrency = concurrency;
                return sessionFn();
            },
        };


        const coordinator = new VaultBatchCoordinator({
            automaticQueueManager: mockQueuePauseResume(),
            uploadCoordinator: mockUploadCoordinator as any,
            batchFailureReportManager: mockBatchFailureReportManager(),
            getSettings: () => ({ batchConcurrency: 4 }),
            backupVaultOp: {
                execute: async () => {
                    opExecuted = true;
                    return { totalFiles: 1, processed: 1, uploaded: 1, unchanged: 0, skipped: 0, deleted: 0 };
                },
            } as any,
            syncVaultOp: {} as any,
        });

        const result = await coordinator.backupVault();
        assert.equal(result.uploaded, 1);
        assert.equal(sessionConcurrency, 4);
        assert.equal(opExecuted, true);
    });
});

describe('Step 6 Operations Decomposition: ManualFileOperation', () => {
    test('ManualFileOperation per-file mutex prevents concurrent executions and reschedules re-dirtied file', async () => {
        const { ManualFileOperation } = await import('../src/operations/manual-file-operation');
        const executedIntents: any[] = [];
        const scheduledTasks: any[] = [];

        let resolveFlight: () => void = () => {};
        const flightGate = new Promise<void>((resolve) => {
            resolveFlight = resolve;
        });

        const mockFileObj = mockFile('Notes/Debounced.md');
        const runner = {
            execute: async (intent: any) => {
                executedIntents.push(intent);
                await flightGate;
                return { status: 'uploaded' as const, intent };
            },
        };

        const taskFactory = new TaskFactory();
        const debounceController = {
            schedule: async (task: any) => { scheduledTasks.push(task); },
        };

        const manualOp = new ManualFileOperation({
            vault: { getAbstractFileByPath: () => mockFileObj } as any,
            runner,
            taskFactory,
            debounceController: debounceController as any,
        });

        // First manual backup triggers runner
        const flight1 = manualOp.backupFileNow(mockFileObj);

        // Second manual backup for same file while flight1 is running
        const flight2 = manualOp.backupFileNow(mockFileObj);

        // Unblock flight1 so both complete
        resolveFlight();
        const [flight1Result, flight2Result] = await Promise.all([flight1, flight2]);

        assert.ok(flight1Result);
        assert.equal(flight2Result, null);
        assert.equal(executedIntents.length, 1);

        // Post-execution reconciliation should have scheduled a modify task back to debounce
        assert.equal(scheduledTasks.length, 1);
        assert.equal(scheduledTasks[0].path, 'Notes/Debounced.md');
        // operation no longer in task
        // assert.equal(scheduledTasks[0].operation, 'save');
    });

    test('ManualFileOperation fast-fails with notice when batch session is active', async () => {
        const { ManualFileOperation } = await import('../src/operations/manual-file-operation');
        const mockFileObj = mockFile('Notes/Debounced.md');
        let runnerCalled = false;

        const manualOp = new ManualFileOperation({
            vault: { getAbstractFileByPath: () => mockFileObj } as any,
            runner: {
                execute: async () => {
                    runnerCalled = true;
                    return { status: 'uploaded' as const, intent: {} as any };
                },
            },
            taskFactory: new TaskFactory(),
            debounceController: { schedule: async () => {} } as any,
            uploadCoordinator: { isBatchActive: () => true },
        });

        const result = await manualOp.backupFileNow(mockFileObj);
        assert.equal(result, null);
        assert.equal(runnerCalled, false);
    });
});

describe('Step 6 Operations Decomposition: RetryFailedTaskOperation', () => {
    test('RetryFailedTaskOperation: invokes backupFileNow when targetHash matches current hash and removes record', async () => {
        const { RetryFailedTaskOperation } = await import('../src/operations/retry-failed-task-op');
        const content = '# Verified Content\n';
        const file = mockFile('Retry.md');
        const currentHash = await Hasher.computeHash(DiffEngine.normalizeNewlines(content));

        let backupModeCalled: string | null = null;
        const removedRecords: string[] = [];

        const retryOp = new RetryFailedTaskOperation({
            vault: {
                getAbstractFileByPath: () => file,
                cachedRead: async () => content,
            } as any,
            runner: { execute: async () => ({}) } as any,
            manualFileOp: {
                backupFileNow: async () => { backupModeCalled = 'auto'; },
                snapshotFileNow: async () => { backupModeCalled = 'snapshot'; },
            } as any,
            failedTasksManager: {
                remove: async (id: string) => { removedRecords.push(id); },
                updateFailedTask: async () => {},
            } as any,
        });

        const record: FailedTaskRecord = {
            id: 'failed-123',
            timestamp: Date.now(),
            stage: 'upload',
            attempts: 1,
            targetHash: currentHash,
            error: 'Test error',
            cause: { name: 'Error', message: 'Test error' },
            intent: {
                id: 'failed-123',
                trigger: 'auto',
                event: 'modify',
                operation: 'save',
                path: 'Retry.md',
                policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
            },
        };

        await retryOp.execute(record);
        assert.equal(backupModeCalled, 'auto');
        assert.deepEqual(removedRecords, ['failed-123']);
    });

    test('RetryFailedTaskOperation: invokes snapshotFileNow when current hash differs or targetHash is missing', async () => {
        const { RetryFailedTaskOperation } = await import('../src/operations/retry-failed-task-op');
        const content = '# Changed Content\n';
        const file = mockFile('RetryDiff.md');

        let backupModeCalled: string | null = null;
        const removedRecords: string[] = [];

        const retryOp = new RetryFailedTaskOperation({
            vault: {
                getAbstractFileByPath: () => file,
                cachedRead: async () => content,
            } as any,
            runner: { execute: async () => ({}) } as any,
            manualFileOp: {
                backupFileNow: async () => { backupModeCalled = 'auto'; },
                snapshotFileNow: async () => { backupModeCalled = 'snapshot'; },
            } as any,
            failedTasksManager: {
                remove: async (id: string) => { removedRecords.push(id); },
                updateFailedTask: async () => {},
            } as any,
        });

        const record: FailedTaskRecord = {
            id: 'failed-456',
            timestamp: Date.now(),
            stage: 'preparation',
            attempts: 1,
            error: 'Preparation error',
            cause: { name: 'Error', message: 'Preparation error' },
            // targetHash missing (preparation failure)
            intent: {
                id: 'failed-456',
                trigger: 'auto',
                event: 'modify',
                operation: 'save',
                path: 'RetryDiff.md',
                policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
            },
        };

        await retryOp.execute(record);
        assert.equal(backupModeCalled, 'snapshot');
        assert.deepEqual(removedRecords, ['failed-456']);
    });

    test('RetryFailedTaskOperation: preserves record and updates attempts/error upon retry failure', async () => {
        const { RetryFailedTaskOperation } = await import('../src/operations/retry-failed-task-op');
        const file = mockFile('FailAgain.md');
        const updatedRecords: any[] = [];
        const removedRecords: string[] = [];

        const retryOp = new RetryFailedTaskOperation({
            vault: {
                getAbstractFileByPath: () => file,
                cachedRead: async () => '# Content\n',
            } as any,
            runner: { execute: async () => ({}) } as any,
            manualFileOp: {
                backupFileNow: async () => { throw new Error('network down'); },
                snapshotFileNow: async () => {},
            } as any,
            failedTasksManager: {
                remove: async (id: string) => { removedRecords.push(id); },
                updateFailedTask: async (r: any) => { updatedRecords.push(r); },
            } as any,
        });

        const targetHash = await Hasher.computeHash('# Content\n');
        const record: FailedTaskRecord = {
            id: 'failed-789',
            timestamp: 1000,
            stage: 'upload',
            attempts: 1,
            targetHash,
            error: 'Upload error',
            cause: { name: 'Error', message: 'Upload error' },
            intent: {
                id: 'failed-789',
                trigger: 'auto',
                event: 'modify',
                operation: 'save',
                path: 'FailAgain.md',
                policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
            },
        };

        await assert.rejects(async () => retryOp.execute(record), /network down/);
        assert.deepEqual(removedRecords, []);
        assert.equal(updatedRecords.length, 1);
        assert.equal(updatedRecords[0].attempts, 2);
        assert.equal(updatedRecords[0].error, 'network down');
    });

    test('RetryFailedTaskOperation: fast-fails with notice when batch session is active', async () => {
        const { RetryFailedTaskOperation } = await import('../src/operations/retry-failed-task-op');
        let backupCalled = false;

        const retryOp = new RetryFailedTaskOperation({
            vault: {} as any,
            runner: { execute: async () => ({}) } as any,
            manualFileOp: {
                backupFileNow: async () => { backupCalled = true; },
                snapshotFileNow: async () => { backupCalled = true; },
            } as any,
            failedTasksManager: {
                remove: async () => true,
                updateFailedTask: async () => {},
            } as any,
            uploadCoordinator: { isBatchActive: () => true },
        });

        const record: FailedTaskRecord = {
            id: 'failed-active-batch',
            timestamp: 1000,
            stage: 'upload',
            attempts: 1,
            targetHash: 'hash',
            error: 'Upload error',
            cause: { name: 'Error', message: 'Upload error' },
            intent: {
                id: 'failed-active-batch',
                trigger: 'auto',
                event: 'modify',
                operation: 'save',
                path: 'Active.md',
                policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
            },
        };

        await retryOp.execute(record);
        assert.equal(backupCalled, false);
    });
});

describe('Step 6 Operations Decomposition: StartupRecoveryOperation Missing Rename Target', () => {
    test('StartupRecoveryOperation cleans target path, durably records DELETE on oldPath, and enqueues DeleteIntent', async (t: TestContext) => {
        t.mock.method(console, 'log', () => {});
        const cleanedPaths: string[] = [];
        const markedDirty: any[] = [];
        const enqueuedIntents: any[] = [];

        const dirtyEntries = [
            { operation: 'RENAME' as const, path: 'Docs/TargetMissing.md', oldPath: 'Docs/SourceOld.md', timestamp: 123 },
        ];

        const mockDirtyFileManager: any = {
            load: async () => dirtyEntries,
            markClean: async (p: string) => { cleanedPaths.push(p); },
            markDirty: async (op: string, p: string) => { markedDirty.push({ op, p }); },
            saveAll: async () => {},
        };

        const mockApp: any = {
            vault: {
                getAbstractFileByPath: () => null, // Target missing on disk
            },
        };

        const recoveryOp = new StartupRecoveryOperation({
            vault: mockApp.vault,
            dirtyFileManager: mockDirtyFileManager,
            queue: {
                enqueue: async (intent: any) => { enqueuedIntents.push(intent); },
            },
        });

        await recoveryOp.execute();

        // TargetMissing.md should be cleaned from abandoned rename
        assert.deepEqual(cleanedPaths, ['Docs/TargetMissing.md']);
        // SourceOld.md should be recorded as DELETE for crash durability
        assert.deepEqual(markedDirty, [{ op: 'DELETE', p: 'Docs/SourceOld.md' }]);
        // DeleteIntent enqueued for SourceOld.md
        assert.equal(enqueuedIntents.length, 1);
        assert.equal(enqueuedIntents[0].operation, 'delete');
        assert.equal(enqueuedIntents[0].path, 'Docs/SourceOld.md');
    });
});

describe('Step 6 Operations Decomposition: SyncVaultOperation Phase 2 Deletions', () => {
    test('SyncVaultOperation Phase 2 iterates remote records and executes DeleteIntent for missing local files', async () => {
        const { SyncVaultOperation } = await import('../src/operations/sync-vault-op');
        const executedIntents: any[] = [];

        const fileLocal = mockFile('Keep.md');
        const mockApp: any = {
            vault: {
                getFiles: () => [fileLocal],
                getAbstractFileByPath: (p: string) => (p === 'Keep.md' ? fileLocal : null),
                cachedRead: async () => '# Keep',
            },
        };

        const mockStore: any = {
            getLatestFiles: async () => [
                { path: 'Keep.md', operation: 'save', hash: 'h1', timestamp: 100 },
                { path: 'RemoteOrphan.md', operation: 'save', hash: 'h2', timestamp: 100 },
            ],
        };

        const syncOp = new SyncVaultOperation({
            vault: mockApp.vault,
            store: mockStore,
            deviceManager: { getVaultId: () => 'vault-sync-test', getDevice: () => 'dev-sync-test' } as any,
            getSettings: () => ({ monitoredExtensions: ['md'] } as any),
            runner: {
                execute: async (intent: any) => {
                    executedIntents.push(intent);
                    return { status: 'uploaded' as const, intent };
                },
            },
        });

        const result = await syncOp.execute();
        assert.equal(result.deleted, 1);
        const delIntent = executedIntents.find((it) => it.operation === 'delete');
        assert.ok(delIntent, 'Must have executed DeleteIntent');
        assert.equal(delIntent.path, 'RemoteOrphan.md');
        assert.equal(delIntent.trigger, 'manual');
        assert.equal(delIntent.event, 'vault-sync');
    });
});

describe('Step 6 Operations Decomposition: OperationsManager Folder Rename & Facade', () => {
    test('OperationsManager.handleFileRename expands TFolder recursively and enqueues RenameIntents', async () => {
        const { OperationsManager } = await import('../src/operations/operations-manager');
        const { RenameFileOperation } = await import('../src/operations/rename-file-op');
        const enqueuedIntents: any[] = [];
        const dirtyMarks: any[] = [];

        const rootFolder = new TFolder();
        rootFolder.path = 'Project';

        const fileA = mockFile('Project/DocA.md');
        const fileB = mockFile('Project/DocB.md');
        rootFolder.children = [fileA, fileB];

        const queue: any = {
            enqueue: async (intent: any) => { enqueuedIntents.push(intent); },
        };
        const dirtyFileManager: any = {
            markClean: async () => {},
            markDirty: async (op: string, p: string, old?: string) => {
                dirtyMarks.push({ op, p, old });
            },
        };
        const debounceController: any = { cancel: () => {}, flushAll: async () => {} };
        const getSettings = () => ({ monitoredExtensions: ['md'] } as any);

        const renameFileOp = new RenameFileOperation({
            queue,
            dirtyFileManager,
            debounceController,
            getSettings,
        });

        const manager = new OperationsManager({
            app: {
                vault: {
                    getAbstractFileByPath: (p: string) => (p === 'Project/DocA.md' ? fileA : p === 'Project/DocB.md' ? fileB : null),
                },
            } as any,
            deviceManager: { getVaultId: () => 'v-test', getDevice: () => 'd-test' } as any,
            taskFactory: new TaskFactory(),
            recentNotesCache: new RecentNotesCache(),
            dirtyFileManager,
            debounceController,
            diffWorkerClient: {} as any,
            reconstructionEngine: {} as any,
            getSettings,
            runner: { execute: async () => ({}) } as any,
            automaticQueueManager: queue,
            renameFileOp,
        } as any);

        await manager.handleFileRename(rootFolder, 'OldProject');

        assert.equal(enqueuedIntents.length, 2);
        assert.equal(enqueuedIntents[0].operation, 'rename');
        assert.equal(enqueuedIntents[0].path, 'Project/DocA.md');
        assert.equal(enqueuedIntents[0].oldPath, 'OldProject/DocA.md');

        assert.equal(enqueuedIntents[1].operation, 'rename');
        assert.equal(enqueuedIntents[1].path, 'Project/DocB.md');
        assert.equal(enqueuedIntents[1].oldPath, 'OldProject/DocB.md');

        assert.equal(dirtyMarks.length, 2);
        assert.equal(dirtyMarks[0].op, 'RENAME');
        assert.equal(dirtyMarks[0].p, 'Project/DocA.md');
        assert.equal(dirtyMarks[0].old, 'OldProject/DocA.md');
    });

    test('OperationsManager.handleFileRename on TFile to unmonitored extension cancels debounce, marks DELETE, and enqueues DeleteIntent', async () => {
        const { OperationsManager } = await import('../src/operations/operations-manager');
        const { RenameFileOperation } = await import('../src/operations/rename-file-op');
        const enqueuedIntents: any[] = [];
        const dirtyMarks: any[] = [];
        const cancelledDebounces: string[] = [];

        const unmonitoredFile = mockFile('Doc.png');

        const queue: any = {
            enqueue: async (intent: any) => { enqueuedIntents.push(intent); },
        };
        const dirtyFileManager: any = {
            markClean: async () => {},
            markDirty: async (op: string, p: string) => { dirtyMarks.push({ op, p }); },
        };
        const debounceController: any = {
            cancel: (p: string) => { cancelledDebounces.push(p); },
            flushAll: async () => {},
        };
        const getSettings = () => ({ monitoredExtensions: ['md'] } as any);

        const renameFileOp = new RenameFileOperation({
            queue,
            dirtyFileManager,
            debounceController,
            getSettings,
        });

        const manager = new OperationsManager({
            app: {} as any,
            deviceManager: { getVaultId: () => 'v-test', getDevice: () => 'd-test' } as any,
            taskFactory: new TaskFactory(),
            recentNotesCache: new RecentNotesCache(),
            dirtyFileManager,
            debounceController,
            diffWorkerClient: {} as any,
            reconstructionEngine: {} as any,
            getSettings,
            runner: { execute: async () => ({}) } as any,
            automaticQueueManager: queue,
            renameFileOp,
        } as any);

        await manager.handleFileRename(unmonitoredFile, 'Doc.md');

        assert.deepEqual(cancelledDebounces, ['Doc.md']);
        assert.deepEqual(dirtyMarks, [{ op: 'DELETE', p: 'Doc.md' }]);
        assert.equal(enqueuedIntents.length, 1);
        assert.equal(enqueuedIntents[0].operation, 'delete');
        assert.equal(enqueuedIntents[0].path, 'Doc.md');
    });
});
