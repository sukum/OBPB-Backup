import { Notice } from 'obsidian';
import moment from 'moment';
import { FailedTaskRecord } from '../../types/state';
import { FailedTaskDetailsModal } from './failed-task-details-modal';
import { formatBytes } from '../../utils/format';
import { FailedTasksTabContext } from './types';
import { createButton } from './button';
import { POCKETBASE_OBJECT_DATA_MAX_CHARACTERS } from '../../remote/pocketbase-schema';

/**
 * FailedTasksTab lists failed task log entries
 */
export class FailedTasksTab {
    private failedFilterText: string = '';
    private failedStatsBadgeEl: HTMLElement | null = null;
    private failedTableBodyEl: HTMLElement | null = null;

    constructor(private context: FailedTasksTabContext) {}

    public render(container: HTMLElement): void {
        const toolbar = container.createDiv({ cls: 'obpb_toolbar' });
        const leftGroup = toolbar.createDiv({ cls: 'obpb_toolbar_group' });
        leftGroup.createEl('h3', { text: 'Failed & Abandoned Tasks' });
        this.failedStatsBadgeEl = leftGroup.createSpan({ cls: 'obpb_stats_badge' });

        const rightGroup = toolbar.createDiv({ cls: 'obpb_toolbar_group' });

        // Filter Input
        const filterInput = rightGroup.createEl('input', {
            type: 'text',
            placeholder: 'Filter path...',
            cls: 'obpb_filter_input',
        });
        filterInput.value = this.failedFilterText;
        filterInput.addEventListener('input', () => {
            this.failedFilterText = filterInput.value.trim().toLowerCase();
            this.renderTableBody();
        });

        // Purge All Button
        createButton({
            parent: rightGroup,
            text: 'Purge All Errors',
            icon: 'trash-2',
            onClick: async () => {
                if (!this.context.failedTasksManager || this.context.failedTasksManager.getCount() === 0) {
                    new Notice('No failed tasks to purge.');
                    return;
                }
                await this.context.failedTasksManager.clearAll();
                new Notice('Purged all failed tasks from error log.');
                this.renderTableBody();
                this.context.onTasksUpdated?.();
            },
        });

        // Table
        const tableWrapper = container.createDiv({ cls: 'obpb_table_wrapper' });
        const table = tableWrapper.createEl('table', { cls: 'obpb_table' });
        const thead = table.createEl('thead');
        const headerRow = thead.createEl('tr');
        headerRow.createEl('th', { text: 'Path' });
        headerRow.createEl('th', { text: 'Operation' });
        headerRow.createEl('th', { text: 'Note Size' });
        headerRow.createEl('th', { text: 'Attempts' });
        headerRow.createEl('th', { text: 'Error' });
        headerRow.createEl('th', { text: 'Failed At' });
        headerRow.createEl('th', { text: 'Actions' });

        this.failedTableBodyEl = table.createEl('tbody');
        this.renderTableBody();
    }

    public renderTableBody(): void {
        if (!this.failedTableBodyEl) return;
        this.failedTableBodyEl.empty();

        const allTasks = this.context.failedTasksManager?.getFailedTasks() || [];

        if (this.failedStatsBadgeEl) {
            this.failedStatsBadgeEl.setText(`${allTasks.length} failed`);
        }

        let filtered = allTasks;
        if (this.failedFilterText) {
            filtered = filtered.filter(t => t.intent.path.toLowerCase().includes(this.failedFilterText));
        }

        if (filtered.length === 0) {
            const emptyRow = this.failedTableBodyEl.createEl('tr');
            const emptyCell = emptyRow.createEl('td', {
                text: this.failedFilterText ? 'No failed tasks match filter.' : 'No failed tasks recorded. All systems operating normally.',
                cls: 'obpb_empty_cell',
            });
            emptyCell.colSpan = 7;
            return;
        }

        for (const record of filtered) {
            const row = this.failedTableBodyEl.createEl('tr', {
                cls: 'obpb_row obpb_row_failed',
            });

            // 1. Path Column
            const recordPath = record.intent.path;
            const pathCell = row.createEl('td', { cls: 'obpb_cell_path' });
            const pathLink = pathCell.createEl('a', {
                cls: 'internal-link obpb_path_link',
                text: recordPath,
            });
            pathLink.addEventListener('click', (e) => {
                e.preventDefault();
                void this.context.app.workspace.openLinkText(recordPath, '', false);
            });

            // 2. Operation Column
            const opCell = row.createEl('td', { cls: 'obpb_cell_event' });
            const opName = record.intent.operation;
            const opType = opName;
            opCell.createSpan({
                cls: `obpb_badge obpb_badge_${opName}`,
                text: opType.toUpperCase(),
            });

            // 3. Note Size Column
            const sizeCell = row.createEl('td', { cls: 'obpb_cell_size' });
            const formattedSize = formatBytes(record.noteSizeBytes ?? 0);
            const isLarge = record.likelyReason === 'size_limit';
            
            const sizeSpan = sizeCell.createSpan({ text: formattedSize });
            if (isLarge) {
                sizeSpan.addClass('obpb_size_warning');
                const warnBadge = sizeCell.createSpan({
                    cls: 'obpb_warning_badge',
                    text: ' ⚠️ Limit',
                });
                warnBadge.setAttribute('title', `Exceeds PocketBase ${POCKETBASE_OBJECT_DATA_MAX_CHARACTERS.toLocaleString()} character text limit`);
            }

            // 4. Attempts Column
            const attemptsCell = row.createEl('td', { cls: 'obpb_cell_attempts' });
            attemptsCell.setText(`${record.attempts} tries`);

            // 5. Error Column
            const errorCell = row.createEl('td', { cls: 'obpb_cell_error' });
            const shortError = record.error.length > 50 ? `${record.error.slice(0, 50)}...` : record.error;
            const errorSpan = errorCell.createSpan({ text: shortError, cls: 'obpb_error_text' });
            errorSpan.setAttribute('title', record.error);

            // 6. Failed At Column
            const dateCell = row.createEl('td', { cls: 'obpb_cell_date', attr: { title: new Date(record.timestamp).toLocaleTimeString() } });
            dateCell.setText(moment(record.timestamp).fromNow());

            // 7. Actions Column
            const actionsCell = row.createEl('td', { cls: 'obpb_cell_actions' });
            const actionGroup = actionsCell.createDiv({ cls: 'obpb_actions_group' });

            // Details Button
            createButton({
                parent: actionGroup,
                cls: 'obpb_btn_sm',
                text: 'Details',
                icon: 'info',
                onClick: () => {
                    const modal = new FailedTaskDetailsModal(
                        this.context.app,
                        record,
                        // async (r) => this.handleRetryTask(r),
                        async (r) => this.handleRemoveTask(r)
                    );
                    modal.open();
                },
            });

            // Retry Button
            createButton({
                parent: actionGroup,
                cls: 'obpb_btn_sm mod-warning',
                text: 'Retry',
                ariaLabel: 'Retry upload',
                icon: 'refresh-cw',
                onClick: async () => {
                    await this.handleRetryTask(record);
                },
            });

            // Remove Button
            createButton({
                parent: actionGroup,
                cls: 'clickable-icon',
                ariaLabel: 'Remove task from log',
                icon: 'trash-2',
                onClick: async () => {
                    await this.handleRemoveTask(record);
                },
            });
        }

    }

    public async handleRetryTask(record: FailedTaskRecord): Promise<void> {
        if (!this.context.operationsManager) return;
        try {
            await this.context.operationsManager.retryFailedTask(record);
            const targetPath = record.intent.path;
            new Notice(`[OBPB Backup] Successfully retried ${targetPath}`);
            this.renderTableBody();
            this.context.onTasksUpdated?.();
        } catch (err) {
            new Notice(`[OBPB Backup] Retry failed: ${err instanceof Error ? err.message : String(err)}`);
            this.renderTableBody();
            this.context.onTasksUpdated?.();
        }
    }

    public async handleRemoveTask(record: FailedTaskRecord): Promise<void> {
        await this.context.failedTasksManager?.removeFailedTask(record.id);
        const targetPath = record.intent.path;
        new Notice(`[OBPB Backup] Removed failed task for ${targetPath}`);
        this.renderTableBody();
        this.context.onTasksUpdated?.();
    }
}
