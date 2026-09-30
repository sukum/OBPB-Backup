/**
 * Internal event types and status states for OBPB Backup.
 */

export const SYNC_STATUS_STATES = [
    'synced',
    'syncing',
    'offline',
    'error',
    'auth_required',
    'paused',
    'waiting',
] as const;

export type SyncStatusState = (typeof SYNC_STATUS_STATES)[number];

export interface SyncStatusEvent {
    status: SyncStatusState;
    pendingCount: number;
    message?: string;
}

/** Read-only subscription capability for queue synchronization status. */
export interface SyncStatusSubscriber {
    subscribe(listener: (event: SyncStatusEvent) => void): () => void;
}

/** Read-only snapshot capability for the current synchronization status. */
export interface SyncStatusReader {
    getStatus(): SyncStatusState;
    getPendingCount(): number;
}

/** Complete read-only status capability exposed by the queue subsystem. */
export interface SyncStatusSource extends SyncStatusSubscriber, SyncStatusReader {}
