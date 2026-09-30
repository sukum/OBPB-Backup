import { App, Plugin, TFile } from 'obsidian';
import { Container } from '../../../src/container';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';
import type { OBPBBackupSettings } from '../../../src/types/settings';
import { OperationsManager } from '../../../src/operations/operations-manager';
import { PocketBaseStore } from '../../../src/remote/pocketbase-store';
import { PocketBaseHealthChecker } from '../../../src/remote/pocketbase-health-checker';
import type { BackupStore } from '../../../src/remote/backup-store';
import { DeviceManager } from '../../../src/state/device-manager';
import { ActivityTracker } from '../../../src/state/activity-tracker';
import { AutomaticQueueManager } from '../../../src/queue/automatic-queue-manager';
import { FailedTasksManager } from '../../../src/state/failed-tasks-manager';
import { DebounceController } from '../../../src/vault/debounce-controller';
import { AuthManager } from '../../../src/remote/auth-manager';
import type OBPBBackupPlugin from '../../../src/main';
import type { Token } from '../../../src/container';
import type { ActivityRecord, FailedTaskRecord } from '../../../src/types/state';
import type { SyncStatusEvent, SyncStatusSubscriber } from '../../../src/types/events';
import type { ActivityViewSource, FailedTaskViewSource } from '../../../src/ui/activity-manager/types';
import { RestoreResult, RestoreVersionOptions } from '../../../src/reconstruct/types';

export type TestOperationsManager = Pick<OperationsManager,
    | 'backupVault'
    | 'syncVault'
    | 'pauseQueue'
    | 'resumeQueue'
    | 'isQueuePaused'
    | 'isOperationRunning'
    | 'stopVaultOperation'
    | 'backupFileNow'
    | 'snapshotFileNow'
    | 'flushDebouncedFiles'
    | 'flushAndProcessQueue'
    | 'retryUploadQueue'
    | 'retryFailedTask'
    | 'reconstructVersion'
    | 'restoreVersion'
>;

export type TestPocketBaseStore = Pick<BackupStore, 'getHistory' | 'getLatestFiles' | 'getVaultStats'>;

export type TestHealthChecker = Pick<PocketBaseHealthChecker, 'healthCheck'>;

export type TestDeviceManager = Pick<DeviceManager, 'getVaultId' | 'getDevice'>;

export interface TestActivityTracker extends ActivityViewSource {
    records: ActivityRecord[];
    notify(): void;
}

export interface TestQueueManager extends SyncStatusSubscriber {
    notify(event: SyncStatusEvent): void;
    process(): Promise<void>;
}

export interface TestFailedTasksManager extends FailedTaskViewSource {
    tasks: FailedTaskRecord[];
    notify(): void;
}

export type TestDebounceController = Pick<DebounceController, 'updateSettings'>;
export type TestAuthManager = Pick<AuthManager, 'checkAuth' | 'login' | 'testLogin'>;

export interface TestContextMocks {
    operationsManager: TestOperationsManager;
    pocketBaseStore: TestPocketBaseStore;
    healthChecker: TestHealthChecker;
    deviceManager: TestDeviceManager;
    activityTracker: TestActivityTracker;
    queueManager: TestQueueManager;
    failedTasksManager: TestFailedTasksManager;
    debounceController: TestDebounceController;
    authManager: TestAuthManager;
}

export interface TestContextSetup {
    plugin: OBPBBackupPlugin;
    container: Container;
    app: App;
    mocks: TestContextMocks;
}

export function createTestContext(customSettings?: Partial<OBPBBackupSettings>): TestContextSetup {
    const app = new App();
    const container = new Container();
    const registerTestDouble = <T>(token: Token<T>, implementation: object): void => {
        container.registerInstance(token, implementation as unknown as T);
    };

    const settings: OBPBBackupSettings = {
        ...DEFAULT_SETTINGS,
        vaultId: 'test-vault-id',
        serverUrl: 'https://pb.test.local',
        userEmail: 'test@example.com',
        ...customSettings,
    };

    let isPaused = false;
    let isRunning = false;

    const mockOperationsManager: TestOperationsManager = {
        backupVault: async (progress) => {
            if (progress) progress(1, 10, 'note.md', 'backup');
            return { uploaded: 5, unchanged: 0, skipped: 0, deleted: 0, totalFiles: 10, processed: 10, stopped: false };
        },
        syncVault: async (progress) => {
            if (progress) progress(1, 10, 'note.md', 'sync');
            return { uploaded: 3, unchanged: 5, skipped: 0, deleted: 2, totalFiles: 10, processed: 10, stopped: false };
        },
        pauseQueue: () => { isPaused = true; },
        resumeQueue: () => { isPaused = false; },
        isQueuePaused: () => isPaused,
        isOperationRunning: () => isRunning,
        stopVaultOperation: async () => { isRunning = false; },
        backupFileNow: async (file: TFile) => null,
        snapshotFileNow: async (file: TFile) => null,
        flushDebouncedFiles: async (path?: string) => {},
        flushAndProcessQueue: async () => {},
        retryUploadQueue: async () => {},
        retryFailedTask: async (record: FailedTaskRecord) => {},
        reconstructVersion: async (vaultId: string, path: string, hash: string) => 'Reconstructed historical content',
        restoreVersion: async (vaultId: string, path: string, hash: string, options: RestoreVersionOptions): Promise<RestoreResult> => { return { status: 'modified', path: path }; },
    };

    const mockPocketBaseStore: TestPocketBaseStore = {
        getHistory: async (vaultId, path, page = 1, perPage = 50) => [],
        getLatestFiles: async (vaultId, deletedOnly = false) => [],
        getVaultStats: async (vaultId: string) => null,
    };

    const mockHealthChecker: TestHealthChecker = {
        healthCheck: async () => {},
    };

    const mockDeviceManager: TestDeviceManager = {
        getVaultId: () => settings.vaultId,
        getDevice: () => 'dev-test-123456',
    };

    const trackerSubscribers: (() => void)[] = [];
    const mockActivityTracker: TestActivityTracker = {
        records: [],
        getRecords: () => mockActivityTracker.records,
        getRecordHashes: () => new Map<string, string>(),
        subscribe: (cb: () => void) => {
            trackerSubscribers.push(cb);
            return () => {
                const idx = trackerSubscribers.indexOf(cb);
                if (idx >= 0) trackerSubscribers.splice(idx, 1);
            };
        },
        notify: () => {
            for (const cb of trackerSubscribers) cb();
        },
        clearCompleted: () => {},
        dismissRecord: (id: string) => {},
    };

    const queueSubscribers: ((event: SyncStatusEvent) => void)[] = [];
    const mockQueueManager: TestQueueManager = {
        subscribe: (cb) => {
            queueSubscribers.push(cb);
            return () => {
                const idx = queueSubscribers.indexOf(cb);
                if (idx >= 0) queueSubscribers.splice(idx, 1);
            };
        },
        notify: (event) => {
            for (const cb of queueSubscribers) cb(event);
        },
        process: async () => {},
    };

    const failedTaskSubscribers: (() => void)[] = [];
    const mockFailedTasksManager: TestFailedTasksManager = {
        tasks: [],
        getFailedTasks: () => mockFailedTasksManager.tasks,
        getCount: () => mockFailedTasksManager.tasks.length,
        clearAll: async () => { mockFailedTasksManager.tasks = []; },
        removeFailedTask: async (id: string) => {
            const previousCount = mockFailedTasksManager.tasks.length;
            mockFailedTasksManager.tasks = mockFailedTasksManager.tasks.filter(t => t.id !== id);
            return mockFailedTasksManager.tasks.length < previousCount;
        },
        subscribe: (cb: () => void) => {
            failedTaskSubscribers.push(cb);
            return () => {
                const idx = failedTaskSubscribers.indexOf(cb);
                if (idx >= 0) failedTaskSubscribers.splice(idx, 1);
            };
        },
        notify: () => {
            for (const cb of failedTaskSubscribers) cb();
        },
    };

    const mockDebounceController: TestDebounceController = {
        updateSettings: (intervalMs: number, maxWaitMs: number) => {},
    };

    const mockAuthManager: TestAuthManager = {
        checkAuth: async () => true,
        login: async (password: string) => {},
        testLogin: async (password: string) => {},
    };

    registerTestDouble(OperationsManager, mockOperationsManager);
    registerTestDouble(PocketBaseStore, mockPocketBaseStore);
    registerTestDouble(PocketBaseHealthChecker, mockHealthChecker);
    registerTestDouble(DeviceManager, mockDeviceManager);
    registerTestDouble(ActivityTracker, mockActivityTracker);
    registerTestDouble(AutomaticQueueManager, mockQueueManager);
    registerTestDouble(FailedTasksManager, mockFailedTasksManager);
    registerTestDouble(DebounceController, mockDebounceController);
    registerTestDouble(AuthManager, mockAuthManager);

    const plugin = new (Plugin as any)() as any as OBPBBackupPlugin;
    plugin.app = app;
    plugin.settings = settings;
    plugin.container = container;
    plugin.saveSettings = async () => {};

    return {
        plugin,
        container,
        app,
        mocks: {
            operationsManager: mockOperationsManager,
            pocketBaseStore: mockPocketBaseStore,
            healthChecker: mockHealthChecker,
            deviceManager: mockDeviceManager,
            activityTracker: mockActivityTracker,
            queueManager: mockQueueManager,
            failedTasksManager: mockFailedTasksManager,
            debounceController: mockDebounceController,
            authManager: mockAuthManager,
        },
    };
}
