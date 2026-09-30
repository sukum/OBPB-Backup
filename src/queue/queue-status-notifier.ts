import { EventEmitter } from '../utils/event-emitter';
import type { SyncStatusState, SyncStatusEvent, SyncStatusSource } from '../types/events';

/**
 * Syncs status state transitions to Obsidian status bar and activity manager
 */
export class QueueStatusNotifier implements SyncStatusSource {
    private currentStatus: SyncStatusState = 'synced';
    private statusNotifier = new EventEmitter<SyncStatusEvent>();

    constructor(private getPendingCountCallback: () => number = () => 0) {}

    public setPendingCountProvider(provider: () => number): void {
        this.getPendingCountCallback = provider;
    }

    public getPendingCount(): number {
        return this.getPendingCountCallback();
    }

    public getStatus(): SyncStatusState {
        return this.currentStatus;
    }

    /**
     * Subscribes a listener to sync status updates and immediately receives current status.
     * Returns an unsubscription closure.
     * Currently used by actvivity-manager-view UI to renderTable and status-bar UI to update status bar
     * they both pass in the listener callbacks for this
     */
    public subscribe(listener: (event: SyncStatusEvent) => void): () => void {
        const unsubscribe = this.statusNotifier.subscribe(listener);
        listener({
            status: this.currentStatus,
            pendingCount: this.getPendingCount(),
        });
        return unsubscribe;
    }

    public notify(status: SyncStatusState, message?: string, pendingCount?: number): void {
        this.currentStatus = status;
        const count = pendingCount !== undefined ? pendingCount : this.getPendingCount();
        const event: SyncStatusEvent = {
            status,
            pendingCount: count,
            message,
        };
        this.statusNotifier.notify(event);
    }

    public notifySynced(pendingCount: number = 0): void {
        this.notify('synced', undefined, pendingCount);
    }

    public notifySyncing(path?: string, pendingCount?: number): void {
        const message = path ? `Uploading ${path}...` : undefined;
        this.notify('syncing', message, pendingCount);
    }

    public notifyWaiting(attempts: number, delayMs: number, pendingCount?: number, isRequeue: boolean = false): void {
        const seconds = delayMs / 1000;
        const note = isRequeue
            ? `Upload failed (${attempts} attempt). Waiting ${seconds} sec before requeue attempt.`
            : `Upload failed (${attempts} attempt). Waiting ${seconds} sec to retry again.`;
        this.notify('waiting', note, pendingCount);
    }

    public notifyPaused(pendingCount?: number): void {
        const count = pendingCount !== undefined ? pendingCount : this.getPendingCount();
        this.notify('paused', `Uploads paused (${count} queued)`, count);
    }

    public notifyOffline(message: string, pendingCount?: number): void {
        this.notify('offline', message, pendingCount);
    }

    public notifyAuthRequired(pendingCount?: number): void {
        this.notify('auth_required', 'Authentication failed; please check login credentials.', pendingCount);
    }

    public notifyAbandoned(reason: string, path: string, pendingCount?: number): void {
        this.notify('offline', `Task abandoned (${reason}): ${path}`, pendingCount);
    }
}
