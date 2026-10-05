import { App } from 'obsidian';
import { Container } from './container';
import { LocalDataStorage } from './state/local-data-storage';
import { DeviceManager } from './state/device-manager';
import { RecentNotesCache } from './state/recent-notes-cache';
import { DirtyFileManager } from './state/dirty-file-manager';
import { ActivityHistoryManager } from './state/activity-history-manager';
import { ActivityTracker } from './state/activity-tracker';
import { FailedTasksManager } from './state/failed-tasks-manager';
import { BatchFailureReportManager } from './state/batch-failure-report-manager';
import { PocketBaseClient } from './remote/pocketbase-client';
import { AuthManager } from './remote/auth-manager';
import { ObsidianSecretStorageProvider } from './remote/obsidian-secret-storage';
import { PocketBaseStore } from './remote/pocketbase-store';
import { PocketBaseHealthChecker } from './remote/pocketbase-health-checker';
import { AutomaticQueueStore } from './queue/automatic-queue-store';
import { AutomaticQueueManager } from './queue/automatic-queue-manager';
import { AutomaticQueueProcessor } from './queue/automatic-queue-processor';
import { UploadCoordinator } from './upload/upload-coordinator';
import { TaskUploader } from './upload/task-uploader';
import { PayloadPreparer } from './preparation/payload-preparer';
import { SingleFileRunner } from './runner/single-file-runner';
import { VaultBatchCoordinator } from './operations/vault-batch-coordinator';
import { ManualFileOperation } from './operations/manual-file-operation';
import { RetryFailedTaskOperation } from './operations/retry-failed-task-op';
import { BackupFileOperation } from './operations/backup-file-op';
import { RenameFileOperation } from './operations/rename-file-op';
import { DeleteFileOperation } from './operations/delete-file-op';
import { StartupRecoveryOperation } from './operations/startup-recovery-op';
import { BackupVaultOperation } from './operations/backup-vault-op';
import { SyncVaultOperation } from './operations/sync-vault-op';
import { ReconstructionEngine } from './reconstruct/reconstruction-engine';
import { RestoreManager } from './reconstruct/restore-manager';
import { DiffWorkerClient } from './diff/diff-worker-client';
import { DebounceController } from './vault/debounce-controller';
import { OperationsManager } from './operations/operations-manager';
import { StatusBarWidget } from './ui/status-bar';
import type PBBackupPlugin from './main';
import type { DebouncedSaveTask } from './types/state';
import { DEFAULT_ACTIVITY_HISTORY_LIMIT } from './state/constants';
import { scheduleAbortableTimeout } from './utils/abortable-timeout';
import { TaskFactory } from './tasks/task-factory';
import {
    PLUGIN_DIR_TOKEN,
    PLUGIN_TOKEN,
    SETTINGS_TOKEN,
} from './tokens';

/**
 * Bootstraps the service container by registering all core services,
 * wiring activity logging and event hooks, and executing sequential async initializations.
 */
export async function bootstrapContainer(plugin: PBBackupPlugin): Promise<Container> {
    const container = new Container();
    const pluginDir = plugin.manifest.dir || `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
    const adapter = plugin.app.vault.adapter;

    // 1. Register Obsidian environment and settings
    container.registerInstance(App, plugin.app);
    container.registerInstance(PLUGIN_TOKEN, plugin);
    container.registerInstance(PLUGIN_DIR_TOKEN, pluginDir);
    container.registerFactory(SETTINGS_TOKEN, () => plugin.settings, false);

    // 2. Register Storage & State Managers
    container.registerFactory(
        LocalDataStorage,
        () => new LocalDataStorage(adapter, pluginDir)
    );
    container.registerFactory(
        DeviceManager,
        (c) => new DeviceManager(c.resolve(LocalDataStorage))
    );
    container.registerFactory(
        RecentNotesCache,
        () => new RecentNotesCache()
    );
    container.registerFactory(
        DirtyFileManager,
        (c) => new DirtyFileManager(c.resolve(LocalDataStorage))
    );
    container.registerFactory(
        ActivityHistoryManager,
        (c) => new ActivityHistoryManager(c.resolve(LocalDataStorage))
    );
    container.registerFactory(
        ActivityTracker,
        (c) => new ActivityTracker(
            c.resolve(ActivityHistoryManager),
            () => plugin.settings.activityHistoryLimit || DEFAULT_ACTIVITY_HISTORY_LIMIT
        )
    );
    container.registerFactory(
        FailedTasksManager,
        (c) => new FailedTasksManager(c.resolve(LocalDataStorage))
    );
    container.registerFactory(
        BatchFailureReportManager,
        (c) => new BatchFailureReportManager(c.resolve(LocalDataStorage))
    );
    container.registerFactory(
        TaskFactory,
        () => new TaskFactory()
    );

    // 3. Register Remote Client & Store
    container.registerFactory(
        PocketBaseClient,
        () => new PocketBaseClient(() => plugin.settings.serverUrl)
    );
    container.registerFactory(
        AuthManager,
        (c) => {
            const secretStorage = plugin.app.secretStorage;
            const secretStorageProvider = secretStorage
                ? new ObsidianSecretStorageProvider(secretStorage)
                : undefined;

            return new AuthManager(
                c.resolve(PocketBaseClient),
                () => plugin.settings,
                secretStorageProvider
            );
        }
    );
    container.registerFactory(
        PocketBaseStore,
        (c) => new PocketBaseStore(c.resolve(PocketBaseClient), c.resolve(AuthManager))
    );
    container.registerFactory(
        PocketBaseHealthChecker,
        (c) => new PocketBaseHealthChecker(c.resolve(PocketBaseClient))
    );

    // 4. Register Upload Transport
    container.registerFactory(UploadCoordinator, () => new UploadCoordinator());
    container.registerFactory(TaskUploader, (c) => new TaskUploader(c.resolve(PocketBaseStore), c.resolve(ActivityTracker)));

    // 5. Register Reconstruction, Restore, and Diff Engines
    container.registerFactory(
        ReconstructionEngine,
        (c) => new ReconstructionEngine(c.resolve(PocketBaseStore))
    );
    container.registerFactory(
        RestoreManager,
        (c) => new RestoreManager(
            plugin.app.vault,
            c.resolve(ReconstructionEngine),
            () => plugin.settings,
            (file) => c.resolve(ManualFileOperation).backupFileNow(file)
        )
    );
    container.registerFactory(
        DiffWorkerClient,
        () => new DiffWorkerClient()
    );

    // 6. Register Preparation Pipeline & Single File Execution Runner
    container.registerFactory(PayloadPreparer, (c) => new PayloadPreparer({
        vault: plugin.app.vault,
        deviceManager: c.resolve(DeviceManager),
        cache: c.resolve(RecentNotesCache),
        store: c.resolve(PocketBaseStore),
        diffComputer: c.resolve(DiffWorkerClient),
        reconstructionEngine: c.resolve(ReconstructionEngine),
        getSettings: () => plugin.settings,
    }));

    container.registerFactory(SingleFileRunner, (c) => new SingleFileRunner(
        c.resolve(PayloadPreparer),
        c.resolve(UploadCoordinator),
        c.resolve(TaskUploader),
        c.resolve(DirtyFileManager),
        c.resolve(RecentNotesCache),
        c.resolve(ActivityTracker),
    ));

    // 7. Register the automatic reconciliation queue.
    container.registerFactory(AutomaticQueueStore, (c) => new AutomaticQueueStore(c.resolve(ActivityTracker)));
    container.registerFactory(AutomaticQueueProcessor, (c) => new AutomaticQueueProcessor(
        c.resolve(AutomaticQueueStore),
        c.resolve(SingleFileRunner),
        c.resolve(ActivityTracker),
        {
            connectivityChecker: c.resolve(PocketBaseHealthChecker),
            onStateChange: () => c.resolve(AutomaticQueueManager).refreshStatus(),
            failedTasksManager: c.resolve(FailedTasksManager),
            recentNotesCache: c.resolve(RecentNotesCache),
            dirtyFileMarker: c.resolve(DirtyFileManager),
        },
    ));
    container.registerFactory(AutomaticQueueManager, (c) => new AutomaticQueueManager(
        c.resolve(AutomaticQueueStore), c.resolve(AutomaticQueueProcessor),
    ));

    // 8. Register Debounce Controller with ActivityLogger
    container.registerFactory(DebounceController, (c) => {
        const dirtyFiles = c.resolve(DirtyFileManager);
        const tracker = c.resolve(ActivityTracker);

        return new DebounceController(
            dirtyFiles,
            plugin.settings.debounceIntervalMs,
            plugin.settings.maxWaitMs,
            async (task: DebouncedSaveTask) => {
                const ops = container.resolve(OperationsManager);
                await ops.processDebouncedFile(task);
            },
            tracker
        );
    });

    // 9. Register Dedicated Vault and File Operation Handlers
    container.registerFactory(BackupVaultOperation, (c) => new BackupVaultOperation({
        vault: plugin.app.vault,
        getSettings: () => plugin.settings,
        runner: c.resolve(SingleFileRunner),
    }));
    container.registerFactory(SyncVaultOperation, (c) => new SyncVaultOperation({
        vault: plugin.app.vault,
        deviceManager: c.resolve(DeviceManager),
        getSettings: () => plugin.settings,
        store: c.resolve(PocketBaseStore),
        runner: c.resolve(SingleFileRunner),
    }));
    container.registerFactory(VaultBatchCoordinator, (c) => new VaultBatchCoordinator({
        automaticQueueManager: c.resolve(AutomaticQueueManager),
        uploadCoordinator: c.resolve(UploadCoordinator),
        batchFailureReportManager: c.resolve(BatchFailureReportManager),
        backupVaultOp: c.resolve(BackupVaultOperation),
        syncVaultOp: c.resolve(SyncVaultOperation),
        getSettings: () => plugin.settings,
    }));

    container.registerFactory(ManualFileOperation, (c) => new ManualFileOperation({
        vault: plugin.app.vault,
        runner: c.resolve(SingleFileRunner),
        taskFactory: c.resolve(TaskFactory),
        debounceController: c.resolve(DebounceController),
        uploadCoordinator: c.resolve(UploadCoordinator),
    }));

    container.registerFactory(BackupFileOperation, (c) => new BackupFileOperation({
        vault: plugin.app.vault,
        queue: c.resolve(AutomaticQueueManager),
    }));
    container.registerFactory(RenameFileOperation, (c) => new RenameFileOperation({
        queue: c.resolve(AutomaticQueueManager),
        dirtyFileManager: c.resolve(DirtyFileManager),
        debounceController: c.resolve(DebounceController),
        getSettings: () => plugin.settings,
    }));
    container.registerFactory(DeleteFileOperation, (c) => new DeleteFileOperation({
        queue: c.resolve(AutomaticQueueManager),
        dirtyFileManager: c.resolve(DirtyFileManager),
        debounceController: c.resolve(DebounceController),
    }));
    container.registerFactory(StartupRecoveryOperation, (c) => new StartupRecoveryOperation({
        vault: plugin.app.vault,
        dirtyFileManager: c.resolve(DirtyFileManager),
        queue: c.resolve(AutomaticQueueManager),
    }));

    container.registerFactory(RetryFailedTaskOperation, (c) => new RetryFailedTaskOperation({
        vault: plugin.app.vault,
        runner: c.resolve(SingleFileRunner),
        manualFileOp: c.resolve(ManualFileOperation),
        failedTasksManager: c.resolve(FailedTasksManager),
        uploadCoordinator: c.resolve(UploadCoordinator),
    }));

    // 10. Register Operations Manager
    container.registerFactory(OperationsManager, (c) => {
        return new OperationsManager({
            debounceController: c.resolve(DebounceController),
            automaticQueueManager: c.resolve(AutomaticQueueManager),
            reconstructionEngine: c.resolve(ReconstructionEngine),
            restoreManager: c.resolve(RestoreManager),
            vaultBatchCoordinator: c.resolve(VaultBatchCoordinator),
            manualFileOp: c.resolve(ManualFileOperation),
            retryFailedTaskOp: c.resolve(RetryFailedTaskOperation),
            backupFileOp: c.resolve(BackupFileOperation),
            renameFileOp: c.resolve(RenameFileOperation),
            deleteFileOp: c.resolve(DeleteFileOperation),
            startupRecoveryOp: c.resolve(StartupRecoveryOperation),
        });
    });

    return container;
}

// export async function asyncInitialize(plugin: PBBackupPlugin, container: Container): Promise<void> {
// }

export async function runOnLayoutReady(plugin: PBBackupPlugin, container: Container): Promise<void> {
    const shutdownSignal = plugin.shutdownController.signal;
    if (shutdownSignal.aborted) return;

    // --- Execute Sequential Async Initializations ---
    const deviceManager = container.resolve(DeviceManager);
    // Reads device file - consumes i/o - read
    await deviceManager.initialize(plugin.settings.vaultId);
    if (shutdownSignal.aborted) return;

    // Synchronize vault ID:
    // DeviceManager (local_data/device.json) is the runtime authority for vault & device identity.
    // plugin.settings.vaultId (data.json) acts as a portable sync seed so that across devices
    // new device installations inherit the same logical vault namespace.
    const persistentVaultId = deviceManager.getVaultId();
    if (!plugin.settings.vaultId || plugin.settings.vaultId !== persistentVaultId) {
        plugin.settings.vaultId = persistentVaultId;
        const saveSettings = async (): Promise<void> => {
            try {
                await plugin.saveSettings();
            } catch (err) {
                console.error('Failed to save deviceId to plugin settings:', err);
            }
        };
        scheduleAbortableTimeout(shutdownSignal, saveSettings, 5_000, saveSettings);
    }

    const authManager = container.resolve(AuthManager);
    // Loads stored authentication token
    // If not available calls login request
    await authManager.loadStoredAuth();
    if (shutdownSignal.aborted) return;

    const activityTracker = container.resolve(ActivityTracker);
    // Calls ActivityHistoryManager.load which trims old activity history entries to limit
    // Consumes i/o - read and write
    // Initial scheduleSave called by load runs 15 secs later
    await activityTracker.initialize();
    if (shutdownSignal.aborted) return;

    const failedTasksManager = container.resolve(FailedTasksManager);
    // trims old failed tasks to limit
    // Consumes i/o - read and write
    // Initial scheduleSave called by load runs 15 secs later
    scheduleAbortableTimeout(shutdownSignal, async () => {
        try {
            await failedTasksManager.initialize();
        } catch (err) {
            console.error('Failed to initialize failed tasks manager:', err);
        }
    }, 5_000);

    // Removes all files in the local_data/batch_failures dir.
    // Consumes i/o - read and write
    // Delay execution by 5 seconds
    scheduleAbortableTimeout(shutdownSignal, async () => {
        try {
            await container.resolve(BatchFailureReportManager).clearPreviousSessionReports();
        } catch (err) {
            console.error('Failed to delete old batch failure logs:', err);
        }
    }, 10_000);
    const operationsManager = container.resolve(OperationsManager);
    const automaticQueueManager = container.resolve(AutomaticQueueManager);
    // Pause queue processing
    await automaticQueueManager.pause("boot");
    if (shutdownSignal.aborted) return;
    // Runs queue-store.load - Consumes i/o - read
    await container.resolve(AutomaticQueueManager).initialize();
    if (shutdownSignal.aborted) return;
    // Moves any existing dirty files from file to queue
    // Consumes i/o - read and write
    await operationsManager.runStartupRecovery();
    if (shutdownSignal.aborted) return;
    // Resume queue processing after a short delay
    scheduleAbortableTimeout(shutdownSignal, async () => {
        await automaticQueueManager.resume("boot");
    }, 15_000);
}

/**
 * Coordinated teardown of all container services during plugin unload.
 */
export async function teardownContainer(container: Container): Promise<void> {
    if (!container) return;

    // Close intake and signal running operations before awaiting local state writes.
    container.getIfInstantiated(OperationsManager)?.requestShutdown?.();
    container.getIfInstantiated(DebounceController)?.close();
    container.getIfInstantiated(AutomaticQueueManager)?.shutdown();
    // container.getIfInstantiated(UploadCoordinator)?.shutdown();

    await Promise.all([
        container.getIfInstantiated(ActivityHistoryManager)?.flush(),
        container.getIfInstantiated(FailedTasksManager)?.flush(),
    ]);

    container.getIfInstantiated(StatusBarWidget)?.destroy();
}
