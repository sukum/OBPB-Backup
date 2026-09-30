import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TFile, TFolder } from 'obsidian';
import { AutomaticQueueManager } from '../../../src/queue/automatic-queue-manager';
import { AutomaticQueueProcessor } from '../../../src/queue/automatic-queue-processor';
import { AutomaticQueueStore } from '../../../src/queue/automatic-queue-store';
import { DirtyFileManager } from '../../../src/state/dirty-file-manager';
import { RecentNotesCache } from '../../../src/state/recent-notes-cache';
import { PayloadPreparer } from '../../../src/preparation/payload-preparer';
import { SingleFileRunner } from '../../../src/runner/single-file-runner';
import { TaskUploader } from '../../../src/upload/task-uploader';
import { UploadCoordinator } from '../../../src/upload/upload-coordinator';
import { DeleteFileOperation } from '../../../src/operations/delete-file-op';
import { OperationsManager } from '../../../src/operations/operations-manager';
import { RenameFileOperation } from '../../../src/operations/rename-file-op';
import { StartupRecoveryOperation } from '../../../src/operations/startup-recovery-op';
import { SyncVaultOperation } from '../../../src/operations/sync-vault-op';
import { registerEvents } from '../../../src/vault/event-registry';
import { DebounceController } from '../../../src/vault/debounce-controller';
import { TaskFactory } from '../../../src/tasks/task-factory';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';
import type { TaskIntent } from '../../../src/operations/types';
import { DebounceController as MockDebounceController } from '../mocks';

interface MemoryDirtyStorage {
    read(name: string): Promise<string | null>;
    write(name: string, content: string): Promise<void>;
    append(name: string, content: string): Promise<void>;
    getContent(): string;
}

function createMemoryDirtyStorage(initialJournal = ''): MemoryDirtyStorage {
    let content = initialJournal;
    return {
        read: async () => content || null,
        write: async (_name, nextContent) => { content = nextContent; },
        append: async (_name, text) => { content += text; },
        getContent: () => content,
    };
}

function createFile(path: string): TFile {
    const file = new TFile();
    file.path = path;
    file.name = path.split('/').pop() || path;
    file.basename = file.name.replace(/\.[^/.]+$/, '');
    file.extension = path.split('.').pop() || '';
    return file;
}

interface DeletePipelineOptions {
    path: string;
    tracked?: boolean;
    initialJournal?: string;
    latestEntry?: Record<string, unknown> | null;
    objectLookupFailures?: number;
    connectivityChecker?: { healthCheck(): Promise<void> };
}

async function createDeletePipeline(options: DeletePipelineOptions) {
    const dirtyStorage = createMemoryDirtyStorage(options.initialJournal);
    const dirtyFileManager = new DirtyFileManager(dirtyStorage);
    await dirtyFileManager.load();

    const cache = new RecentNotesCache();
    if (options.tracked) {
        cache.set(options.path, {
            path: options.path,
            hash: 'sha256:prior-version',
            baseText: 'previous contents',
            diffDepth: 0,
            timestamp: 1000,
        });
    }

    const entries: any[] = [];
    const objectLookups: string[] = [];
    const latestEntryLookups: string[] = [];
    let objectLookupFailures = options.objectLookupFailures ?? 0;
    const store: any = {
        getLatestEntry: async (_vault: string, path: string) => {
            latestEntryLookups.push(path);
            return options.latestEntry ?? null;
        },
        getObject: async (_vault: string, hash: string) => {
            objectLookups.push(hash);
            if (objectLookupFailures > 0) {
                objectLookupFailures--;
                throw new Error('Network unavailable');
            }
            return { id: 'object-prior-version', hash, vault: 'vault-test' };
        },
        addEntry: async (entry: any) => { entries.push(entry); },
    };

    const app: any = {
        vault: {
            getAbstractFileByPath: () => null,
            cachedRead: async () => '',
        },
    };
    const logger = { record: () => {} };
    const deviceManager = {
        getVaultId: () => 'vault-test',
        getDevice: () => 'device-test',
    };

    const preparer = new PayloadPreparer({
        vault: app.vault,
        deviceManager,
        cache,
        store,
        diffComputer: { computeDiff: async () => '' },
        reconstructionEngine: { reconstructVersion: async () => '' } as any,
        getSettings: () => ({ ...DEFAULT_SETTINGS, monitoredExtensions: ['md'] }),
    });
    const runner = new SingleFileRunner(
        preparer,
        new UploadCoordinator(),
        new TaskUploader(store),
        dirtyFileManager,
        cache,
        logger
    );
    const queueStore = new AutomaticQueueStore(logger);
    const processor = new AutomaticQueueProcessor(queueStore, runner, logger, {
        connectivityChecker: options.connectivityChecker,
        failedTasksManager: { recordTerminalFailure: async () => {} } as any,
        recentNotesCache: cache,
        dirtyFileMarker: dirtyFileManager,
    });
    const queueManager = new AutomaticQueueManager(queueStore, processor);
    await queueManager.initialize();

    return {
        app,
        cache,
        dirtyFileManager,
        dirtyStorage,
        entries,
        latestEntryLookups,
        objectLookups,
        processor,
        queueManager,
        queueStore,
        store,
    };
}

function createDeleteFacade(
    pipeline: Awaited<ReturnType<typeof createDeletePipeline>>,
    cancel: (path: string) => void = () => {}
): OperationsManager {
    const deleteFileOp = new DeleteFileOperation({
        queue: pipeline.queueManager,
        dirtyFileManager: pipeline.dirtyFileManager,
        debounceController: new MockDebounceController(cancel),
    });
    return new OperationsManager({ deleteFileOp } as any);
}

describe('Delete success flows', () => {
    test('delete event ignores folders and routes a tracked file through OperationsManager to a published delete entry', async () => {
        const path = 'Notes/Deleted.md';
        const pipeline = await createDeletePipeline({ path, tracked: true });
        const cancelledPaths: string[] = [];
        const operationsManager = createDeleteFacade(pipeline, (p) => cancelledPaths.push(p));
        const listeners = new Map<string, (...args: any[]) => Promise<void>>();
        const taskFactory = new TaskFactory();
        const mockPlugin: any = {
            app: {
                vault: {
                    on: (event: string, callback: (...args: any[]) => Promise<void>) => {
                        listeners.set(event, callback);
                        return { event, callback };
                    },
                },
                workspace: { on: () => ({}) },
            },
            settings: { monitoredExtensions: ['md'] },
            registerEvent: () => {},
            registerDomEvent: () => {},
        };
        const mockContainer: any = {
            resolve: (token: unknown) => {
                if (token === OperationsManager) return operationsManager;
                if (token === DebounceController) return { flushAll: async () => {} };
                if (token === TaskFactory) return taskFactory;
                throw new Error(`Unexpected dependency token: ${String(token)}`);
            },
        };

        registerEvents(mockPlugin, mockContainer);
        const deleteHandler = listeners.get('delete');
        assert.ok(deleteHandler, 'delete event handler should be registered');

        const folder = new TFolder();
        folder.path = 'Notes/Folder';
        await deleteHandler!(folder);
        assert.equal(pipeline.queueStore.count(), 0, 'folder deletion should not enqueue a task');
        assert.equal(cancelledPaths.length, 0);

        await deleteHandler!(createFile(path));

        assert.deepEqual(cancelledPaths, [path]);
        assert.equal(pipeline.entries.length, 1);
        assert.equal(pipeline.entries[0].operation, 'delete');
        assert.equal(pipeline.entries[0].path, path);
        assert.equal(pipeline.entries[0].objectId, 'object-prior-version');
        assert.equal(pipeline.objectLookups[0], 'sha256:prior-version');
        assert.equal(pipeline.queueStore.count(), 0, 'successful queue task should be acknowledged');
        assert.deepEqual(pipeline.dirtyFileManager.getEntries(), []);
        assert.equal(pipeline.cache.has(path), false);
    });

    test('untracked file deletion is skipped, acknowledged, and removed from the dirty journal', async () => {
        const path = 'Notes/Untracked.md';
        const pipeline = await createDeletePipeline({ path });
        const operationsManager = createDeleteFacade(pipeline);
        await operationsManager.handleFileDelete(path);

        assert.deepEqual(pipeline.latestEntryLookups, [path]);
        assert.equal(pipeline.entries.length, 0);
        assert.equal(pipeline.objectLookups.length, 0);
        assert.equal(pipeline.queueStore.count(), 0);
        assert.deepEqual(pipeline.dirtyFileManager.getEntries(), []);
    });

    test('a path whose latest remote entry is already deleted is skipped without publishing another delete', async () => {
        const path = 'Notes/AlreadyDeleted.md';
        const pipeline = await createDeletePipeline({
            path,
            latestEntry: { path, operation: 'delete', hash: 'sha256:prior-version', timestamp: 1000 },
        });
        const operationsManager = createDeleteFacade(pipeline);
        await operationsManager.handleFileDelete(path);

        assert.equal(pipeline.latestEntryLookups.length, 1);
        assert.equal(pipeline.entries.length, 0);
        assert.equal(pipeline.objectLookups.length, 0);
        assert.equal(pipeline.queueStore.count(), 0);
        assert.deepEqual(pipeline.dirtyFileManager.getEntries(), []);
    });

    test('startup recovery replays a dirty DELETE and completes it through the automatic queue', async () => {
        const path = 'Notes/RecoveredDelete.md';
        const pipeline = await createDeletePipeline({
            path,
            tracked: true,
            initialJournal: `DELETE\t${path}\n`,
        });
        pipeline.queueManager.pause('boot');

        const recovery = new StartupRecoveryOperation({
            vault: pipeline.app.vault,
            dirtyFileManager: pipeline.dirtyFileManager,
            queue: pipeline.queueManager,
        });
        const operationsManager = new OperationsManager({ startupRecoveryOp: recovery } as any);

        await operationsManager.runStartupRecovery();
        assert.equal(pipeline.queueStore.count(), 1);
        assert.equal(pipeline.queueStore.peek()?.intent.operation, 'delete');
        assert.deepEqual(pipeline.dirtyFileManager.getEntries(), [{ operation: 'DELETE', path }]);

        pipeline.queueManager.resume('boot');
        await pipeline.queueManager.process();

        assert.equal(pipeline.entries.length, 1);
        assert.equal(pipeline.entries[0].operation, 'delete');
        assert.equal(pipeline.queueStore.count(), 0);
        assert.deepEqual(pipeline.dirtyFileManager.getEntries(), []);
    });

    test('renaming a monitored file to an unmonitored extension queues a delete for its old path', async () => {
        const newPath = 'Notes/Report.pdf';
        const oldPath = 'Notes/Report.md';
        const dirtyMarks: Array<{ operation: string; path: string }> = [];
        const cancelledPaths: string[] = [];
        const enqueued: TaskIntent[] = [];
        const renameFileOp = new RenameFileOperation({
            queue: { enqueue: async (intent: TaskIntent) => { enqueued.push(intent); } },
            dirtyFileManager: {
                markDirty: async (operation: string, path: string) => { dirtyMarks.push({ operation, path }); },
            } as any,
            debounceController: { cancel: (path: string) => { cancelledPaths.push(path); } } as any,
            getSettings: () => ({ monitoredExtensions: ['md'] } as any),
        });
        const operationsManager = new OperationsManager({ renameFileOp } as any);

        await operationsManager.handleFileRename(createFile(newPath), oldPath);

        assert.deepEqual(cancelledPaths, [oldPath]);
        assert.deepEqual(dirtyMarks, [{ operation: 'DELETE', path: oldPath }]);
        assert.equal(enqueued.length, 1);
        assert.equal(enqueued[0].trigger, 'auto');
        assert.equal(enqueued[0].event, 'delete');
        assert.equal(enqueued[0].operation, 'delete');
        assert.equal(enqueued[0].path, oldPath);
    });

    test('vault sync records a delete for a remote-active file missing from disk', async () => {
        const executed: TaskIntent[] = [];
        const sync = new SyncVaultOperation({
            vault: { getFiles: () => [], getAbstractFileByPath: () => null } as any,
            deviceManager: { getVaultId: () => 'vault-test', getDevice: () => 'device-test' },
            getSettings: () => ({ ...DEFAULT_SETTINGS, monitoredExtensions: ['md'], batchConcurrency: 10 }),
            store: {
                getLatestFiles: async () => [{
                    vault: 'vault-test',
                    path: 'Notes/RemoteOnly.md',
                    hash: 'sha256:remote',
                    timestamp: 1000,
                    operation: 'save',
                }],
            } as any,
            runner: {
                execute: async (intent: TaskIntent) => {
                    executed.push(intent);
                    return { status: 'uploaded', intent };
                },
            },
        });

        const result = await sync.execute();

        assert.equal(executed.length, 1);
        assert.equal(executed[0].trigger, 'manual');
        assert.equal(executed[0].event, 'vault-sync');
        assert.equal(executed[0].operation, 'delete');
        assert.equal(executed[0].path, 'Notes/RemoteOnly.md');
        assert.equal(result.deleted, 1);
    });

    test('delete resumes and publishes after connectivity returns', async () => {
        const path = 'Notes/OfflineDelete.md';
        let online = false;
        const pipeline = await createDeletePipeline({
            path,
            tracked: true,
            objectLookupFailures: 1,
            connectivityChecker: {
                healthCheck: async () => {
                    if (!online) throw new Error('Still offline');
                },
            },
        });
        const operationsManager = createDeleteFacade(pipeline);

        const nativeSetTimeout = globalThis.setTimeout;
        const nativeClearTimeout = globalThis.clearTimeout;
        const scheduled: Array<{ id: number; delay: number; callback: () => unknown }> = [];
        const cancelled = new Set<number>();
        (globalThis as any).setTimeout = (callback: () => unknown, delay = 0) => {
            const id = scheduled.length + 1;
            scheduled.push({ id, delay, callback });
            return id;
        };
        (globalThis as any).clearTimeout = (id: number) => { cancelled.add(id); };

        try {
            await operationsManager.handleFileDelete(path);

            assert.equal(pipeline.objectLookups.length, 1);
            assert.equal(pipeline.queueManager.isPaused(), true);
            assert.equal(pipeline.queueStore.count(), 1);
            assert.equal(pipeline.dirtyFileManager.isDirty(path), true);

            const probe = scheduled.find((timer) => timer.delay === 5_000 && !cancelled.has(timer.id));
            assert.ok(probe, 'connectivity monitor should schedule a recovery probe');
            online = true;
            await probe!.callback();
            await pipeline.queueManager.process();

            assert.equal(pipeline.objectLookups.length, 2);
            assert.equal(pipeline.entries.length, 1);
            assert.equal(pipeline.entries[0].operation, 'delete');
            assert.equal(pipeline.entries[0].path, path);
            assert.equal(pipeline.queueManager.isPaused(), false);
            assert.equal(pipeline.queueStore.count(), 0);
            assert.equal(pipeline.dirtyFileManager.isDirty(path), false);
        } finally {
            pipeline.queueManager.destroy();
            globalThis.setTimeout = nativeSetTimeout;
            globalThis.clearTimeout = nativeClearTimeout;
        }
    });
});
