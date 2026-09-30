import type { QueuedTask } from './types';
import type { AutoTaskIntent } from '../operations/types';
import type { ActivityLogger } from '../types/state';

/**
 * In-memory strictly ordered FIFO queue of automatic uploads wrapping TaskIntent.
 * Persistence across restarts and crashes is guaranteed by dirty_files.tsv.
 */
export class AutomaticQueueStore {
    private tasks: QueuedTask[] = [];

    public constructor(private readonly logger?: ActivityLogger) {}

    public async load(): Promise<QueuedTask[]> {
        return this.getTasks();
    }

    public getTasks(): QueuedTask[] { return this.tasks.map((task) => this.cloneTask(task)); }
    public count(): number { return this.tasks.length; }
    public peek(): QueuedTask | undefined { return this.tasks[0] ? this.cloneTask(this.tasks[0]) : undefined; }

    /**
     * Drops session-only tasks; dirty_files.tsv remains the recovery source.
     * Called on teardown
     */
    public clear(): void {
        this.tasks = [];
    }

    public async enqueue(intent: AutoTaskIntent): Promise<void> {
        if (intent.trigger !== 'auto') {
            throw new Error('AutomaticQueueStore only accepts automatic TaskIntent instances.');
        }

        const task: QueuedTask = {
            id: intent.id,
            intent: { ...intent },
            timestamp: intent.createdAt ?? Date.now(),
            attempts: 0,
        };

        if (task.id !== task.intent.id) {
            throw new Error(`Queue invariant violation: task.id (${task.id}) !== task.intent.id (${task.intent.id})`);
        }

        this.tasks.push(task);
        this.logger?.record({
            taskId: task.id,
            path: task.intent.path,
            event: task.intent.operation !== 'save' ? task.intent.operation : (task.intent.event === 'recovery' ? 'recovery' : 'modify'),
            oldPath: task.intent.operation === 'rename' ? task.intent.oldPath : undefined,
            stage: 'queue',
            status: 'pending',
            note: '',
        });
    }

    /** Removes only the current head, preserving strict FIFO ordering. */
    public async acknowledge(taskId: string): Promise<boolean> {
        if (this.tasks[0]?.id !== taskId) return false;
        this.tasks.shift();
        return true;
    }

    public async recordRetry(taskId: string, errorMessage: string, nextRetryAt: number): Promise<boolean> {
        const task = this.tasks[0];
        if (!task || task.id !== taskId) return false;
        task.attempts += 1;
        task.errorMessage = errorMessage;
        task.lastAttemptTimestamp = Date.now();
        task.nextRetryAt = nextRetryAt;
        this.logger?.record({
            taskId: task.id,
            path: task.intent.path,
            event: task.intent.operation !== 'save' ? task.intent.operation : (task.intent.event === 'recovery' ? 'recovery' : 'modify'),
            oldPath: task.intent.operation === 'rename' ? task.intent.oldPath : undefined,
            stage: 'queue',
            status: 'waiting',
            note: `attempts(${task.attempts})`,
        });
        return true;
    }

    public async retryNow(): Promise<void> {
        const task = this.tasks[0];
        if (!task) return;
        task.nextRetryAt = undefined;
    }

    private cloneTask(task: QueuedTask): QueuedTask {
        return {
            ...task,
            intent: { ...task.intent },
        };
    }
}
