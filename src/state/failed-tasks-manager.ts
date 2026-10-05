import { FailedTaskRecord } from '../types/state';
import { serializeTaskIntent } from '../operations/types';
import type { FailedTasksStorage, RecordTerminalFailureInput } from './types';
import { EventEmitter } from '../utils/event-emitter';
import { isRecord } from '../utils/guards';
import { parseFailedTaskRecord } from './state-validation';
import { Mutex } from '../utils/mutex';
import { truncatePayloadPreview } from '../utils/failed-task-payload-preview';

export const DEFAULT_FAILED_TASKS_BOUND = 500;
const DEBOUNCE_FLUSH_TIMEOUT_MS = 5000; // writes only after 5 seconds after called

/**
 * Manages failed and abandoned upload tasks.
 * Stored as JSON Lines at: local_data/failed_tasks.jsonl
 * 
 * Rules:
 * - Keeps newest records up to maxFailedTasksLimit (FIFO pruning of oldest).
 * - Debounces disk writes (1s) with immediate flush on shutdown.
 * - Publishes change events to subscribers (e.g. ActivityManagerView Failed Tasks tab).
 */
export class FailedTasksManager {
    public static readonly FILE_NAME = 'failed_tasks.jsonl';
    // public static readonly RECOVERY_DIRECTORY = 'failed_content';
    private tasks: FailedTaskRecord[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private changeEmitter = new EventEmitter<void>();
    private writeMutex = new Mutex();
    private debouncedWriteDelay: number;

    constructor(private storage: FailedTasksStorage) {
        // write 10 sec late for initial save if on app load
        // Need to avoid this on test
        this.debouncedWriteDelay = DEBOUNCE_FLUSH_TIMEOUT_MS + 10_000;
    }

    /**
     * Initializes and loads failed tasks from local disk.
     */
    public async initialize(limit: number = DEFAULT_FAILED_TASKS_BOUND): Promise<FailedTaskRecord[]> {
        const raw = await this.storage.read(FailedTasksManager.FILE_NAME);
        if (raw) {
            try {
                const parsed: FailedTaskRecord[] = [];
                for (const line of raw.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const candidate: unknown = JSON.parse(trimmed);
                        if (!isRecord(candidate)) {
                            throw new Error('Failed task line must contain an object.');
                        }
                        if (!('laneId' in candidate) && !('intentId' in candidate)) {
                            parsed.push(parseFailedTaskRecord(trimmed));
                        }
                    } catch (parseErr) {
                        console.warn('[PB Backup] Skipping corrupt line in failed_tasks.jsonl:', parseErr);
                    }
                }
                this.tasks = parsed;
                if (this.tasks.length > limit) {
                    this.tasks = this.tasks.slice(-limit);
                    // await this.writeToDisk();
                    // push write away from app/plugin loading
                    await this.scheduleSave();
                }
                return [...this.tasks];
            } catch (err) {
                console.error('[PB Backup] Corrupt failed_tasks.jsonl; initializing empty:', err);
                this.tasks = [];
            }
        }
        return [];
    }

    public subscribe(listener: () => void): () => void {
        return this.changeEmitter.subscribe(listener);
    }

    // [Target: UI: ActivityManagerView] Notify view to refresh failed tasks table
    private notify(): void {
        this.changeEmitter.notify();
    }

    public getFailedTasks(): FailedTaskRecord[] {
        return [...this.tasks];
    }

    public getCount(): number {
        return this.tasks.length;
    }

    public getRecoveryFilePath(file: string): string {
        return this.storage.getPath(file);
    }

    /**
     * Durably records a terminal task failure with pure TaskIntent and captured diagnostics.
    */
    public async recordTerminalFailure(
        recordData: RecordTerminalFailureInput,
        limit: number = DEFAULT_FAILED_TASKS_BOUND
    ): Promise<FailedTaskRecord> {
        const record: FailedTaskRecord = {
            id: recordData.id,
            intent: serializeTaskIntent(recordData.intent),
            timestamp: Date.now(),
            attempts: recordData.attempts,
            stage: recordData.stage,
            error: recordData.error,
            cause: recordData.cause,
            targetHash: recordData.targetHash,
            noteSizeBytes: recordData.noteSizeBytes ?? 0,
            likelyReason: recordData.likelyReason ?? 'other',
            payloadPreview: truncatePayloadPreview(recordData.payloadPreview),
        };

        const existingIdx = this.tasks.findIndex((t) => t.id === recordData.id);
        if (existingIdx >= 0) {
            this.tasks.splice(existingIdx, 1);
        }
        this.tasks.push(record);

        if (this.tasks.length > limit) {
            this.tasks = this.tasks.slice(-limit);
        }

        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        await this.scheduleSave();
        this.notify();
        return record;
    }

    /**
     * Removes an individual failed task from the log.
     */
    public async removeFailedTask(taskId: string): Promise<boolean> {
        const idx = this.tasks.findIndex((t) => t.id === taskId);
        if (idx >= 0) {
            this.tasks.splice(idx, 1);
            this.scheduleSave();
            this.notify();
            return true;
        }
        return false;
    }

    public async remove(taskId: string): Promise<boolean> {
        return this.removeFailedTask(taskId);
    }

    public async updateFailedTask(record: FailedTaskRecord): Promise<void> {
        const idx = this.tasks.findIndex((t) => t.id === record.id);
        if (idx >= 0) { // if existing
            this.tasks[idx] = record;
        } else { // new
            this.tasks.push(record);
        }
        this.scheduleSave();
        this.notify();
    }

    /**
     * Clears all failed tasks from the log.
     */
    public async clearAll(): Promise<void> {
        this.tasks = [];
        await this.writeToDisk();
        this.notify();
    }

    /**
     * Schedules a debounced disk save.
     */
    private scheduleSave(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(async () => {
            this.flushTimer = null;
            await this.writeToDisk();
        }, this.debouncedWriteDelay);
    }

    /**
     * Immediately writes the current in-memory tasks to disk as JSON Lines.
     */
    public async writeToDisk(): Promise<void> {
        await this.writeMutex.runExclusive(async () => {
            const lines = this.tasks.map((t) => JSON.stringify(t));
            const content = lines.length > 0 ? lines.join('\n') + '\n' : '';
            await this.storage.write(FailedTasksManager.FILE_NAME, content);
        });
    }

    /**
     * Flushes any pending debounced writes immediately.
     */
    public async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
            await this.writeToDisk();
        }
    }

}
