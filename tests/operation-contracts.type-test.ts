import type {
    AutomaticUploadQueue,
    AutoTaskIntent,
    ManualTaskIntent,
    BackupFileOperationPort,
    BackupVaultContext,
    BatchFailureReportWriter,
    DirtyFileJournal,
    FailedTaskOperations,
    SyncVaultContext,
    TaskRunner,
    TaskIntent,
} from '../src/operations/types';
import type {
    ExecutionPolicyContract,
    SaveExecutionPolicyContract,
} from './helpers/execution-policy-contract';
import type { SyncStatusSubscriber } from '../src/types/events';
import type { SingleFileRunner } from '../src/runner/single-file-runner';
import type { BackupFileOperation } from '../src/operations/backup-file-op';
import type { DirtyFileManager } from '../src/state/dirty-file-manager';
import type { FailedTaskRecord } from '../src/types/state';
import type { BatchFailureReport } from '../src/state/batch-failure-report-manager';
import type { PreparationContext } from '../src/preparation/types';
import type { PayloadPreparer, PayloadPreparerPort } from '../src/preparation/payload-preparer';
import type { VersionReconstructor } from '../src/reconstruct/types';
import type { ReconstructionEngine } from '../src/reconstruct/reconstruction-engine';
import type {
    ActivityHistoryPersistence,
    DirtyFileStorage,
    DirtyPathWriter,
    FailedTasksStorage,
    StateFileReaderWriter,
} from '../src/state/types';
import type { ActivityHistoryManager } from '../src/state/activity-history-manager';
import type { ActivityTracker } from '../src/state/activity-tracker';
import type { DeviceManager } from '../src/state/device-manager';
import type { FailedTasksManager } from '../src/state/failed-tasks-manager';
import type { LocalDataStorage } from '../src/state/local-data-storage';
import type { OperationsManager } from '../src/operations/operations-manager';
import type { ActivityOperations, ActivityViewSource, FailedTaskViewSource } from '../src/ui/activity-manager/types';
import type { TrashRestoreAction } from '../src/ui/trash/types';

declare const journal: DirtyFileJournal;
void journal.markDirty('Notes.md');
void journal.markDirty('RENAME', 'New.md', 'Old.md');
// @ts-expect-error Invalid operation values must be rejected with the explicit path form.
void journal.markDirty('BOGUS', 'Notes.md');
declare const dirtyFileManager: DirtyFileManager;
const managerSatisfiesJournal: DirtyFileJournal = dirtyFileManager;
void managerSatisfiesJournal;

const backupFilePort: BackupFileOperationPort = { execute: async () => {} };
void backupFilePort;
// @ts-expect-error A method-only test double must not need the class's private context.
const concreteBackupOperation: BackupFileOperation = backupFilePort;
void concreteBackupOperation;

const failedTaskOperations: FailedTaskOperations = {
    remove: async (_id: string) => true,
    updateFailedTask: async (_record: FailedTaskRecord) => {},
};
const batchFailureReportWriter: BatchFailureReportWriter = {
    write: async (_report: BatchFailureReport) => null,
};
void failedTaskOperations;
void batchFailureReportWriter;

declare const fullRunner: SingleFileRunner;
const taskRunner: TaskRunner = fullRunner;
const minimalRunner: TaskRunner = {
    execute: async (intent) => ({ status: 'unchanged', intent }),
};
declare const backupVaultContext: BackupVaultContext;
declare const syncVaultContext: SyncVaultContext;
declare const taskIntent: TaskIntent;
declare const automaticQueue: AutomaticUploadQueue;
declare const autoIntent: AutoTaskIntent;
declare const manualIntent: ManualTaskIntent;
declare const broadIntent: TaskIntent;

void automaticQueue.enqueue(autoIntent);
// @ts-expect-error ManualTaskIntent must not be enqueued to AutomaticUploadQueue
void automaticQueue.enqueue(manualIntent);
// @ts-expect-error Broadly typed TaskIntent must not be enqueued to AutomaticUploadQueue without narrowing
void automaticQueue.enqueue(broadIntent);
declare const preparationContext: PreparationContext;
const backupContextRunner: TaskRunner = backupVaultContext.runner;
const syncContextRunner: TaskRunner = syncVaultContext.runner;
void taskRunner.execute(taskIntent, preparationContext);
void backupContextRunner;
void syncContextRunner;
void taskRunner;
void minimalRunner;

declare const reconstructionEngine: ReconstructionEngine;
const versionReconstructor: VersionReconstructor = reconstructionEngine;
void versionReconstructor;

declare const historyManager: ActivityHistoryManager;
const historyPersistence: ActivityHistoryPersistence = historyManager;
void historyPersistence;
const minimalHistoryPersistence: ActivityHistoryPersistence = {
    load: async () => [],
    scheduleSave: () => {},
    flush: async () => {},
};
void minimalHistoryPersistence;

declare const activityTracker: ActivityTracker;
const activityViewSource: ActivityViewSource = activityTracker;
void activityViewSource;
declare const failedTasksManager: FailedTasksManager;
const failedTaskViewSource: FailedTaskViewSource = failedTasksManager;
void failedTaskViewSource;

declare const operationsManager: OperationsManager;
const activityOperations: ActivityOperations = operationsManager;
const trashRestoreAction: TrashRestoreAction = operationsManager;
void activityOperations;
void trashRestoreAction;

declare const dirtyManager: DirtyFileManager;
const dirtyPathWriter: DirtyPathWriter = dirtyManager;
void dirtyPathWriter;

declare const localDataStorage: LocalDataStorage;
const commonStorage: StateFileReaderWriter = localDataStorage;
const dirtyFileStorage: DirtyFileStorage = localDataStorage;
const failedTasksStorage: FailedTasksStorage = localDataStorage;
void commonStorage;
void dirtyFileStorage;
void failedTasksStorage;
declare const deviceManager: DeviceManager;
void deviceManager;

declare const payloadPreparer: PayloadPreparer;
const preparer: PayloadPreparerPort = payloadPreparer;
void preparer;
