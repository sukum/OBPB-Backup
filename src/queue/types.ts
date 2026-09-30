import type { AutoTaskIntent } from '../operations/types';

/**
 * In-memory FIFO queue task wrapping a TaskIntent.
 * Persistence across restarts and crashes is guaranteed by dirty_files.tsv.
 */
export interface QueuedTask {
    /** Unique task UUID (strictly matching intent.id) */
    id: string;
    /** The original un-prepared intent */
    intent: AutoTaskIntent;
    /** Enqueue epoch ms */
    timestamp: number;
    /** Number of execution attempts */
    attempts: number;
    /** Epoch ms of the most recent failed attempt */
    lastAttemptTimestamp?: number;
    /** Error message from the last failure */
    errorMessage?: string;
    /** Epoch ms until which retry is deferred (backoff) */
    nextRetryAt?: number;
}
