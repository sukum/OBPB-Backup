import { TFile } from 'obsidian';
import type { TaskIntent } from '../../../src/operations/types';
import { BackupFileOperation } from '../../../src/operations/backup-file-op';
import { DeleteFileOperation } from '../../../src/operations/delete-file-op';
import { OperationsManager } from '../../../src/operations/operations-manager';
import { RenameFileOperation } from '../../../src/operations/rename-file-op';
import { AutomaticQueueManager } from '../../../src/queue/automatic-queue-manager';
import { AutomaticQueueProcessor } from '../../../src/queue/automatic-queue-processor';
import { AutomaticQueueStore } from '../../../src/queue/automatic-queue-store';
import { DirtyFileManager } from '../../../src/state/dirty-file-manager';
import { RecentNotesCache } from '../../../src/state/recent-notes-cache';
import { DEFAULT_SETTINGS, type PBBackupSettings } from '../../../src/types/settings';
import { DebounceController } from '../../../src/vault/debounce-controller';
import { TaskFactory } from '../../../src/tasks/task-factory';
import { registerEvents } from '../../../src/vault/event-registry';
import { PayloadPreparer } from '../../../src/preparation/payload-preparer';
import type { PayloadPreparerDependencies } from '../../../src/preparation/types';
import type { EntriesWithObjectsViewRecord } from '../../../src/types/database';

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
    file.stat = { size: 0, mtime: 1, ctime: 1 };
    return file;
}

export interface ModifyHarnessOptions {
    execute?: (intent: TaskIntent) => Promise<unknown>;
    connectivityChecker?: { healthCheck(): Promise<void> };
    monitoredExtensions?: string[];
    initialJournal?: string;
    files?: Map<string, TFile>;
    debounceIntervalMs?: number;
    maxWaitMs?: number;
}

/** Real event, debounce, intent, journal, and queue wiring with a controllable runner. */
export async function createModifyHarness(options: ModifyHarnessOptions = {}) {
    const dirtyStorage = createMemoryDirtyStorage(options.initialJournal);
    const dirtyFileManager = new DirtyFileManager(dirtyStorage);
    await dirtyFileManager.load();
    const files = options.files ?? new Map<string, TFile>();
    const monitoredExtensions = options.monitoredExtensions ?? ['md'];
    const app: any = {
        vault: {
            getAbstractFileByPath: (path: string) => files.get(path) ?? null,
            on: undefined,
        },
        workspace: {},
    };
    const executions: TaskIntent[] = [];
    const cache = new RecentNotesCache();
    const queueStore = new AutomaticQueueStore({ record: () => {} });
    const failedTasks: Array<Record<string, unknown>> = [];
    const processor = new AutomaticQueueProcessor(
        queueStore,
        {
            execute: async (intent: TaskIntent) => {
                executions.push({ ...intent });
                dirtyFileManager.beginFlight(intent.path);
                try {
                    const result = await (options.execute ?? (async () => ({ status: 'uploaded', intent })))(intent);
                    await dirtyFileManager.markClean(intent.path);
                    if (intent.operation === 'rename') await dirtyFileManager.markClean(intent.oldPath);
                    return result as any;
                } finally {
                    dirtyFileManager.endFlight(intent.path);
                }
            },
        },
        { record: () => {} },
        {
            connectivityChecker: options.connectivityChecker,
            failedTasksManager: {
                recordTerminalFailure: async (record: Record<string, unknown>) => { failedTasks.push(record); },
                debouncedWriteDelay: 100,
            } as any,
            recentNotesCache: cache,
            dirtyFileMarker: dirtyFileManager,
        }
    );
    const queueManager = new AutomaticQueueManager(queueStore, processor);
    await queueManager.initialize();

    const backupFileOp = new BackupFileOperation({ vault: app.vault, queue: queueManager });
    let operationsManager!: OperationsManager;
    const debounceController = new DebounceController(
        dirtyFileManager,
        options.debounceIntervalMs ?? 5_000,
        options.maxWaitMs ?? 300_000,
        async (task) => operationsManager.processDebouncedFile(task)
    );
    const deleteFileOp = new DeleteFileOperation({
        queue: queueManager,
        dirtyFileManager,
        debounceController,
    });
    const renameFileOp = new RenameFileOperation({
        queue: queueManager,
        dirtyFileManager,
        debounceController,
        getSettings: () => ({ ...DEFAULT_SETTINGS, monitoredExtensions }),
    });
    operationsManager = new OperationsManager({
        app,
        getSettings: () => ({ ...DEFAULT_SETTINGS, monitoredExtensions }),
        automaticQueueManager: queueManager,
        debounceController,
        backupFileOp,
        deleteFileOp,
        renameFileOp,
    } as any);

    const listeners = new Map<string, (...args: any[]) => Promise<void>>();
    const workspaceListeners = new Map<string, (...args: any[]) => unknown>();
    const domListeners = new Map<string, (...args: any[]) => unknown>();
    app.vault.on = (event: string, callback: (...args: any[]) => Promise<void>) => {
        listeners.set(event, callback);
        return { event, callback };
    };
    app.workspace.on = (event: string, callback: (...args: any[]) => unknown) => {
        workspaceListeners.set(event, callback);
        return { event, callback };
    };
    const plugin: any = {
        app,
        settings: { monitoredExtensions },
        registerEvent: () => {},
        registerDomEvent: (_target: unknown, event: string, callback: (...args: any[]) => unknown) => {
            domListeners.set(event, callback);
        },
    };
    const container: any = {
        resolve: (token: unknown) => {
            if (token === OperationsManager) return operationsManager;
            if (token === DebounceController) return debounceController;
            if (token === TaskFactory) return new TaskFactory();
            throw new Error(`Unexpected dependency token: ${String(token)}`);
        },
    };
    registerEvents(plugin, container);

    return {
        app,
        cache,
        debounceController,
        dirtyFileManager,
        dirtyStorage,
        domListeners,
        executions,
        failedTasks,
        listeners,
        operationsManager,
        processor,
        queueManager,
        queueStore,
        workspaceListeners,
    };
}

export interface SavePreparationOptions {
    files?: Map<string, TFile>;
    contents?: Map<string, string>;
    monitoredExtensions?: string[];
    settings?: Partial<PBBackupSettings>;
    cache?: RecentNotesCache;
    remoteEntries?: EntriesWithObjectsViewRecord[];
    getEntriesWithObjects?: (vault: string, path: string, limit: number) => Promise<EntriesWithObjectsViewRecord[]>;
    diffComputer?: PayloadPreparerDependencies['diffComputer'];
}

export function createSavePreparationHarness(options: SavePreparationOptions = {}) {
    const files = options.files ?? new Map<string, TFile>();
    const contents = options.contents ?? new Map<string, string>();
    const cache = options.cache ?? new RecentNotesCache();
    const settings = {
        ...DEFAULT_SETTINGS,
        ...options.settings,
        monitoredExtensions: options.monitoredExtensions ?? options.settings?.monitoredExtensions ?? ['md'],
    };
    const latestLookups: string[] = [];
    const store: any = {
        getEntriesWithObjects: options.getEntriesWithObjects ?? (async (_vault: string, path: string) => {
            latestLookups.push(path);
            return options.remoteEntries ?? [];
        }),
        getLatestEntry: async () => null,
        getObject: async (_vault: string, hash: string) => ({ id: `object-${hash}`, hash, vault: 'vault-test' }),
        putObject: async () => {},
        addEntry: async () => {},
    };
    const vault: any = {
        getAbstractFileByPath: (path: string) => files.get(path) ?? null,
        cachedRead: async (file: TFile) => contents.get(file.path) ?? '',
    };
    const preparer = new PayloadPreparer({
        vault,
        deviceManager: { getVaultId: () => 'vault-test', getDevice: () => 'device-test' },
        cache,
        store,
        diffComputer: options.diffComputer ?? { computeDiff: async () => '' },
        reconstructionEngine: { reconstructVersion: async () => '' } as any,
        getSettings: () => settings,
    });

    return { cache, latestLookups, preparer, settings, store, vault };
}
