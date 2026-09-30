import { ActivityRecord, ActivityStageInfo, ActivityEvent, ActivityLogger, RecordIdsHashed } from '../types/state';
import type { ActivityHistoryPersistence } from './types';
import { generateUUID } from '../utils/uuid';
import { EventEmitter } from '../utils/event-emitter';
import { simpleHash } from '../hashing/simple-hash';
import { stableSerialize } from '../hashing/serialize';

export type ActivityTrackerListener = () => void;

// Fields excluded from hashing since they change on every event without reflecting a meaningful state change
const HASH_EXCLUDED_KEYS = new Set(['timestamp']);

/**
 * Central logger for automatic backup activities.
 * record updated debounce, queue and upload related states
 * Not recorded for manual user actions like batch backup and batch sync
 */
export class ActivityTracker implements ActivityLogger {
    private records: ActivityRecord[] = [];
    private recordsById = new Map<string, ActivityRecord>();
    private activeByPath = new Map<string, string>(); // path -> activity record ID
    private changeEmitter = new EventEmitter<void>();
    private recordHashes: RecordIdsHashed = new Map();

    constructor(
        private historyManager: ActivityHistoryPersistence,
        private getLimit: () => number
    ) {}

    /**
     * Initializes tracker with persisted records from disk.
     */
    public async initialize(): Promise<void> {
        const loaded = await this.historyManager.load(this.getLimit());
        this.records = loaded;
        for (const record of this.records) {
            this.recordsById.set(record.id, record);
            if (record.status === 'ongoing') {
                this.activeByPath.set(record.path, record.id);
            }
            this.recordHashes.set(record.id, this.calculateHash(record));
        }
    }

    /**
     * activity-manager-view subscribes to this to rerender
     */
    public subscribe(listener: ActivityTrackerListener): () => void {
        return this.changeEmitter.subscribe(listener);
    }

    // [Target: UI: ActivityManagerView] Notify view to refresh activity table rows
    private notify(): void {
        this.changeEmitter.notify();
        // this.historyManager.scheduleSave(this.records, this.getLimit());
    }

    public getRecords(): ActivityRecord[] {
        return [...this.records];
    }

    public getRecordHashes(): RecordIdsHashed {
        return this.recordHashes;
    }

    public getRecordById(id: string): ActivityRecord | undefined {
        return this.recordsById.get(id);
    }

    // seems unused
    public getActiveRecordForPath(path: string): ActivityRecord | undefined {
        const id = this.activeByPath.get(path);
        return id ? this.recordsById.get(id) : undefined;
    }

    /**
     * Calculates a hash for the given activity record, omitting 'timestamp' fields
     * at every depth (including nested debounce/queue/upload stage info).
     * Used in renderRow in Activity Manager UI to efficiently detect changes
     */
    private calculateHash(record: ActivityRecord): string {
        return simpleHash(stableSerialize(record, HASH_EXCLUDED_KEYS));
    }

    /**
     * activity event into the active or newly created ActivityRecord.
     * lifecycle from DebouncedSaveTask to ActivityRecord.
     */
    public record(event: ActivityEvent): void {
        let record: ActivityRecord | undefined;

        // 1. Try resolving by explicit taskId first (unified ID model)
        if (event.taskId) {
            record = this.recordsById.get(event.taskId);
        }

        // 2. Fallback to active path lookup if taskId wasn't provided or not found
        if (!record) {
            const activeId = this.activeByPath.get(event.path);
            if (activeId) {
                record = this.recordsById.get(activeId);
            }
        }

        if (!record) {
            const id = event.taskId || generateUUID();
            record = {
                id,
                path: event.path,
                oldPath: event.oldPath,
                event: event.event || 'modify',
                timestamp: Date.now(),
                status: 'ongoing',
            };
            this.records.push(record);
            this.recordsById.set(id, record);
            this.activeByPath.set(event.path, id);
        } else {
            if (event.event) {
                record.event = event.event;
            }
            if (event.oldPath) {
                record.oldPath = event.oldPath;
            }
            if (event.path && event.path !== record.path) {
                this.activeByPath.delete(record.path);
                record.path = event.path;
                this.activeByPath.set(event.path, record.id);
            }
        }

        const stageInfo: ActivityStageInfo = {
            status: event.status,
            note: event.note,
            timestamp: Date.now(),
        };

        if (event.stage === 'debounce') {
            record.debounce = stageInfo;
        } else if (event.stage === 'queue') {
            record.queue = stageInfo;
        } else if (event.stage === 'upload') {
            record.upload = stageInfo;
        }

        // Finalize lifecycle when upload finishes, event is cancelled, or content is unchanged
        const isFinal = (event.stage === 'upload' && (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled'))
            || event.status === 'cancelled'
            || (event.note === 'Unchanged' && event.status === 'completed');

        if (isFinal) {
            record.status = (event.status === 'cancelled' || event.status === 'failed') ? event.status : 'completed';
            if (this.activeByPath.get(record.path) === record.id) {
                this.activeByPath.delete(record.path);
            }
        }

        // Calculate hashes so that renderRow in Activity MAnager UI can efficiently detect changes
        this.recordHashes.set(record.id, this.calculateHash(record));

        this.notify();
    }

    public clearCompleted(): void {
        const kept: ActivityRecord[] = [];
        for (const r of this.records) {
            if (r.status === 'ongoing') {
                kept.push(r);
                continue;
            }
            // Prune all indices together so no stale entries remain for removed records
            this.recordsById.delete(r.id);
            this.recordHashes.delete(r.id);
            if (this.activeByPath.get(r.path) === r.id) {
                this.activeByPath.delete(r.path);
            }
        }
        this.records = kept;
        this.notify();
        void this.historyManager.flush(this.records, this.getLimit());
    }

    public dismissRecord(id: string): void {
        const idx = this.records.findIndex(r => r.id === id);
        if (idx >= 0) {
            const r = this.records[idx];
            this.records.splice(idx, 1);
            // Prune all indices together so no stale entries remain for the removed record
            this.recordsById.delete(id);
            this.recordHashes.delete(id);
            if (r.status === 'ongoing') {
                this.activeByPath.delete(r.path);
            }
            this.notify();
        }
    }
}
