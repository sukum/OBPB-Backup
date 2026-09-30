import { test, describe, TestContext } from 'node:test';
import assert from 'node:assert/strict';
// import { BatchRunner } from '../src/operations/batch-runner';
import { WorkerPoolRunner } from '../src/operations/worker-pool-runner';
import { SyncVaultOperation } from '../src/operations/sync-vault-op';
import type { PreparationContext } from '../src/preparation/types';
import { TFile, type Vault } from 'obsidian';
import type { BackupStore } from '../src/remote/backup-store';
import type { LatestVaultFilesViewRecord } from '../src/types/database';
import { DEFAULT_SETTINGS } from '../src/types/settings';
import type { SyncVaultContext, TaskRunner } from '../src/operations/types';

function createSyncVaultOperation(options: {
    files?: string[];
    remoteFiles?: LatestVaultFilesViewRecord[];
    getLatestFiles?: () => Promise<LatestVaultFilesViewRecord[]>;
    execute?: TaskRunner['execute'];
} = {}): SyncVaultOperation {
    const files = (options.files ?? []).map((path) => {
        const file = new TFile();
        file.path = path;
        return file;
    });
    const vaultPort = {
        getFiles: () => files,
        getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
    };
    // SyncVaultOperation only uses these two Vault methods in this test.
    const vault = vaultPort as unknown as Vault;
    const storePort = {
        getLatestFiles: options.getLatestFiles ?? (async () => options.remoteFiles ?? []),
    };
    // The operation under test only calls getLatestFiles on the remote store.
    const store = storePort as unknown as BackupStore;
    const runner: TaskRunner = {
        execute: options.execute ?? (async (intent) => ({ status: 'unchanged', intent })),
    };
    const context: SyncVaultContext = {
        vault,
        store,
        deviceManager: { getVaultId: () => 'vault', getDevice: () => 'device' },
        getSettings: () => ({ ...DEFAULT_SETTINGS, batchConcurrency: 10 }),
        runner,
    };

    return new SyncVaultOperation(context);
}

function latestFile(path: string): LatestVaultFilesViewRecord {
    return {
        id: `entry-${path}`,
        vault: 'vault',
        path,
        operation: 'save',
        timestamp: 1,
        hash: 'hash',
        objectId: 'object',
    };
}

describe('WorkerPoolRunner', () => {
test('WorkerPoolRunner counts uploaded, unchanged, skipped and failed outcomes distinctly', async (t: TestContext) => {
    t.mock.method(console, 'error', () => {});
    const outcomes = [
        { status: 'uploaded' as const, actionLabel: 'upload' },
        { status: 'unchanged' as const, actionLabel: 'unchanged' },
        { status: 'skipped' as const, actionLabel: 'skipped' },
        null,
    ];

    const result = await WorkerPoolRunner.run({
        items: ['uploaded', 'unchanged', 'skipped', 'empty', 'failed'],
        getItemPath: (path) => path,
        processItem: async (item) => {
            if (item === 'failed') throw new Error('upload failed');
            return outcomes[['uploaded', 'unchanged', 'skipped', 'empty'].indexOf(item)];
        },
    });

    assert.equal(result.uploaded, 1);
    assert.equal(result.unchanged, 1);
    assert.equal(result.skipped, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.processed, 5);
});

test('WorkerPoolRunner bounds concurrency across worker pool', async () => {
    let currentInFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 9 }, (_, i) => `file-${i}.md`);

    const result = await WorkerPoolRunner.run({
        items,
        concurrency: 3,
        getItemPath: (path) => path,
        processItem: async () => {
            currentInFlight++;
            maxInFlight = Math.max(maxInFlight, currentInFlight);
            await new Promise((r) => setTimeout(r, 20));
            currentInFlight--;
            return { status: 'uploaded', actionLabel: 'upload' };
        },
    });

    assert.equal(result.uploaded, 9);
    assert.equal(result.processed, 9);
    assert.equal(maxInFlight, 3);
});

test('WorkerPoolRunner halts worker loop when aborted', async () => {
    let processedCount = 0;
    let aborted = false;
    const items = Array.from({ length: 12 }, (_, i) => `file-${i}.md`);

    const result = await WorkerPoolRunner.run({
        items,
        concurrency: 2,
        getItemPath: (path) => path,
        isAborted: () => aborted,
        processItem: async () => {
            processedCount++;
            if (processedCount === 2) {
                aborted = true;
            }
            await new Promise((r) => setTimeout(r, 10));
            return { status: 'uploaded', actionLabel: 'upload' };
        },
    });

    assert.equal(result.stopped, true);
    assert.ok(result.processed < items.length);
    assert.equal(result.processed + (result.notAttempted ?? 0), items.length);
});

test('WorkerPoolRunner isolates failures across concurrent workers and records failures list', async (t: TestContext) => {
    t.mock.method(console, 'error', () => {});
    const items = ['ok1.md', 'fail1.md', 'ok2.md', 'fail2.md', 'ok3.md'];

    const result = await WorkerPoolRunner.run({
        items,
        concurrency: 3,
        getItemPath: (path) => path,
        processItem: async (item) => {
            await new Promise((r) => setTimeout(r, 10));
            if (item.startsWith('fail')) {
                throw new Error(`Error on ${item}`);
            }
            return { status: 'uploaded', actionLabel: 'upload' };
        },
    });

    assert.equal(result.uploaded, 3);
    assert.equal(result.failed, 2);
    assert.equal(result.processed, 5);
    assert.equal(result.failures?.length, 2);
    assert.equal(result.failures?.[0].path, 'fail1.md');
    assert.equal(result.failures?.[1].path, 'fail2.md');
});

test('WorkerPoolRunner counts deleted outcomes distinctly and supports operation delete', async (t: TestContext) => {
    t.mock.method(console, 'error', () => {});
    const items = ['del1.md', 'del2.md', 'fail.md'];

    const result = await WorkerPoolRunner.run({
        items,
        concurrency: 2,
        getItemPath: (path) => path,
        operation: 'delete',
        processItem: async (item) => {
            if (item === 'fail.md') throw new Error('delete failed');
            return { status: 'deleted' };
        },
    });

    assert.equal(result.deleted, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.processed, 3);
    assert.equal(result.failures?.[0].operation, 'delete');
    assert.equal(result.failures?.[0].reason, 'delete_error');
});

test('WorkerPoolRunner streams continuously across worker pool without batch barriers', async () => {
    const items = Array.from({ length: 7 }, (_, i) => `item-${i}.md`);
    const completedOrder: string[] = [];

    const result = await WorkerPoolRunner.run({
        items,
        concurrency: 2,
        getItemPath: (path) => path,
        processItem: async (item) => {
            completedOrder.push(item);
            return { status: 'uploaded' };
        },
    });

    assert.equal(result.uploaded, 7);
    assert.equal(result.processed, 7);
    assert.equal(completedOrder.length, 7);
});
});

describe('Sync vault operation', () => {
test('SyncVaultOperation reflects runner statuses instead of counting every resolved task as uploaded', async () => {
    const files = [{ path: 'unchanged.md' }, { path: 'ignored.md' }, { path: 'changed.md' }];
    const statuses = ['unchanged', 'skipped', 'uploaded'] as const;
    const contexts: Array<PreparationContext | undefined> = [];
    let index = 0;
    const operation = new SyncVaultOperation({
        vault: { getFiles: () => files, getAbstractFileByPath: () => null } as any,
        store: { getLatestFiles: async () => [] } as any,
        deviceManager: { getVaultId: () => 'vault', getDevice: () => 'device' },
        getSettings: () => ({ monitoredExtensions: ['md'], batchConcurrency: 10 } as any),
        runner: {
            execute: async (intent, context) => {
                contexts.push(context);
                return { status: statuses[index++], intent };
            },
        },
    });

    const result = await operation.execute();

    assert.equal(result.uploaded, 1);
    assert.equal(result.unchanged, 1);
    assert.equal(result.skipped, 1);
    assert.equal(contexts.length, files.length);
    assert.ok(contexts.every((context) => context?.disableRecentNotesCache === true));
    const bulkRemoteMap = contexts[0]?.bulkRemoteMap;
    assert.ok(bulkRemoteMap);
    assert.ok(contexts.every((context) => context?.bulkRemoteMap === bulkRemoteMap));
});

test('SyncVaultOperation does not count a skipped deletion as deleted', async () => {
    const operation = new SyncVaultOperation({
        vault: { getFiles: () => [], getAbstractFileByPath: () => null } as any,
        store: {
            getLatestFiles: async () => [{
                id: 'entry',
                vault: 'vault',
                path: 'missing.md',
                operation: 'save',
                timestamp: 1,
                hash: 'hash',
                objectId: 'object',
            }],
        } as any,
        deviceManager: { getVaultId: () => 'vault', getDevice: () => 'device' },
        getSettings: () => ({ monitoredExtensions: ['md'], batchConcurrency: 10 } as any),
        runner: {
            execute: async (intent) => ({ status: 'skipped', intent, reason: 'untracked_deletion' }),
        },
    });

    const result = await operation.execute();

    assert.equal(result.deleted, 0);
    assert.equal(result.skipped, 1);
});

test('SyncVaultOperation stops when it cannot load the remote listing', async () => {
    const listingError = new Error('Remote listing unavailable');
    let runnerCalled = false;
    const operation = createSyncVaultOperation({
        files: ['local.md'],
        getLatestFiles: async () => { throw listingError; },
        execute: async (intent) => {
            runnerCalled = true;
            return { status: 'uploaded', intent };
        },
    });

    await assert.rejects(operation.execute(), /Remote listing unavailable/);
    assert.equal(runnerCalled, false);
});

test('SyncVaultOperation includes failed remote deletions in its result', async (t) => {
    t.mock.method(console, 'error', () => {});
    const operation = createSyncVaultOperation({
        remoteFiles: [latestFile('remote-only.md')],
        execute: async () => { throw new Error('Delete publication failed'); },
    });

    const result = await operation.execute();

    assert.equal(result.totalFiles, 1, "Total files should be 1");
    assert.equal(result.processed, 1, "Processed files should be 1");
    assert.equal(result.failed, 1, "Failed files should be 1");
    assert.equal(result.failures?.length, 1, "Failures list should have 1 entry");
    const failure = result.failures?.[0];
    assert.equal(failure?.path, 'remote-only.md');
    assert.equal(failure?.operation, 'delete');
    assert.equal(failure?.reason, 'delete_error');
    assert.equal(failure?.error, 'Delete publication failed');
    assert.equal(typeof failure?.timestamp, 'number');
});
});
