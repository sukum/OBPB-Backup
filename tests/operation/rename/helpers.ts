import { TFile, TFolder } from 'obsidian';
import type { TaskIntent } from '../../../src/operations/types';
import { DeleteFileOperation } from '../../../src/operations/delete-file-op';
import { OperationsManager } from '../../../src/operations/operations-manager';
import { RenameFileOperation } from '../../../src/operations/rename-file-op';
import { AutomaticQueueManager } from '../../../src/queue/automatic-queue-manager';
import { AutomaticQueueProcessor } from '../../../src/queue/automatic-queue-processor';
import { AutomaticQueueStore } from '../../../src/queue/automatic-queue-store';
import { DirtyFileManager } from '../../../src/state/dirty-file-manager';
import { RecentNotesCache } from '../../../src/state/recent-notes-cache';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';
import { DebounceController } from '../../../src/vault/debounce-controller';
import { TaskFactory } from '../../../src/tasks/task-factory';
import { registerEvents } from '../../../src/vault/event-registry';
import { PayloadPreparer } from '../../../src/preparation/payload-preparer';
import { SingleFileRunner } from '../../../src/runner/single-file-runner';
import { TaskUploader } from '../../../src/upload/task-uploader';
import { UploadCoordinator } from '../../../src/upload/upload-coordinator';
import { DebounceController as MockDebounceController } from '../mocks';


export interface MemoryDirtyStorage {
    read(name: string): Promise<string | null>;
    write(name: string, content: string): Promise<void>;
    append(name: string, content: string): Promise<void>;
    getContent(): string;
}

export function createMemoryDirtyStorage(initialContent = ''): MemoryDirtyStorage {
    let content = initialContent;
    return {
        read: async () => content || null,
        write: async (_name, nextContent) => { content = nextContent; },
        append: async (_name, text) => { content += text; },
        getContent: () => content,
    };
}

export function createFile(path: string): TFile {
    const file = new TFile();
    file.path = path;
    file.name = path.split('/').pop() || path;
    file.basename = file.name.replace(/\.[^/.]+$/, '');
    file.extension = path.split('.').pop() || '';
    file.stat = { size: 1, mtime: 1, ctime: 1 };
    return file;
}

export function createFolder(path: string, children: Array<TFile | TFolder> = []): TFolder {
    const folder = new TFolder();
    folder.path = path;
    folder.name = path.split('/').pop() || path;
    folder.children = children;
    return folder;
}

export interface QueueHarnessOptions {
    execute?: (intent: TaskIntent) => Promise<unknown>;
    connectivityChecker?: { healthCheck(): Promise<void> };
    monitoredExtensions?: string[];
    initialJournal?: string;
    files?: Map<string, TFile>;
    debounceController?: { cancel(path: string): void };
}

export async function createQueueHarness(options: QueueHarnessOptions = {}) {
    const dirtyStorage = createMemoryDirtyStorage(options.initialJournal);
    const dirtyFileManager = new DirtyFileManager(dirtyStorage);
    await dirtyFileManager.load();
    const cache = new RecentNotesCache();
    const queueStore = new AutomaticQueueStore({ record: () => {} });
    const failedTasks: Array<Record<string, unknown>> = [];
    const processor = new AutomaticQueueProcessor(
        queueStore,
        {
            execute: async (intent: TaskIntent) => {
                const result = await (options.execute ?? (async () => ({ status: 'uploaded', intent })))(intent);
                await dirtyFileManager.markClean(intent.path);
                if (intent.operation === 'rename') {
                    await dirtyFileManager.markClean(intent.oldPath);
                }
                return result as any;
            },
        },
        { record: () => {} },
        {
            connectivityChecker: options.connectivityChecker,
            failedTasksManager: {
                recordTerminalFailure: async (record: Record<string, unknown>) => { failedTasks.push(record); },
            } as any,
            recentNotesCache: cache,
            dirtyFileMarker: dirtyFileManager,
        }
    );
    const queueManager = new AutomaticQueueManager(queueStore, processor);
    await queueManager.initialize();

    const cancelledPaths: string[] = [];
    const debounceController = options.debounceController ?? {
        cancel: (path: string) => { cancelledPaths.push(path); },
    };
    const renameFileOp = new RenameFileOperation({
        queue: queueManager,
        dirtyFileManager,
        debounceController: debounceController as any,
        getSettings: () => ({
            ...DEFAULT_SETTINGS,
            monitoredExtensions: options.monitoredExtensions ?? ['md'],
        }),
    });
    const deleteFileOp = new DeleteFileOperation({
        queue: queueManager,
        dirtyFileManager,
        debounceController: debounceController as any,
    });
    const operationsManager = new OperationsManager({
        renameFileOp,
        deleteFileOp,
        automaticQueueManager: queueManager,
    } as any);

    const listeners = new Map<string, (...args: any[]) => Promise<void>>();
    const plugin: any = {
        app: {
            vault: {
                on: (event: string, callback: (...args: any[]) => Promise<void>) => {
                    listeners.set(event, callback);
                    return { event, callback };
                },
                getAbstractFileByPath: (path: string) => options.files?.get(path) ?? null,
            },
            workspace: { on: () => ({}) },
        },
        settings: { monitoredExtensions: options.monitoredExtensions ?? ['md'] },
        registerEvent: () => {},
        registerDomEvent: () => {},
    };
    const container: any = {
        resolve: (token: unknown) => {
            if (token === OperationsManager) return operationsManager;
            if (token === DebounceController) return { flushAll: async () => {} };
            if (token === TaskFactory) return new TaskFactory();
            throw new Error(`Unexpected dependency token: ${String(token)}`);
        },
    };
    registerEvents(plugin, container);

    return {
        cancelledPaths,
        cache,
        dirtyFileManager,
        dirtyStorage,
        failedTasks,
        listeners,
        operationsManager,
        processor,
        queueManager,
        queueStore,
    };
}

export interface UploadHarnessOptions {
    files?: Map<string, TFile>;
    contents?: Map<string, string>;
    history?: Array<Record<string, any>>;
    monitoredExtensions?: string[];
}

export async function createUploadHarness(options: UploadHarnessOptions = {}) {
    const dirtyFileManager = new DirtyFileManager(createMemoryDirtyStorage());
    await dirtyFileManager.load();
    const cache = new RecentNotesCache();
    const entries = [...(options.history ?? [])];
    const objects: Array<Record<string, any>> = [];
    const latestLookups: string[] = [];
    const fileMap = options.files ?? new Map<string, TFile>();
    const contents = options.contents ?? new Map<string, string>();
    const store: any = {
        getLatestEntry: async (_vault: string, path: string) => {
            latestLookups.push(path);
            return entries.filter((entry) => entry.path === path)
                .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0] ?? null;
        },
        getLatestFiles: async () => [],
        getObject: async (_vault: string, hash: string) => ({ id: `object-${hash}`, hash, vault: 'vault-test' }),
        putObject: async (object: Record<string, any>) => { objects.push(object); },
        addEntry: async (entry: Record<string, any>) => { entries.push(entry); },
    };
    const vault: any = {
        getAbstractFileByPath: (path: string) => fileMap.get(path) ?? null,
        cachedRead: async (file: TFile) => contents.get(file.path) ?? '',
        getFiles: () => Array.from(fileMap.values()),
    };
    const deviceManager = {
        getVaultId: () => 'vault-test',
        getDevice: () => 'device-test',
    };
    const settings = {
        ...DEFAULT_SETTINGS,
        monitoredExtensions: options.monitoredExtensions ?? ['md'],
    };
    const preparer = new PayloadPreparer({
        vault,
        deviceManager,
        cache,
        store,
        diffComputer: { computeDiff: async () => '' },
        reconstructionEngine: { reconstructVersion: async () => '' } as any,
        getSettings: () => settings,
    });
    const runner = new SingleFileRunner(
        preparer,
        new UploadCoordinator(),
        new TaskUploader(store),
        dirtyFileManager,
        cache,
        { record: () => {} }
    );
    const queueStore = new AutomaticQueueStore({ record: () => {} });
    const failedTasks: Array<Record<string, unknown>> = [];
    const processor = new AutomaticQueueProcessor(queueStore, runner, { record: () => {} }, {
        failedTasksManager: {
            recordTerminalFailure: async (record: Record<string, unknown>) => { failedTasks.push(record); },
        } as any,
        recentNotesCache: cache,
        dirtyFileMarker: dirtyFileManager,
    });
    const queueManager = new AutomaticQueueManager(queueStore, processor);
    await queueManager.initialize();
    const renameFileOp = new RenameFileOperation({
        queue: queueManager,
        dirtyFileManager,
        debounceController: new MockDebounceController(),
        getSettings: () => settings,
    });
    const operationsManager = new OperationsManager({ renameFileOp } as any);

    return {
        cache,
        dirtyFileManager,
        entries,
        failedTasks,
        latestLookups,
        objects,
        operationsManager,
        preparer,
        processor,
        queueManager,
        queueStore,
        store,
    };
}
