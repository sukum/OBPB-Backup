import { App, Component, MarkdownRenderer, Modal } from 'obsidian';
import type { TrashModalOperations } from './types';

export class TrashNotePreviewModal extends Modal {
    private renderComponent: Component | null = null;

    constructor(
        app: App,
        private vaultId: string,
        private path: string,
        private hash: string,
        private operationsManager: Pick<TrashModalOperations, 'reconstructVersion'>
    ) {
        super(app);
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('pb_trash_preview_modal');
        contentEl.addClass('u-select-text');
        contentEl.createEl('h2', { text: `Last version: ${this.path}` });

        const loadingEl = contentEl.createEl('p', { text: 'Loading note version...' });
        const previewEl = contentEl.createDiv({ cls: 'pb_trash_preview_content' });

        try {
            const markdown = await this.operationsManager.reconstructVersion(
                this.vaultId,
                this.path,
                this.hash
            );

            loadingEl.remove();
            this.renderComponent = new Component();
            this.renderComponent.load();
            await MarkdownRenderer.render(
                this.app,
                markdown,
                previewEl,
                this.path,
                this.renderComponent
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            loadingEl.setText(`Failed to load note version: ${msg}`);
            loadingEl.addClass('pb_error');
        }
    }

    onClose(): void {
        this.renderComponent?.unload();
        this.renderComponent = null;
        this.contentEl.empty();
    }
}
