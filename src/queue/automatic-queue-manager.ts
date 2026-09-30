import { AutomaticQueueProcessor } from './automatic-queue-processor';
import { AutomaticQueueStore } from './automatic-queue-store';
import { QueueStatusNotifier } from './queue-status-notifier';
import type { SyncStatusSource } from '../types/events';
import type { AutoTaskIntent } from '../operations/types';

/** Runtime facade for durable automatic event intake and dispatch. */
export class AutomaticQueueManager implements SyncStatusSource {
    private readonly status: QueueStatusNotifier;
    private isShuttingDown = false;
    public constructor(
        private readonly queue: AutomaticQueueStore,
        private readonly processor: AutomaticQueueProcessor,
    ) {
        this.status = new QueueStatusNotifier(() => this.queue.count());
    }

    public async initialize(): Promise<void> {
        if (this.isShuttingDown) return;
        await this.queue.load();
        if (this.isShuttingDown) return;
        // await this.processor.process();
        this.refreshStatus();
    }

    public async enqueue(intent: AutoTaskIntent): Promise<void> {
        if (this.isShuttingDown) return;
        await this.queue.enqueue(intent);
        if (this.isShuttingDown) return;
        this.status.notifySyncing(undefined, this.queue.count());
        await this.processor.process();
        if (!this.isShuttingDown) this.refreshStatus();
    }

    // SyncStatusSource
    public getPendingCount(): number { return this.queue.count(); }
    public getStatus() { return this.status.getStatus(); }
    // Calls queue-stats-notifier which calls its EventEmitter.subscribe
    public subscribe(listener: Parameters<QueueStatusNotifier['subscribe']>[0]) { return this.status.subscribe(listener); }

    public pause(reason?: string): void {
        if (!this.isShuttingDown) this.processor.pause(reason);
    }

    public resume(reason?: string): void {
        if (!this.isShuttingDown) this.processor.resume(reason);
    }

    public isPaused(): boolean { return this.processor.isPaused(); }

    public async process(): Promise<void> {
        if (this.isShuttingDown) return;
        await this.processor.process();
        if (!this.isShuttingDown) this.refreshStatus();
    }

    public async retryNow(): Promise<void> {
        if (this.isShuttingDown) return;
        await this.queue.retryNow();
        if (this.isShuttingDown) return;
        this.processor.resume('offline');
        this.processor.resume('auth-required');
        await this.processor.process();
        if (!this.isShuttingDown) this.refreshStatus();
    }

    public refreshStatus(): void {
        if (this.isShuttingDown) return;
        const reasons = this.processor.getPauseReasons();
        if (reasons.has('offline')) this.status.notifyOffline('Server offline; automatic uploads are paused.', this.queue.count());
        else if (reasons.has('auth-required')) this.status.notifyAuthRequired(this.queue.count());
        else if (this.processor.isPaused()) this.status.notifyPaused(this.queue.count());
        else if (this.queue.peek()?.nextRetryAt) this.status.notifyWaiting(0, 0, this.queue.count());
        else if (this.queue.count()) this.status.notifySyncing(undefined, this.queue.count());
        else this.status.notifySynced(0);
    }

    /**
     * Called from teardownContainer
     */
    public shutdown(): void {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        this.processor.shutdown();
        this.queue.clear();
    }

    public destroy(): void { this.shutdown(); }
}
