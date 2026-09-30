/**
 * Local persistent state schemas.
 * files under local_data/
 */

import type { TFile } from 'obsidian';
import type { BackupEventType, BackupOperationUpper } from './domain';
import type { Assert, IsExtends } from './type-assertions';
import { LOCAL_STATE_VERSION } from '../state/constants';

/**
 * Stored at: local_data/dirty_files.tsv
 * Newline-delimited TSV list of file operations (<OPERATION>\t<PATH>[\t<OLD_PATH>]).
 * Written on transition to dirty; removed when upload completes or fails terminally.
 */
// export const DIRTY_OPERATIONS = BACKUP_OPERATIONS_UPPER;
// export type DirtyOperation = 'SAVE' | 'DELETE' | 'RENAME';
// export type DirtyOperation = (typeof DIRTY_OPERATIONS)[number];
export type DirtyOperation = BackupOperationUpper;

export type DirtyFileEntry =(
    | { operation: 'SAVE' | 'DELETE'; path: string }
    | { operation: 'RENAME'; path: string; oldPath: string }
);
// Just to verify DirtyOperation is the op used in DirtyFileEntry
export type _AssertDirtyOperations = Assert<IsExtends<DirtyFileEntry['operation'], DirtyOperation>>;

// export type DirtyFilesState = DirtyFileEntry[];

/** Debounced save event with its captured path and identity for activity tracking. */
export interface DebouncedSaveTask {
    id: string;                   // Unique task ID
    path: string;                 // Vault-relative path captured when the event is created
    file?: TFile;                 // Optional transient Obsidian File handle
    timestamp: number;            // Timestamp of task creation
}

/**
 * In-memory state for recently touched files during active session.
 */
export interface CachedNoteState {
    path: string;
    hash: string;
    baseText: string;
    diffDepth: number;
    timestamp: number;
}


/**
 * Stored at: local_data/device.json
 * Machine and installation identity. Written once on initial setup.
 */
export interface DeviceState {
    device: string;               // Persistent UUID identifying this Obsidian client
    vault: string;                // Persistent UUID identifying this vault
}

/**
 * Activity Logging, Tracking, and History schemas.
 * Stored at: local_data/activity_history.json
 */
export const ACTIVITY_STAGES = [
    'debounce',
    'queue',
    'upload',
 ] as const;
export type ActivityStage = (typeof ACTIVITY_STAGES)[number];

export const ACTIVITY_STAGE_STATUSES = [
    'ongoing',
    'pending',
    'active',
    'waiting',
    'completed',
    'bypassed',
    'cancelled',
    'failed',
 ] as const;
export type ActivityStageStatus = (typeof ACTIVITY_STAGE_STATUSES)[number];

export interface ActivityStageInfo {
    status: ActivityStageStatus;
    note?: string;
    timestamp: number;
}

export const LOGGED_ACTIVITY_STATUSES = [
    'ongoing',
    'completed',
    'cancelled',
    'failed',
] as const satisfies readonly ActivityStageStatus[];

export type LoggedStatus = (typeof LOGGED_ACTIVITY_STATUSES)[number];
export interface ActivityRecord {
    id: string;                   // Unique record UUID
    path: string;                 // Vault-relative path
    oldPath?: string;             // For rename events
    event: BackupEventType;
    timestamp: number;            // Timestamp of event creation
    // status: 'ongoing' | 'completed' | 'cancelled' | 'failed';
    status: LoggedStatus;
    debounce?: ActivityStageInfo;
    queue?: ActivityStageInfo;
    upload?: ActivityStageInfo;
}

// export type HashedActivityRecord = ActivityRecord & { recordHash: string };
export type RecordIdsHashed = Map<ActivityRecord['id'], string>;

export interface ActivityEvent {
    taskId?: string;              // Unified task ID correlating to DebouncedSaveTask
    path: string;
    oldPath?: string;
    event?: BackupEventType;
    stage: ActivityStage;
    status: ActivityStageStatus;
    note?: string;
}

/**
 * Common activity logger interface for pipeline stages (debounce, operations, queue)
 * to record progress and lifecycle events without coupling to concrete tracking classes.
 */
export interface ActivityLogger {
    record(event: ActivityEvent): void;
}

export interface ActivityHistoryState {
    version: typeof LOCAL_STATE_VERSION;
    records: ActivityRecord[];
}

import type { SerializableTaskIntent } from '../operations/types';


export const FAILED_TASK_STAGES = ['preparation','upload'] as const;
export type FailedTaskStage = typeof FAILED_TASK_STAGES[number];
export const FAILED_TASK_LIKELY_REASONS = ['size_limit', 'validation_error', 'network_outage', 'other'] as const;
export type FailedTaskLikelyReason = typeof FAILED_TASK_LIKELY_REASONS[number];
/**
 * Failed and abandoned tasks log.
 * Stored at: local_data/failed_tasks.jsonl (JSON Lines format)
 */
export interface FailedTaskRecord {
    id: string;                     // Unique task ID
    intent: SerializableTaskIntent; // JSON-safe domain task intent
    timestamp: number;              // Epoch ms when abandoned
    attempts: number;               // Number of attempts made before abandoning
    stage: FailedTaskStage;         // Failure phase
    error: string;                  // Full server/client error text
    cause: FailedTaskCause;         // Plain serializable error cause
    targetHash?: string;            // Content SHA-256 if computed
    noteSizeBytes?: number;         // Note content size in bytes
    likelyReason?: FailedTaskLikelyReason;
    payloadPreview?: string;        // Preview of payload up to 1,500 chars
}

// Plain serializable error cause
export type FailedTaskCause = {
    name: string;
    message: string;
    status?: number;
};
