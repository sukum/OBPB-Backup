import type { App, TFile } from 'obsidian';
import type { PBBackupSettings } from '../../types/settings';
import type { ActivityRecord, FailedTaskRecord, RecordIdsHashed } from '../../types/state';
//import type { SyncStatusSubscriber } from '../../types/events';
import type { ExecutionResult } from '../../runner/types';

export interface ActivityReader {
    getRecords(): ActivityRecord[];
    getRecordHashes(): RecordIdsHashed;
    clearCompleted(): void;
    dismissRecord(id: string): void;
}

/** Activity data and change notifications consumed by ActivityManagerView. */
export interface ActivityViewSource extends ActivityReader {
    subscribe(listener: () => void): () => void;
}

export interface ActivityOperations {
    isQueuePaused(): boolean;
    pauseQueue(): void;
    resumeQueue(): void;
    flushDebouncedFiles(path?: string): Promise<void>;
    retryUploadQueue(): Promise<void>;
    snapshotFileNow(file: TFile): Promise<ExecutionResult | null>;
    backupFileNow(file: TFile): Promise<ExecutionResult | null>;
    retryFailedTask(record: FailedTaskRecord): Promise<void>;
}

export interface FailedTaskReader {
    getCount(): number;
    getFailedTasks(): FailedTaskRecord[];
    clearAll(): Promise<void>;
    removeFailedTask(taskId: string): Promise<boolean>;
}

/** Failed-task data and change notifications consumed by ActivityManagerView. */
export interface FailedTaskViewSource extends FailedTaskReader {
    subscribe(listener: () => void): () => void;
}

//export type ActivityQueue = SyncStatusSubscriber;

export type ActivityManagerTab = 'dashboard' | 'activity' | 'failed_tasks';

export interface ActivityTabContext {
    app: App;
    tracker: ActivityReader;
    operationsManager: ActivityOperations;
    getSettings: () => PBBackupSettings;
    onSettingsChange: (settings: PBBackupSettings) => Promise<void>;
    onRefreshIntervalChange: (seconds: number) => void;
}

export interface FailedTasksTabContext {
    app: App;
    failedTasksManager?: FailedTaskReader;
    operationsManager?: ActivityOperations;
    onTasksUpdated?: () => void;
}
