import { ActivityRecord, ActivityHistoryState } from '../types/state';
import { LOCAL_STATE_VERSION } from '../state/constants';
import { RetentionPolicy } from '../policies/retention-policy';
import type { ActivityHistoryPersistence, StateFileReaderWriter } from './types';
import { parseActivityHistoryState } from './state-validation';
import { Mutex } from '../utils/mutex';

const DEBOUNCED_WRITE_DELAY_MS = 5000;
/**
 * Manages bounded activity history persistence on disk.
 * Stored at: local_data/activity_history.json (compact minified JSON)
 * 
 * Rules:
 * - Lazy bounds validation on startup: trims oldest completed records to activityHistoryLimit.
 * - Debounced writes 5s to reduce disk I/O
 * - try to preserve active/ongoing tasks when trimming completed records.
 */
export class ActivityHistoryManager implements ActivityHistoryPersistence {
    public static readonly FILE_NAME = 'activity_history.json';

    private flushTimer: number | null = null;
    private pendingRecords: ActivityRecord[] | null = null;
    private writeMutex = new Mutex();

    private debouncedWriteDelay: number;

    constructor(private storage: StateFileReaderWriter) {
        // write 15 sec late for initial save if on app load
        // Need to avoid this on test
        this.debouncedWriteDelay = DEBOUNCED_WRITE_DELAY_MS + 10_000;
    }

    /**
     * Lazily loads activity history on startup, trims to limit if needed, and writes back.
     */
    public async load(limit: number): Promise<ActivityRecord[]> {
        // 1. Try loading primary activity_history.json
        const raw = await this.storage.read(ActivityHistoryManager.FILE_NAME);

        if (raw) {
            try {
                const state = parseActivityHistoryState(raw);
                if (Array.isArray(state?.records)) {
                    let records = state.records;
                    // Lazy bounds check: trim if records exceed limit
                    if (records.length > limit) {
                        // Need to return this to activity-tracker
                        records = this.trimToBounds(records, limit);
                    }
                    if (state.records.length > limit) {
                        // This duplicates trimToBounds, but pushes back the write during app load
                        await this.scheduleSave(records, limit);
                    }
                    return records;
                }
            } catch (err) {
                console.error('[PB Backup] Corrupt activity_history.json; initializing empty:', err);
            }
        }
        return [];
    }

    /**
     * Schedules a debounced save to disk.
     */
    public async scheduleSave(records: ActivityRecord[], limit: number): Promise<void> {
        this.pendingRecords = this.trimToBounds(records, limit);
        if (this.flushTimer) return;

        this.flushTimer = window.setTimeout(async () => {
            this.flushTimer = null;
            if (this.pendingRecords) {
                await this.writeToDisk(this.pendingRecords);
                this.pendingRecords = null;
            }
        }, this.debouncedWriteDelay);
    }

    /**
     * Flushes pending records immediately (e.g. on unload).
     */
    public async flush(records?: ActivityRecord[], limit: number = 100): Promise<void> {
        if (this.flushTimer) {
            window.clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        const toSave = records ? this.trimToBounds(records, limit) : this.pendingRecords;
        if (toSave) {
            await this.writeToDisk(toSave);
            this.pendingRecords = null;
        }
    }

    /**
     * Trims records so that the total count does not exceed limit.
     * Prioritizes keeping 'ongoing' records, trimming oldest 'completed' or 'cancelled' ones first.
     * Delegates to RetentionPolicy.
     */
    public trimToBounds(records: ActivityRecord[], limit: number): ActivityRecord[] {
        return RetentionPolicy.trimActivityRecords(records, limit);
    }

    private async writeToDisk(records: ActivityRecord[]): Promise<void> {
        const state: ActivityHistoryState = {
            version: LOCAL_STATE_VERSION,
            records,
        };
        await this.writeMutex.runExclusive(async () => {
            await this.storage.write(ActivityHistoryManager.FILE_NAME, JSON.stringify(state));
        });
    }
}
