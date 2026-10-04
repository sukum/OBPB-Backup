import { App, Modal, Notice } from 'obsidian';
import type { BackupStore } from '../../remote/backup-store';
import type { LatestVaultFilesViewRecord } from '../../types/database';
import type { TrashModalOperations } from './types';
import { TrashNotePreviewModal } from './trash-note-modal';
/**
 * Modal for browsing and recovering notes that were deleted from the local vault.
 * Queries latest_vault_files view collection.
 * a seaparate view with delete condition might be better. need to loook into it. 
 */
export class TrashModal extends Modal {
    constructor(
        app: App,
        private vaultId: string,
        private store: Pick<BackupStore, 'getLatestFiles'>,
        private operationsManager: TrashModalOperations
    ) {
        super(app);
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('obpb_trash_modal');

        contentEl.createEl('h2', { text: 'Deleted notes recovery (Trash)' });
        contentEl.createEl('p', {
            text: 'Browse and restore files that were deleted from your local vault.',
        });

        const loadingEl = contentEl.createEl('p', { text: 'Loading deleted files from backup history...' });
        const listContainer = contentEl.createDiv({ cls: 'obpb_trash_list' });

        try {
            const deletedFiles: LatestVaultFilesViewRecord[] = await this.store.getLatestFiles(
                this.vaultId,
                true // deleted only
            );

            loadingEl.remove();

            if (deletedFiles.length === 0) {
                listContainer.createEl('p', {
                    cls: 'obpb_empty',
                    text: 'No deleted notes found in backup history.',
                });
                return;
            }

            for (const item of deletedFiles) {
                const row = listContainer.createDiv({ cls: 'obpb_trash_item' });
                const infoDiv = row.createDiv({ cls: 'obpb_trash_info' });

                infoDiv.createEl('div', { cls: 'obpb_trash_path', text: item.path });
                const dateStr = new Date(item.timestamp).toLocaleString();
                infoDiv.createEl('div', {
                    cls: 'obpb_trash_date',
                    text: `Deleted on: ${dateStr} (${item.hash.slice(0, 8)})`,
                });

                const actionsDiv = row.createDiv({ cls: 'obpb_trash_actions' });
                const restoreBtn = actionsDiv.createEl('button', {
                    cls: 'mod-cta',
                    text: 'Restore file',
                });

                restoreBtn.addEventListener('click', async () => {
                    restoreBtn.disabled = true;
                    restoreBtn.setText('Restoring...');
                    try {
                        const res = await this.operationsManager.restoreVersion(
                            this.vaultId,
                            item.path,
                            item.hash,
                            { notify: (msg) => new Notice(msg) }
                        );
                        if (res.status === 'unchanged') {
                            new Notice(`No changes were made to ${item.path}`);
                        } else if (res.status === 'modified') {
                            new Notice(`Successfully restored ${item.path}`);
                        } else if (res.status === 'created') {
                            new Notice(`Successfully created ${item.path}`);
                        }

                        if (res.status !== 'unchanged') {
                            row.remove();
                        }
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        new Notice(`Failed to restore ${item.path}: ${msg}`);
                    } finally {
                        setTimeout(() => {
                            if (restoreBtn) {
                                restoreBtn.disabled = false;
                                restoreBtn.setText('Restore File');
                            }
                        }, 50);
                    }
                });

                const viewBtn = actionsDiv.createEl('button', {
                    text: 'View',
                    attr: { 'aria-label': `View last version of ${item.path}` },
                });
                viewBtn.addEventListener('click', () => {
                    new TrashNotePreviewModal(
                        this.app,
                        this.vaultId,
                        item.path,
                        item.hash,
                        this.operationsManager
                    ).open();
                });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            loadingEl.setText(`Failed to load deleted files: ${msg}`);
            loadingEl.addClass('obpb_error');
        }
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}
