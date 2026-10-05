import type { DirtyPathWriter } from '../state/types';
import type { ActivityLogger, DebouncedSaveTask } from '../types/state';

interface DebounceHandle {
    timer: number;
    firstEditTime: number;
    startTime: number;
    expiresAt: number;
    saveTask: DebouncedSaveTask;
}

/**
 * Manages per-file debounce timers with a milestone maxWait timer.
 * Default debounce: 30s; milestone timer: 5m.
 * Coordinates with DirtyFileManager to persist intent on clean-to-dirty transition.
 */
export class DebounceController {
    private activeTimers = new Map<string, DebounceHandle>();
    private logger?: ActivityLogger;
    private isClosed = false;

    constructor(
        private dirtyManager: DirtyPathWriter,
        private debounceIntervalMs: number = 30000,
        private maxWaitMs: number = 300000,
        // Calls processDebouncedFile in op-manager
        private onExecute: (task: DebouncedSaveTask) => Promise<void>,
        logger?: ActivityLogger
    ) {
        this.logger = logger;
    }

    /**
     * Intercepts a file modification event.
     */
    public async schedule(saveTask: DebouncedSaveTask): Promise<void> {
        if (this.isClosed) return;

        const path = saveTask.path;
        await this.dirtyManager.markDirty('SAVE', path);
        if (this.isClosed) return;

        const now = Date.now();
        const existing = this.activeTimers.get(path);

        if (existing) {
            // Check milestone timer
            if (now - existing.firstEditTime >= this.maxWaitMs) {
                await this.trigger(path, false);
                return;
            }
            window.clearTimeout(existing.timer);
            existing.startTime = now;
            existing.expiresAt = now + this.debounceIntervalMs;
            existing.timer = window.setTimeout(() => {
                void this.trigger(path, false);
            }, this.debounceIntervalMs);

            // [Target: State: Activitytracker] Record debounce active in activity log
            this.logger?.record({
                taskId: existing.saveTask.id,
                path,
                stage: 'debounce',
                status: 'active',
                note: 'Active',
            });
        } else {
            const expiresAt = now + this.debounceIntervalMs;
            const timer = window.setTimeout(() => {
                void this.trigger(path, false);
            }, this.debounceIntervalMs);
            this.activeTimers.set(path, { timer, firstEditTime: now, startTime: now, expiresAt, saveTask });

            // [Target: State: Activitytracker] Record debounce active in activity log
            this.logger?.record({
                taskId: saveTask.id,
                path,
                stage: 'debounce',
                status: 'active',
                note: 'Active',
            });
        }
    }

    /**
     * Fires immediate backup for a specific file path.
     */
    private async trigger(path: string, flushedEarly: boolean = false): Promise<void> {
        if (this.isClosed) return;

        const entry = this.activeTimers.get(path);
        if (!entry) return;
        window.clearTimeout(entry.timer);
        this.activeTimers.delete(path);

        const durationMs = Date.now() - entry.startTime;
        // [Target: State: Activitytracker] Record debounce completed in activity log
        this.logger?.record({
            taskId: entry.saveTask.id,
            path,
            stage: 'debounce',
            status: 'completed',
            note: flushedEarly ? 'Flushed' : `${Math.round((durationMs ?? 0) / 1000)}s`,
        });

        try {
            await this.onExecute(entry.saveTask);
        } catch (err) {
            console.error(`[PB Backup] Failed processing backup for ${path}:`, err);
        }
    }

    /**
     * Flushes a specific file immediately (e.g. from row-level "Flush Now" action).
     */
    public async flushFile(path: string): Promise<void> {
        if (this.isClosed) return;
        await this.trigger(path, true);
    }

    /**
     * Cancels any pending timer without executing (e.g. upon delete).
     */
    public cancel(path: string): void {
        const entry = this.activeTimers.get(path);
        if (entry) {
            window.clearTimeout(entry.timer);
            this.activeTimers.delete(path);
            // [Target: State: Activitytracker] Record debounce cancelled in activity log
            this.logger?.record({
                taskId: entry.saveTask.id,
                path,
                stage: 'debounce',
                status: 'cancelled',
                note: 'Cancelled',
            });
        }
    }

    public isPending(path: string): boolean {
        return this.activeTimers.has(path);
    }

    /**
     * Flushes all active debounced files immediately (e.g. on blur or leaf switch).
     */
    public async flushAll(): Promise<void> {
        if (this.isClosed) return;

        const paths = Array.from(this.activeTimers.keys());
        for (const path of paths) {
            await this.trigger(path, true);
        }
    }

    /** Cancels pending debounce timers while leaving dirty journal entries intact. */
    public cancelAll(): void {
        for (const entry of this.activeTimers.values()) {
            window.clearTimeout(entry.timer);
        }
        this.activeTimers.clear();
    }

    /** 
     * Stops accepting new schedules and cancels pending debounce timers. 
     * Called on teardown.
     */
    public close(): void {
        if (this.isClosed) return;
        this.isClosed = true;
        this.cancelAll();
    }

    /**
     * Live updates timing settings from the settings tab without restarting.
     */
    public updateSettings(debounceIntervalMs: number, maxWaitMs: number): void {
        this.debounceIntervalMs = debounceIntervalMs;
        this.maxWaitMs = maxWaitMs;
    }
}
