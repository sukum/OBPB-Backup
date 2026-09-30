import type { TFile, TFolder, Vault } from 'obsidian';
import type { OBPBBackupSettings } from '../types/settings';
import type { BackupStore } from '../remote/backup-store';
import type { DebouncedSaveTask, DirtyFileEntry, FailedTaskRecord } from '../types/state';
import type { BackupMode } from '../types/domain';
import type { BatchFailure, BatchFailureReport } from '../state/batch-failure-report-manager';
import type { ExecutionResult } from '../runner/types';
import type { PreparationContext } from '../preparation/types';
import type { RestoreResult, RestoreVersionOptions, VersionReconstructor } from '../reconstruct/types';
import { BACKUP_EVENTS, type BackupEventType } from '../types/domain';

export type { BackupMode };

export { BACKUP_EVENTS as INTENT_EVENTS };
export type IntentEvent = BackupEventType;

export const INTENT_TRIGGERS = [
    'auto',
    'manual',
] as const;
export type IntentTrigger = (typeof INTENT_TRIGGERS)[number];

// export const INTENT_OPERATIONS = BACKUP_OPERATIONS;
// export type IntentOperation = (typeof INTENT_OPERATIONS)[number];

export interface TaskExecutionPolicy {
    /** Whether runner execution stages (unchanged/skipped completions and upload transport progress) emit ActivityTracker events */
    readonly logActivity: boolean;
    /** Whether to claim and release/markClean entries in dirty_files.tsv */
    readonly trackDirty: boolean;
    /** Whether to update the NoteStateCache upon completion */
    readonly updateCache: boolean;
}

export interface SaveExecutionPolicy extends TaskExecutionPolicy {
    /** Whether to skip upload if content hash matches remote/cached base */
    readonly skipIfUnchanged: boolean;
}

export type BaseExecutionPolicyKey = 'AUTO' | 'MANUAL' | 'BATCH';
export const BASE_EXECUTION_POLICIES = {
    AUTO: { logActivity: true, trackDirty: true, updateCache: true },
    MANUAL: { logActivity: false, trackDirty: false, updateCache: true },
    BATCH: { logActivity: false, trackDirty: false, updateCache: false },
} as const satisfies Record<BaseExecutionPolicyKey, TaskExecutionPolicy>;

export type SaveExecutionPolicyKey = 'AUTO_MODIFY' | 'MANUAL_SYNC' | 'MANUAL_SNAPSHOT' | 'BATCH_SYNC' | 'BATCH_SNAPSHOT';
export const SAVE_EXECUTION_POLICIES = {
    AUTO_MODIFY: { ...BASE_EXECUTION_POLICIES.AUTO, skipIfUnchanged: true },
    MANUAL_SYNC: { ...BASE_EXECUTION_POLICIES.MANUAL, skipIfUnchanged: true },
    MANUAL_SNAPSHOT: { ...BASE_EXECUTION_POLICIES.MANUAL, skipIfUnchanged: false },
    BATCH_SYNC: { ...BASE_EXECUTION_POLICIES.BATCH, skipIfUnchanged: true },
    BATCH_SNAPSHOT: { ...BASE_EXECUTION_POLICIES.BATCH, skipIfUnchanged: false },
} as const satisfies Record<SaveExecutionPolicyKey, SaveExecutionPolicy>;

export interface BaseIntent<TTrigger extends IntentTrigger = IntentTrigger> {
    /** Immutable task UUID correlating across debounce, queue, runner, and activity logging */
    id: string;
    /** Trigger source: 'auto' (queued) vs 'manual' (immediate / batch) */
    trigger: TTrigger;
    /** Originating event category */
    event: IntentEvent;
    /** Target vault-relative path */
    path: string;
    /** Timestamp when intent was created */
    createdAt?: number;
}

export interface SaveIntent<TTrigger extends IntentTrigger = IntentTrigger> extends BaseIntent<TTrigger> {
    operation: 'save';
    policy: SaveExecutionPolicy;
    /** In-memory Obsidian file handle if already resolved */
    file?: TFile;
    /** Requested backup mode: 'auto' (diff with snapshot fallback), 'snapshot', or 'diff' */
    mode?: BackupMode;
}

export interface RenameIntent<TTrigger extends IntentTrigger = IntentTrigger> extends BaseIntent<TTrigger> {
    operation: 'rename';
    policy: TaskExecutionPolicy;
    /** Source vault-relative path prior to rename */
    oldPath: string;
    /** Target file handle on disk if available */
    file?: TFile;
}

export interface DeleteIntent<TTrigger extends IntentTrigger = IntentTrigger> extends BaseIntent<TTrigger> {
    operation: 'delete';
    policy: TaskExecutionPolicy;
}

export type TaskIntent = SaveIntent | RenameIntent | DeleteIntent;

// Type-safe boundary types preserving literal trigger:
export type AutoSaveIntent = SaveIntent<'auto'>;
export type AutoRenameIntent = RenameIntent<'auto'>;
export type AutoDeleteIntent = DeleteIntent<'auto'>;

export type ManualSaveIntent = SaveIntent<'manual'>;
export type ManualRenameIntent = RenameIntent<'manual'>;
export type ManualDeleteIntent = DeleteIntent<'manual'>;

export type AutoTaskIntent = AutoSaveIntent | AutoRenameIntent | AutoDeleteIntent;
export type ManualTaskIntent = ManualSaveIntent | ManualRenameIntent | ManualDeleteIntent;

export type INTENT_DEFAULT_SPEC_PROPERTIES = 'trigger' | 'event' | 'operation' | 'policy';

/** Durable projection of a TaskIntent. TFile handles must never reach JSONL state. */
export type SerializableTaskIntent = Omit<SaveIntent, 'file'> | Omit<RenameIntent, 'file'> | DeleteIntent;

/** Creates the JSON-safe intent representation used by durable state stores. */
export function serializeTaskIntent(intent: TaskIntent): SerializableTaskIntent {
    if (intent.operation === 'save' || intent.operation === 'rename') {
        const { file: _file, ...serializedIntent } = intent;
        return serializedIntent;
    }
    return intent;
}

export interface DeviceIdentity {
    getVaultId(): string;
    getDevice(): string;
}

export interface DirtyFileJournal {
    load(): Promise<DirtyFileEntry[]>;
    markDirty(path: string): Promise<void>;
    markDirty(operation: 'SAVE' | 'DELETE', path: string): Promise<void>;
    markDirty(operation: 'RENAME', path: string, oldPath: string): Promise<void>;
    markClean(path: string): Promise<void>;
    saveAll?(entries: DirtyFileEntry[]): Promise<void>;
}

export interface DebounceScheduler {
    schedule(task: DebouncedSaveTask): Promise<void>;
    cancel(path: string): void;
    flushFile(path: string): Promise<void>;
    flushAll(): Promise<void>;
}

export interface TaskCreator {
    createSaveTask(input: TFile | string): DebouncedSaveTask;
}

export interface DiffComputer {
    computeDiff(oldText: string, newText: string, totalSize: number): Promise<string>;
}

export interface AutomaticUploadQueue {
    enqueue(task: AutoTaskIntent): Promise<void>;
    pause?(reason?: string): void;
    resume?(reason?: string): void;
    isPaused?(): boolean;
    process?(): Promise<void>;
    retryNow?(): Promise<void>;
}

export interface VersionRestorer {
    restoreVersion(vault: string, path: string, hash: string, options?: RestoreVersionOptions): Promise<RestoreResult>;
}

/** Runs a task intent, optionally with context used during payload preparation. */
export interface TaskRunner {
    execute(intent: TaskIntent, context?: PreparationContext): Promise<ExecutionResult>;
}

export interface BackupFileOperationPort {
    execute(task: DebouncedSaveTask): Promise<void>;
}

export interface RenameFileOperationPort {
    execute(input: FileRenameInput, oldPath: string): Promise<void>;
}

export interface DeleteFileOperationPort {
    execute(input: string | TFile): Promise<void>;
}

export interface StartupRecoveryOperationPort {
    execute(): Promise<void>;
}

export interface VaultBatchCoordinatorPort {
    backupVault(onProgress?: VaultOperationProgressCallback): Promise<BatchResult>;
    syncVault(onProgress?: VaultOperationProgressCallback): Promise<BatchResult>;
    stopVaultOperation(): Promise<void>;
    requestShutdown?(): void;
    isOperationRunning(): boolean;
}

export interface ManualFileOperationPort {
    backupFileNow(file: TFile): Promise<ExecutionResult | null>;
    snapshotFileNow(file: TFile): Promise<ExecutionResult | null>;
}

export interface RetryFailedTaskOperationPort {
    execute(record: FailedTaskRecord): Promise<void>;
}

export interface FailedTaskOperations {
    remove(taskId: string): Promise<boolean>;
    updateFailedTask(record: FailedTaskRecord): Promise<void>;
}

export interface BatchFailureReportWriter {
    write(report: BatchFailureReport): Promise<string | null>;
}

export interface VaultBatchOperationPort {
    execute(
        onProgress?: VaultOperationProgressCallback,
        isAborted?: () => boolean
    ): Promise<BatchResult>;
}

/** Converts debounced save tasks into automatic intents. */
export interface BackupFileOperationContext {
    vault: Vault;
    queue: AutomaticUploadQueue;
}

/** Converts file and folder rename events into automatic intents. */
export interface RenameFileOperationContext {
    queue: AutomaticUploadQueue;
    dirtyFileManager: DirtyFileJournal;
    debounceController: DebounceScheduler;
    getSettings: () => OBPBBackupSettings;
}

/** Converts file deletion events into automatic intents. */
export interface DeleteFileOperationContext {
    queue: AutomaticUploadQueue;
    dirtyFileManager: DirtyFileJournal;
    debounceController: DebounceScheduler;
}

export interface BackupVaultContext {
    vault: Vault;
    getSettings: () => OBPBBackupSettings;
    runner: TaskRunner;
}

export interface SyncVaultContext {
    vault: Vault;
    store: BackupStore;
    deviceManager: DeviceIdentity;
    getSettings: () => OBPBBackupSettings;
    runner: TaskRunner;
}

export interface StartupRecoveryContext {
    vault: Vault;
    dirtyFileManager: DirtyFileJournal;
    queue: AutomaticUploadQueue;
}

/** Progress callback threaded from Obsidian Settings UI to vault operations. */
export type VaultOperationProgressCallback = (
    current: number,
    total: number,
    path: string,
    action: string
) => void;


export interface QueuePauseResume {
    pause: (reason?: string) => void;
    resume: (reason?: string) => void;
}

export interface BatchResult {
    totalFiles: number;
    processed: number;
    uploaded: number;
    unchanged: number;
    skipped: number;
    deleted: number;
    stopped?: boolean;
    failed?: number;
    notAttempted?: number;
    failures?: BatchFailure[];
}

/** Dependencies exposed by the thin OperationsManager facade. */
export interface OperationsManagerDependencies {
    automaticQueueManager: AutomaticUploadQueue;
    debounceController: DebounceScheduler;
    reconstructionEngine: VersionReconstructor;
    restoreManager: VersionRestorer;
    backupFileOp: BackupFileOperationPort;
    renameFileOp: RenameFileOperationPort;
    deleteFileOp: DeleteFileOperationPort;
    startupRecoveryOp: StartupRecoveryOperationPort;
    vaultBatchCoordinator: VaultBatchCoordinatorPort;
    manualFileOp: ManualFileOperationPort;
    retryFailedTaskOp: RetryFailedTaskOperationPort;
}

export type FileRenameInput = TFile | TFolder;
