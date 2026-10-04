import { App, Modal, setIcon } from 'obsidian';
import { FailedTaskRecord } from '../../types/state';
import { formatBytes } from '../../utils/format';
import { createButton } from './button';
import { POCKETBASE_OBJECT_DATA_MAX_CHARACTERS } from '../../remote/pocketbase-schema';
import { FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS, truncatePayloadPreview } from '../../utils/failed-task-payload-preview';

/**
 * Abandoned failed task info
 */
export class FailedTaskDetailsModal extends Modal {
    constructor(
        app: App,
        private record: FailedTaskRecord,
        // private onRetry: (record: FailedTaskRecord) => Promise<void>,
        private onRemove: (record: FailedTaskRecord) => Promise<void>
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('u-select-text');
        contentEl.empty();
        contentEl.addClass('obpb_failed_task_modal');

        const path = this.record.intent.path;
        const fileName = path.split('/').pop() || path;
        contentEl.createEl('h2', { text: `Failed task: ${fileName}` });

        const formattedSize = formatBytes(this.record.noteSizeBytes ?? 0);
        const isLarge = this.record.likelyReason === 'size_limit';

        // Warning banner for oversized notes
        if (isLarge) {
            const warningBox = contentEl.createDiv({ cls: 'obpb_warning_callout' });
            const warningHeader = warningBox.createDiv({ cls: 'obpb_warning_header' });
            setIcon(warningHeader, 'alert-triangle');
            warningHeader.createSpan({ text: ' Likely failure reason: Note size exceeds database limit' });
            
            const warningText = warningBox.createEl('p', { cls: 'obpb_warning_text' });
            warningText.innerHTML = `Note content is <strong>${formattedSize}</strong> (${(this.record.noteSizeBytes ?? 0).toLocaleString()} bytes). Its payload exceeds the database text field limit of <strong>${POCKETBASE_OBJECT_DATA_MAX_CHARACTERS.toLocaleString()} characters</strong>. PocketBase rejects text entries exceeding this limit with HTTP 400 validation error.`;
        }

        // Details grid / list
        const op = this.record.intent.operation;
        const event = this.record.intent.event;
        const grid = contentEl.createDiv({ cls: 'obpb_meta_grid' });
        this.createMetaRow(grid, 'Path', path);
        this.createMetaRow(grid, 'Operation', `${op.toUpperCase()} (${event})`);
        this.createMetaRow(grid, 'Note size', `${formattedSize} (${(this.record.noteSizeBytes ?? 0).toLocaleString()} bytes)`);
        this.createMetaRow(grid, 'Attempts', `${this.record.attempts} tries`);
        this.createMetaRow(grid, 'Abandoned at', new Date(this.record.timestamp).toLocaleString());
        this.createMetaRow(grid, 'Target hash', this.record.targetHash || 'Pending preparation');

        // Server Error details
        contentEl.createEl('h4', { text: 'Server error message', cls: 'obpb_section_title' });
        const errorPre = contentEl.createEl('pre', { cls: 'obpb_error_block' });
        errorPre.createEl('code', { text: this.record.error });

        // Note content / diff payload preview (trimmed)
        const payloadData = this.record.payloadPreview;
        if (payloadData) {
            contentEl.createEl('h4', { text: 'Task payload preview (trimmed)', cls: 'obpb_section_title' });
            const previewContainer = contentEl.createDiv({ cls: 'obpb_payload_container' });
            
            const maxChars = FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS;
            const isTrimmed = payloadData.length > maxChars;
            const previewText = truncatePayloadPreview(payloadData) ?? payloadData;

            const codePre = previewContainer.createEl('pre', { cls: 'obpb_payload_block' });
            codePre.createEl('code', { text: previewText });

            if (isTrimmed) {
                previewContainer.createEl('div', {
                    cls: 'obpb_trimmed_badge',
                    text: `... [Trimmed: showing ${FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS.toLocaleString()} of ${payloadData.length.toLocaleString()} characters]`
                });
            }
        }

        // Action Buttons
        const buttonRow = contentEl.createDiv({ cls: 'obpb_modal_actions' });

        // Now that we are not saving note contents in queue, no point in retrying
        // createButton({
        //     parent: buttonRow,
        //     cls: 'mod-cta',
        //     text: 'Retry Task',
        //     icon: 'refresh-cw',
        //     onClick: async () => {
        //         this.close();
        //         await this.onRetry(this.record);
        //     },
        // });

        createButton({
            parent: buttonRow,
            cls: 'mod-warning',
            text: 'Remove from log',
            icon: 'trash-2',
            onClick: async () => {
                this.close();
                await this.onRemove(this.record);
            },
        });

        createButton({
            parent: buttonRow,
            text: 'Close',
            onClick: () => {
                this.close();
            },
        });
    }

    private createMetaRow(container: HTMLElement, label: string, value: string): void {
        const row = container.createDiv({ cls: 'obpb_meta_row' });
        row.createSpan({ cls: 'obpb_meta_label', text: `${label}: ` });
        row.createSpan({ cls: 'obpb_meta_value', text: value });
    }
}
