import { AutomaticQueueStore } from './automatic-queue-store';
import { type ActivityLogger, type FailedTaskCause, type FailedTaskStage } from '../types/state';
import { ConnectivityMonitor, type ConnectivityChecker } from './connectivity-monitor';
import { ErrorClassificationPolicy } from '../policies/error-classification-policy';
import type { QueuedTask } from './types';
import type { TaskRunner } from '../operations/types';
import { RunnerExecutionError, type DirtyFileMarker } from '../runner/types';
import type { FailedTasksManager } from '../state/failed-tasks-manager';
import type { RecentNotesCache } from '../state/recent-notes-cache';

export interface AutomaticQueueProcessorOptions {
    connectivityChecker?: ConnectivityChecker;
    onStateChange?: () => void;
    failedTasksManager: FailedTasksManager;
    recentNotesCache: RecentNotesCache;
    dirtyFileMarker: DirtyFileMarker;
}

const RETRY_DELAYS_MS = [5_000, 30_000, 60_000];

/** A single worker that always retries the FIFO head before later tasks. */
export class AutomaticQueueProcessor {
    private currentProcessingPromise: Promise<void> | null = null;
    private readonly pauseReasons = new Set<string>();
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly connectivityMonitor?: ConnectivityMonitor;
    private isShuttingDown = false;

    public constructor(
        private readonly queue: AutomaticQueueStore,
        private readonly runner: TaskRunner,
        private readonly logger: ActivityLogger,
        private readonly options: AutomaticQueueProcessorOptions,
    ) {
        this.connectivityMonitor = this.options.connectivityChecker
            ? new ConnectivityMonitor(this.options.connectivityChecker)
            : undefined;
    }

    public pause(reason = 'manual'): void {
        if (this.isShuttingDown) return;
        this.pauseReasons.add(reason);
        this.cancelRetryTimer();
        this.options.onStateChange?.();
    }

    public resume(reason = 'manual'): void {
        if (this.isShuttingDown) return;
        this.pauseReasons.delete(reason);
        if (!this.isPaused()) {
            this.options.onStateChange?.();
            void this.process();
        }
    }

    public isPaused(): boolean { return this.pauseReasons.size > 0; }
    public getPauseReasons(): ReadonlySet<string> { return this.pauseReasons; }

    public async process(now = Date.now()): Promise<void> {
        if (this.isShuttingDown) return;
        // If paused - offline/auth-required/manual
        if (this.isPaused()) return;
        // If already processing a task
        if (this.currentProcessingPromise) {
            // await this.currentProcessingPromise;
            return this.currentProcessingPromise;
        }
        this.options.onStateChange?.();

        this.currentProcessingPromise = this.drainQueue(now);

        try {
            await this.currentProcessingPromise;
        } finally {
            this.currentProcessingPromise = null;
            if (!this.isShuttingDown) {
                this.options.onStateChange?.();
            }
        }
    }

    /**
     * Iterative loop: runs until the queue is empty, paused, or waiting for retry.
     */
    private async drainQueue(now: number): Promise<void> {
        while (!this.isShuttingDown && !this.isPaused()) {
            // Get task to run
            const head = this.queue.peek();
            // Empty queue, return
            if (!head) return;
            // If the task was scheduled for retry on account for failure
            // And its retry time is yet to reach, schedule it back (setTimeOut process) and return
            if (head.nextRetryAt && head.nextRetryAt > now) {
                this.scheduleRetry(head.nextRetryAt);
                break; 
            }

            await this.processSingleTask(head);
        }
    }

    private async processSingleTask(head: QueuedTask): Promise<void> {
        if (this.isShuttingDown) return;
        // head.attempts += 1;

        // Is retry-task, cancel its RetryTimer
        this.cancelRetryTimer();
        this.logger.record({
            taskId: head.id,
            path: head.intent.path,
            event: head.intent.operation !== 'save' ? head.intent.operation : (head.intent.event === 'recovery' ? 'recovery' : 'modify'),
            oldPath: head.intent.operation === 'rename' ? head.intent.oldPath : undefined,
            stage: 'queue',
            status: 'active',
            note: `attempts: ${head.attempts}`,
        });

        try {
            head.attempts += 1;
            await this.runner.execute(head.intent);
            if (this.isShuttingDown) return;

            this.logger?.record({
                taskId: head.id,
                path: head.intent.path,
                event: head.intent.operation !== 'save' ? head.intent.operation : (head.intent.event === 'recovery' ? 'recovery' : 'modify'),
                oldPath: head.intent.operation === 'rename' ? head.intent.oldPath : undefined,
                stage: 'queue',
                status: 'completed',
                note: `attempts: ${head.attempts}`,
            });
            // Remove task from queue
            await this.queue.acknowledge(head.id);
        } catch (error) {
            if (this.isShuttingDown) return;

            // head.attempts += 1;
            // error message
            const message = error instanceof Error ? error.message : String(error);
            const unwrapped = (error instanceof RunnerExecutionError && error.cause) ? error.cause : error;
            // error catgeory - validation or terminal or auth or connectivity
            const category = ErrorClassificationPolicy.classify(unwrapped);
            // unrecoverable and so fail immediately
            if (category === 'validation' || category === 'terminal_request') {
                await this.fail(head, error, message);
            } else if (category === 'authentication') { // pause for user to auth
                await this.queue.recordRetry(head.id, message, Date.now());
                if (this.isShuttingDown) return;
                this.pause('auth-required');
            } else {
                const isOffline = await this.isOffline();
                if (this.isShuttingDown) return;

                if (isOffline) { // pause for connectivity to return
                    await this.queue.recordRetry(head.id, message, Date.now());
                    if (this.isShuttingDown) return;
                    this.pause('offline');
                    // Wait for connectivity wtith health checks using setTimeout
                    this.connectivityMonitor?.waitForRecovery(() => this.resume('offline'));
                } else { // some other like retryable_request
                    // delay will be undefined after the conigured retry delays are passed
                    const retryAttemptIndex = head.attempts-1; // Need 0-indexed for RETRY_DELAYS_MS
                    const delay = RETRY_DELAYS_MS[retryAttemptIndex];
                    // fail
                    if (delay === undefined) {
                        await this.fail({ ...head, attempts: head.attempts}, error, message);
                    // schedule retry
                    } else {
                        await this.queue.recordRetry(head.id, message, Date.now() + delay);
                    }
                }
            }
        }
    }

    /**
     * Called from queue manager shutdown on teardown
     */
    public shutdown(): void {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        // Make isPaused return false
        this.pauseReasons.add('shutdown');
        // Cancel timers if on
        this.cancelRetryTimer();
        // Cancel connectivity check timer if on
        this.connectivityMonitor?.cancel();
    }

    public destroy(): void { this.shutdown(); }

    // Normalize an unknown thrown value into a FailedTaskCause, falling back
    // to the provided defaults for any missing fields.
    private static toFailedTaskCause(
        source: unknown,
        fallback: { name: string; message: string }
    ): FailedTaskCause {
        const inner = (source && typeof source === 'object')
            ? source as { name?: unknown; message?: unknown; status?: unknown }
            : undefined;
        return {
            name: typeof inner?.name === 'string' && inner.name ? inner.name : fallback.name,
            message: typeof inner?.message === 'string' && inner.message ? inner.message : fallback.message,
            status: typeof inner?.status === 'number' ? inner.status : undefined,
        };
    }

    private async fail(task: QueuedTask, error: unknown, reason: string): Promise<void> {
        if (this.isShuttingDown) return;

        let stage: FailedTaskStage;
        let cause: FailedTaskCause;
        let targetHash: string | undefined = undefined;
        let noteSizeBytes: number | undefined = undefined;
        let payloadPreview: string | undefined = undefined;

        if (error instanceof RunnerExecutionError) {
            // Throw sites always attach the underlying error as cause; use it
            // directly, falling back to the wrapper's own fields.
            stage = error.phase;
            cause = AutomaticQueueProcessor.toFailedTaskCause(error.cause, {
                name: error.name,
                message: error.message,
            });
            targetHash = error.preparedUpload?.targetHash;
            noteSizeBytes = error.noteSizeBytes;
            payloadPreview = error.payloadPreview;
        } else {
            stage = 'upload';
            cause = {
                name: error instanceof Error ? error.name : 'Error',
                message: reason,
                status: (
                    typeof error === 'object' && error !== null &&
                    'status' in error && typeof error.status === 'number'
                ) ? error.status : undefined,
            };
        }

        const diagnosisSource = (error instanceof RunnerExecutionError && error.cause) ? error.cause : error;
        const likelyReason = ErrorClassificationPolicy.diagnose(diagnosisSource);

        await this.options.failedTasksManager.recordTerminalFailure({
            id: task.id,
            intent: task.intent,
            attempts: task.attempts,
            stage,
            error: reason,
            cause,
            targetHash,
            noteSizeBytes,
            likelyReason,
            payloadPreview,
        });
        if (this.isShuttingDown) return;

        this.options.recentNotesCache.delete(task.intent.path);
        if (task.intent.operation === 'rename') {
            this.options.recentNotesCache.delete(task.intent.oldPath);
        }

        this.logger?.record({
            taskId: task.id,
            path: task.intent.path,
            event: task.intent.operation !== 'save' ? task.intent.operation : 'modify',
            oldPath: task.intent.operation === 'rename' ? task.intent.oldPath : undefined,
            stage: 'queue',
            status: 'failed',
            note: `attempts: ${task.attempts}`,
        });

        const acknowledged = await this.queue.acknowledge(task.id);
        if (this.isShuttingDown) return;
        if (!acknowledged) {
            throw new Error(`Queue invariant violation: terminal task ${task.id} is no longer at the queue head.`);
        }

        await this.options.dirtyFileMarker.markClean(task.intent.path);
        if (this.isShuttingDown) return;
        if (task.intent.operation === 'rename') {
            await this.options.dirtyFileMarker.markClean(task.intent.oldPath);
        }
    }

    private scheduleRetry(at: number): void { this.cancelRetryTimer(); this.retryTimer = setTimeout(() => void this.process(), Math.max(0, at - Date.now())); }
    private cancelRetryTimer(): void { if (this.retryTimer !== undefined) clearTimeout(this.retryTimer); this.retryTimer = undefined; }

    private async isOffline(): Promise<boolean> {
        if (!this.options.connectivityChecker) return false;
        try {
            await this.options.connectivityChecker.healthCheck();
            return false;
        } catch {
            return true;
        }
    }
}
