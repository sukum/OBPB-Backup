import { setIcon } from 'obsidian';
import type { SyncStatusEvent, SyncStatusSubscriber } from '../types/events';

export interface StatusBarSyncTriggerable extends SyncStatusSubscriber {
    processQueue?: () => Promise<void>;
}

/**
 * Status bar item displaying current sync, offline, or auth state.
 */
export class StatusBarWidget {
    private unsubscribe: (() => void) | null = null;

    constructor(
        private statusBarEl: HTMLElement,
        private notifier: StatusBarSyncTriggerable
    ) {
        this.statusBarEl.addClass('pb_status_bar');
        this.statusBarEl.addEventListener('click', () => {
            void this.notifier.processQueue?.();
        });
    }

    public initialize(): void {
        // Subscribe to sync state updates to refresh the status bar icon.
        this.unsubscribe = this.notifier.subscribe((event: SyncStatusEvent) => {
            this.update(event);
        });
    }

    private update(event: SyncStatusEvent): void {
        this.statusBarEl.empty();
        const iconSpan = this.statusBarEl.createSpan({ cls: 'pb_status_icon' });
        const textSpan = this.statusBarEl.createSpan({ cls: 'pb_status_text' });

        switch (event.status) {
            case 'synced':
                setIcon(iconSpan, 'check-circle');
                iconSpan.addClass('pb_status_synced');
                textSpan.setText('PB');
                this.statusBarEl.setAttribute('aria-label', 'PB Backup: All files backed up.');
                break;
            case 'syncing':
                setIcon(iconSpan, 'sync');
                iconSpan.addClass('pb_status_syncing');
                textSpan.setText(`PB (${event.pendingCount})`);
                this.statusBarEl.setAttribute(
                    'aria-label',
                    `PB Backup: Syncing (${event.pendingCount} pending uploads)`
                );
                break;
            case 'offline':
                setIcon(iconSpan, 'cloud-off');
                iconSpan.addClass('pb_status_offline');
                textSpan.setText(`PB (${event.pendingCount})`);
                this.statusBarEl.setAttribute(
                    'aria-label',
                    `PB Backup: Offline (${event.pendingCount} queued; will sync when reconnected)`
                );
                break;
            case 'auth_required':
            case 'error':
                setIcon(iconSpan, 'alert-triangle');
                iconSpan.addClass('pb_status_error');
                textSpan.setText('PB');
                this.statusBarEl.setAttribute(
                    'aria-label',
                    `PB Backup: ${event.message || 'Authentication or connection error'}`
                );
                break;
            case 'paused':
            case 'waiting':
                setIcon(iconSpan, event.status === 'paused' ? 'pause-circle' : 'hourglass');
                iconSpan.addClass('pb_status_offline');
                textSpan.setText(`PB (${event.pendingCount})`);
                this.statusBarEl.setAttribute('aria-label', `PB Backup: ${event.message || event.status}`);
                break;
        }
    }

    public destroy(): void {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
    }
}
