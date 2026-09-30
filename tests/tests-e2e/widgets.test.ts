import test from 'node:test';
import assert from 'node:assert/strict';
import './setup-dom';
import { StatusBarWidget } from '../../src/ui/status-bar';
import { TrashModal } from '../../src/ui/trash/trash-modal';
import { createTestContext } from './mocks/test-context';
import { SyncStatusEvent } from '../../src/types/events';
import { LatestVaultFilesViewRecord } from '../../src/types/database';
import { Notice } from 'obsidian';
import { RestoreResult, RestoreVersionOptions } from '../../src/reconstruct/types';

test('StatusBarWidget status updates, aria-labels, click action, and cleanup', () => {
    const el = document.createElement('div');

    let queueProcessed = false;
    let subscriber: ((event: SyncStatusEvent) => void) | null = null;

    const mockNotifier = {
        processQueue: async () => { queueProcessed = true; },
        subscribe: (cb: (event: SyncStatusEvent) => void) => {
            subscriber = cb;
            return () => { subscriber = null; };
        },
    };

    const widget = new StatusBarWidget(el, mockNotifier);
    assert.ok(el.classList.contains('obpb_status_bar'));

    // Test click trigger
    el.click();
    assert.equal(queueProcessed, true);

    widget.initialize();
    assert.ok(subscriber);
    const notifySubscriber = subscriber as (event: SyncStatusEvent) => void;

    // 1. Synced state
    notifySubscriber({ status: 'synced', pendingCount: 0 });
    assert.ok(el.querySelector('.obpb_status_synced'));
    assert.equal(el.querySelector('.obpb_status_text')?.textContent, 'PB');
    assert.equal(el.getAttribute('aria-label'), 'OBPB Backup: All files backed up.');

    // 2. Syncing state
    notifySubscriber({ status: 'syncing', pendingCount: 4 });
    assert.ok(el.querySelector('.obpb_status_syncing'));
    assert.equal(el.querySelector('.obpb_status_text')?.textContent, 'PB (4)');
    assert.ok(el.getAttribute('aria-label')?.includes('4 pending uploads'));

    // 3. Offline state
    notifySubscriber({ status: 'offline', pendingCount: 7 });
    assert.ok(el.querySelector('.obpb_status_offline'));
    assert.equal(el.querySelector('.obpb_status_text')?.textContent, 'PB (7)');

    // 4. Error / Auth required state
    notifySubscriber({ status: 'error', pendingCount: 0, message: 'Invalid credentials' });
    assert.ok(el.querySelector('.obpb_status_error'));
    assert.ok(el.getAttribute('aria-label')?.includes('Invalid credentials'));

    // 5. Paused state
    notifySubscriber({ status: 'paused', pendingCount: 2, message: 'Queue is paused' });
    assert.equal(el.querySelector('.obpb_status_text')?.textContent, 'PB (2)');

    // 6. Destroy cleanup
    widget.destroy();
    assert.equal(subscriber, null);
});

test('TrashModal query, deleted file list, restore execution, and error handling', async () => {
    const { plugin, mocks } = createTestContext();

    const mockDeletedFiles: LatestVaultFilesViewRecord[] = [
        {
            id: 'entry-1',
            vault: 'test-vault-id',
            path: 'Deleted/OldNotes.md',
            operation: 'delete',
            timestamp: Date.now() - 3600000,
            hash: 'hashdeadbeef1234',
            objectId: 'obj-123456789012',
        },
    ];

    // 1. Populated list and restore flow
    mocks.pocketBaseStore.getLatestFiles = async (v: string, deletedOnly = false) => {
        return mockDeletedFiles;
    };

    let restoredPath = '';
    let restoredHash = '';
    mocks.operationsManager.restoreVersion = async (v: string, p: string, h: string, options: RestoreVersionOptions): Promise<RestoreResult> => {
        restoredPath = p;
        restoredHash = h;
        return { status: 'modified', path: p };
    };

    const modal = new TrashModal(plugin.app, 'test-vault-id', mocks.pocketBaseStore, mocks.operationsManager);
    await modal.onOpen();

    assert.ok(modal.contentEl.querySelector('h2')?.textContent?.includes('Deleted Notes Recovery'));
    const trashItem = modal.contentEl.querySelector('.obpb_trash_item') as HTMLElement;
    assert.ok(trashItem);
    assert.ok(trashItem.querySelector('.obpb_trash_path')?.textContent?.includes('OldNotes.md'));

    const restoreBtn = trashItem.querySelector('button') as HTMLButtonElement;
    assert.ok(restoreBtn);
    await restoreBtn.click();

    assert.equal(restoredPath, 'Deleted/OldNotes.md');
    assert.equal(restoredHash, 'hashdeadbeef1234');
    // Row should be removed on successful restore
    assert.equal(modal.contentEl.querySelector('.obpb_trash_item'), null);

    modal.onClose();
    assert.equal(modal.contentEl.children.length, 0);

    // 2. Empty state
    mocks.pocketBaseStore.getLatestFiles = async () => [];
    const emptyModal = new TrashModal(plugin.app, 'test-vault-id', mocks.pocketBaseStore, mocks.operationsManager);
    await emptyModal.onOpen();
    assert.ok(emptyModal.contentEl.querySelector('.obpb_empty')?.textContent?.includes('No deleted notes found'));

    // 3. Restore error handling
    mocks.pocketBaseStore.getLatestFiles = async () => mockDeletedFiles;
    mocks.operationsManager.restoreVersion = async () => {
        throw new Error('Disk full');
    };

    const errorModal = new TrashModal(plugin.app, 'test-vault-id', mocks.pocketBaseStore, mocks.operationsManager);
    await errorModal.onOpen();
    const errRestoreBtn = errorModal.contentEl.querySelector('.obpb_trash_item button') as HTMLButtonElement;
    (Notice as any).clear();
    await errRestoreBtn.click();
    assert.ok((Notice as any).notices.some((n: any) => n.message.includes('Failed to restore Deleted/OldNotes.md: Disk full')));
    assert.equal(errRestoreBtn.disabled, false);

    // 4. Store query failure
    mocks.pocketBaseStore.getLatestFiles = async () => {
        throw new Error('Connection failed');
    };
    const queryFailModal = new TrashModal(plugin.app, 'test-vault-id', mocks.pocketBaseStore, mocks.operationsManager);
    await queryFailModal.onOpen();
    assert.ok(queryFailModal.contentEl.querySelector('.obpb_error')?.textContent?.includes('Failed to load deleted files: Connection failed'));
});
