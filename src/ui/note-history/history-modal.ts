import { App, Modal, Setting, Notice, TFile } from 'obsidian';
import type { FileHistorySummary } from '../../types/database';
import { DiffViewer } from '../components/diff-viewer';
import { DiffEngine } from '../../diff/diff-engine';
import { formatBytes } from '../../utils/format';
import { Hasher } from '../../hashing/hasher';
import type { NoteHistoryBuildContext } from './types';

/**
 * display historical version of a note
 */
export class HistoryModal extends Modal {
    constructor(
        app: App,
        private context: NoteHistoryBuildContext,
        private fileRecord: FileHistorySummary,
    ) {
        super(app);
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        // Make text selectable. Obsidian disables text selectability.
        contentEl.addClass('u-select-text');
        contentEl.empty();
        contentEl.addClass('obpb_history_modal');

        contentEl.createEl('h2', {
            text: `Version History: ${this.fileRecord.path} (${Hasher.hashStub8(this.fileRecord.hash)})`,
        });

        const metaEl = contentEl.createDiv({ cls: 'obpb_modal_meta' });
        const dateStr = new Date(this.fileRecord.timestamp).toLocaleString();
        metaEl.createSpan({ text: `Date: ${dateStr} | ` });
        metaEl.createSpan({ text: `Type: ${this.fileRecord.type} | ` });
        metaEl.createSpan({ text: `Size: ${formatBytes(this.fileRecord.size)} | ` });
        metaEl.createSpan({ text: `Device: ${this.fileRecord.device.slice(0, 8)}` });

        const loadingEl = contentEl.createEl('p', { text: 'Reconstructing historical version...' });
        const diffContainer = contentEl.createDiv();

        try {
            const historicalContent = await this.context.operationsManager.reconstructVersion(
                this.context.getVaultId(),
                this.fileRecord.path,
                this.fileRecord.hash
            );

            loadingEl.remove();

            // Read current local file content if present
            let currentContent = '';
            const abstract = this.app.vault.getAbstractFileByPath(this.fileRecord.path);
            if (abstract instanceof TFile) {
                currentContent = DiffEngine.normalizeNewlines(await this.app.vault.cachedRead(abstract));
            }

            // DiffViewer.renderDiff(diffContainer, historicalContent, currentContent);
            // We want to view how it differs from the current content perspective
            DiffViewer.renderDiff(diffContainer, currentContent, historicalContent);

            const isChanged = currentContent !== historicalContent;
            const title = isChanged ? 'Restore this version' : 'Current version';
            const desc = isChanged ? 'Replace current file contents with this historical revision. A safety backup will be taken.' : 'This is the current version of the file.';
            const statusBar = new Setting(contentEl)
                .setName(title)
                .setDesc(desc)
            if (isChanged) {
                statusBar.addButton(btn =>
                    btn
                        .setButtonText('Restore to Note')
                        .setCta()
                        .onClick(async () => {
                            btn.setDisabled(true);
                            btn.setButtonText('Restoring...');
                            try {
                                // Pass the already reconstructed and displayed version for verified fast-path restoration
                                const res = await this.context.operationsManager.restoreVersion(
                                    this.context.getVaultId(),
                                    this.fileRecord.path,
                                    this.fileRecord.hash,
                                    {
                                        knownContent: historicalContent,
                                        notify: (msg) => new Notice(msg),
                                    }
                                );
                                if (res.status === 'unchanged') {
                                    new Notice(`No changes were made to ${this.fileRecord.path}`);
                                } else if (res.status === 'modified') {
                                    new Notice(`Successfully restored ${this.fileRecord.path}`);
                                } else if (res.status === 'created') {
                                    new Notice(`Successfully created ${this.fileRecord.path}`);
                                }
                                this.close();
                            } catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                new Notice(`Failed to restore note: ${msg}`);
                                btn.setDisabled(false);
                                btn.setButtonText('Restore to Note');
                            }
                        })
                );
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            loadingEl.setText(`Error reconstructing version: ${msg}`);
            loadingEl.addClass('obpb_error');
        }
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}
