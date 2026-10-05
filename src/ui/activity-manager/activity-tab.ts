import { setIcon, Notice, moment as _moment } from 'obsidian';
import { ActivityRecord, ActivityStageInfo } from '../../types/state';
import { ActivityTabContext } from './types';
import { createButton } from './button';
import { PopupModal } from '../popup';

const moment = _moment as unknown as typeof import('moment');

/**
 * ActivityTab renders the Activity manager showing real-time event logs and old ones.
 */
export class ActivityTab {
    private refreshSec: number = 2;
    private filterText: string = '';
    private activeOnly: boolean = false;
    private reRenderCount: number = 0;

    private statsSummaryEl: HTMLElement | null = null;
    private pauseQueueBtn: HTMLButtonElement | null = null;
    private tableBodyEl: HTMLElement | null = null;

    constructor(private context: ActivityTabContext) {
        const settings = this.context.getSettings();
        this.refreshSec = settings.activityManagerRefreshSec || 2;
    }

    public getRefreshSec(): number {
        return this.refreshSec;
    }

    public render(container: HTMLElement): void {
        // Toolbar
        const toolbar = container.createDiv({ cls: 'pb_toolbar' });
        const leftGroup = toolbar.createDiv({ cls: 'pb_toolbar_group' });
        leftGroup.createEl('h3', { text: 'Activity log' });
        this.statsSummaryEl = leftGroup.createSpan({ cls: 'pb_stats_badge' });

        const rightGroup = toolbar.createDiv({ cls: 'pb_toolbar_group' });

        // Refresh Dropdown (1s - 5s)
        const refreshLabel = rightGroup.createEl('label', { cls: 'pb_toolbar_label', text: 'Refresh: ' });
        const refreshSelect = refreshLabel.createEl('select', { cls: 'dropdown' });
        // This seems to be resource intensive on the CPU. Yet keeping it too high wouldn't make sense
        // as users will be here for checking the log (non-stale)
        // Increased the min to 3, though the settings min might have to be changedas well
        for (let i = 3; i <= 5; i++) {
            const opt = refreshSelect.createEl('option', { value: String(i), text: `${i}s` });
            if (i === this.refreshSec) opt.selected = true;
        }
        refreshSelect.addEventListener('change', () => {
            (async () => {
                this.refreshSec = parseInt(refreshSelect.value, 10);
                const settings = this.context.getSettings();
                settings.activityManagerRefreshSec = this.refreshSec;
                await this.context.onSettingsChange(settings);
                // calls ActivityManagerView.startTimer()
                this.context.onRefreshIntervalChange(this.refreshSec);
            })().catch((err) => {
                console.error('Failed to handle refresh secs change:', err);
            });
        });

        // Pause / Resume Upload Queue Button
        // This only apuses at the queueing up. Maybe should be made to start at the trigger level.
        // Kind of a global plugin all backup actions disabled
        this.pauseQueueBtn = createButton({
            parent: rightGroup,
            cls: 'clickable-icon',
            onClick: () => {
                if (this.context.operationsManager.isQueuePaused()) {
                    this.context.operationsManager.resumeQueue();
                    new Notice('Resumed upload queue.');
                } else {
                    this.context.operationsManager.pauseQueue();
                    new Notice('Paused upload queue.');
                }
                this.updatePauseButton();
                this.renderTableBody();
            },
        });
        this.updatePauseButton();

        // Active only Checkbox - filters to show only ongoing backups
        const activeOnlyLabel = rightGroup.createEl('label', { cls: 'pb_toolbar_label' });
        const activeOnlyCheckbox = activeOnlyLabel.createEl('input', { type: 'checkbox' });
        activeOnlyCheckbox.checked = this.activeOnly;
        activeOnlyLabel.createSpan({ text: ' Active only' });
        activeOnlyCheckbox.addEventListener('change', () => {
            this.activeOnly = activeOnlyCheckbox.checked;
            this.renderTableBody();
        });

        // Filter Input - filter by path
        const filterInput = rightGroup.createEl('input', {
            type: 'text',
            placeholder: 'Filter path...',
            cls: 'pb_filter_input',
        });
        filterInput.value = this.filterText;
        filterInput.addEventListener('input', () => {
            this.filterText = filterInput.value.trim().toLowerCase();
            this.renderTableBody();
        });

        // Flush All Button
        // Seems usless as we now flush debounced file when the note view is changed to this view
        // I should remove this later.
        // createButton({
        //     parent: rightGroup,
        //     text: 'Flush all active',
        //     icon: 'zap',
        //     onClick: async () => {
        //         await this.context.operationsManager.flushDebouncedFiles();
        //         new Notice('Flushed all active debounce timers.');
        //         this.renderTableBody();
        //     },
        // });

        // Clear Completed Button
        // clear activity log
        createButton({
            parent: rightGroup,
            text: 'Clear completed',
            icon: 'trash-2',
            onClick: () => {
                this.context.tracker.clearCompleted();
                new Notice('Cleared completed activity records.');
            },
        });

        // Table
        const tableWrapper = container.createDiv({ cls: 'pb_table_wrapper' });
        const table = tableWrapper.createEl('table', { cls: 'pb_table' });
        const thead = table.createEl('thead');
        const headerRow = thead.createEl('tr');
        headerRow.createEl('th', { text: 'Path' });
        headerRow.createEl('th', { text: 'Time' });
        headerRow.createEl('th', { text: 'Event' });
        headerRow.createEl('th', { text: 'Debounce status' });
        headerRow.createEl('th', { text: 'Queue status' });
        headerRow.createEl('th', { text: 'Upload status' });
        headerRow.createEl('th', { text: 'Actions' });

        this.tableBodyEl = table.createEl('tbody');
        this.renderTableBody();
    }

    public updatePauseButton(): void {
        if (!this.pauseQueueBtn) return;
        const paused = this.context.operationsManager.isQueuePaused();
        if (paused) {
            this.pauseQueueBtn.setText('Resume uploads');
            this.pauseQueueBtn.setAttribute('aria-label', 'Resume uploads');
            this.pauseQueueBtn.addClass('mod-cta');
            setIcon(this.pauseQueueBtn, 'play');
        } else {
            this.pauseQueueBtn.setText('Pause uploads');
            this.pauseQueueBtn.setAttribute('aria-label', 'Pause uploads');
            this.pauseQueueBtn.removeClass('mod-cta');
            setIcon(this.pauseQueueBtn, 'pause');
        }
    }

    public renderTableBody(allRecords?: ActivityRecord[]): void {
        this.reRenderCount++;
        if (!this.tableBodyEl) return;
        // Since we are now only updating rows with dirty status, not emptying whole table
        // this.tableBodyEl.empty();
        this.tableBodyEl.dataset.reRenderCount = String(this.reRenderCount);

        allRecords ??= this.context.tracker.getRecords();

        // Update stats badge
        const activeCount = allRecords.filter(r => r.status === 'ongoing').length;
        const completedCount = allRecords.filter(r => r.status === 'completed').length;
        const failedCount = allRecords.filter(r => r.status === 'failed').length;
        if (this.statsSummaryEl) {
            this.statsSummaryEl.setText(
                `${activeCount} active | ${completedCount} completed${failedCount > 0 ? ` | ${failedCount} failed` : ''}`
            );
        }

        // Active
        if (this.activeOnly) {
            allRecords = allRecords.filter(r => r.status === 'ongoing');
        }

        // path filter
        if (this.filterText) {
            allRecords = allRecords.filter(r => r.path.toLowerCase().includes(this.filterText));
        }

        // empty case
        if (allRecords.length === 0) { // Add empty row label
            this.tableBodyEl.empty();
            const emptyRow = this.tableBodyEl.createEl('tr', { 'attr': { 'id': 'activity_records_empty_row' } });
            const emptyCell = emptyRow.createEl('td', {
                text: this.filterText || this.activeOnly ? 'No activity matches filter.' : 'No activity history recorded yet.',
                cls: 'pb_empty_cell',
            });
            emptyCell.colSpan = 6;
            return;
        } else { // Remove empty row if it exists
            this.tableBodyEl.querySelector('#activity_records_empty_row')?.remove();
        }

        // get all record hashes for identifying dirty rows
        const recordHashes = this.context.tracker.getRecordHashes();
        for (const record of allRecords) {
            // I wonder if this setTimeout is ncesssary.
            // The idea was to pace out the UI updates to stop obsidian from freezing
            window.setTimeout(() => {
                this.renderRow(record, recordHashes.get(record.id), this.tableBodyEl);
            });
        }
    }

    private renderRow(record: ActivityRecord, recordHash: string | undefined, tableBodyEl?: HTMLElement | null): void {
        tableBodyEl ??= this.tableBodyEl;
        if (!tableBodyEl) return;
        if (recordHash === undefined) {
            recordHash = '';
        }

        let row: HTMLElement | null;
        row = tableBodyEl.querySelector(`#tr${record.id.replaceAll("-", "")}`);
        const row_status_class = `pb_row_${record.status}`;
        if (row) { // Existing task
            // Get row record hash
            const existingRecordHash = row.dataset.recordHash;
            if (existingRecordHash === recordHash) {
                return; // No changes, skip re-rendering
            } else {
                row.dataset.recordHash = recordHash;
            }

            row.dataset.reRenderCount = String(this.reRenderCount);

            const toRemove = [...row.classList].filter(cls => cls.startsWith('pb_row_'));
            if (toRemove.length) {
                row.classList.remove(...toRemove);
            }
            row.classList.add(row_status_class);
        }

        const frag = createFragment((frag) => {
            // 1. Path Column
            const pathCell = frag.createEl('td', { cls: 'pb_cell_path' });
            const pathLink = pathCell.createEl('a', {
                cls: 'internal-link pb_path_link',
                text: record.path,
            });
            pathLink.addEventListener('click', (e) => {
                e.preventDefault();
                void this.context.app.workspace.openLinkText(record.path, '', false);
            });

            // 2. Event Column
            const eventCell = frag.createEl('td', { cls: 'pb_cell_event' });
            const eventBadge = eventCell.createSpan({
                cls: `pb_badge pb_badge_${record.event}`,
                text: record.event.toUpperCase(),
            });
            if (record.oldPath) {
                eventBadge.setAttribute('title', `Renamed from: ${record.oldPath}`);
            }

            // 3. Debounce Status Column
            const debounceCell = frag.createEl('td', { cls: 'pb_cell_debounce' });
            this.renderStageCell(debounceCell, record.debounce, 'debounce');

            // 4. Queue Status Column
            const queueCell = frag.createEl('td', { cls: 'pb_cell_queue' });
            this.renderStageCell(queueCell, record.queue, 'queue');

            // 5. Upload Status Column
            const uploadCell = frag.createEl('td', { cls: 'pb_cell_upload' });
            this.renderStageCell(uploadCell, record.upload, 'upload');

            // 6. Timestamp Column
            const tzCell = frag.createEl('td', { cls: 'pb_cell_path' });
            tzCell.createSpan({
                text: moment(record.timestamp).fromNow(),
                attr: {
                    title: new Date(record.timestamp).toLocaleTimeString()
                }
            });

            // 7. Actions Column
            const actionsCell = frag.createEl('td', { cls: 'pb_cell_actions' });
            this.renderActionsCell(actionsCell, record);        
        });

        if (!row) { // new task, so create new row
            row = tableBodyEl.createEl('tr', {
                cls: `pb_row ${row_status_class}`,
                attr: {
                    'id': `tr${record.id.replaceAll("-", "")}`,
                    // Set record hash as a data attribute for dirty checking
                    "data-record-hash": recordHash,
                }
            });
        }
        // Set row contents to the newly created fragment
        row.replaceChildren(frag);
    }

    private renderStageCell(cell: HTMLElement, stage?: ActivityStageInfo, stageType?: 'debounce' | 'queue' | 'upload'): void {
        if (!stage) {
            return;
        }

        if (stage.status === 'active') {
            const badge = cell.createSpan({ cls: stageType === 'upload' ? 'pb_status_uploading' : 'pb_status_active' });
            setIcon(badge, stageType === 'debounce' ? 'clock' : 'refresh-cw');
            if (stageType === 'upload') badge.addClass('pb_spin');
            badge.createSpan({ text: stage.note ? ` ${stage.note}` : ' Active' });
        } else if (stage.status === 'waiting') {
            const isPaused = this.context.operationsManager.isQueuePaused();
            const badge = cell.createSpan({ cls: isPaused ? 'pb_status_paused' : 'pb_status_waiting' });
            setIcon(badge, isPaused ? 'pause-circle' : 'hourglass');
            const label = isPaused ? (stage.note ? ` Queued (${stage.note})` : ' Queued (Paused)') : (stage.note ? ` Queued (${stage.note})` : ' Queued');
            badge.createSpan({ text: ` ${label}` });
        } else if (stage.status === 'completed') {
            const badge = cell.createSpan({ cls: 'pb_status_completed' });
            setIcon(badge, 'check-circle');
            const noteStr = stage.note ? ` (${stage.note})` : '';
            badge.createSpan({ text: ` Done${noteStr}` });
        } else if (stage.status === 'failed') {
            const fullNote = stage.note ? stage.note : 'Failed';
            const badge = cell.createSpan({ cls: fullNote.length > 20 ? 'pb_status_failed_clickable' : 'pb_status_failed' });
            setIcon(badge, 'alert-triangle');
            const note = fullNote.length > 20 ? ` ${fullNote.substring(0, 20)}...` : ` ${fullNote}`;
            badge.createSpan({ text: note, title: fullNote });
            if (fullNote.length > 20) {
                badge.onClickEvent(() => {
                    new PopupModal(this.context.app, fullNote).open();
                });
            }
        } else if (stage.status === 'cancelled') {
            cell.createSpan({ cls: 'pb_status_muted', text: stage.note || 'Cancelled' });
        } else if (stage.status === 'bypassed') {
            cell.createSpan({ cls: 'pb_status_muted', text: stage.note || 'Bypassed' });
        }
    }

    private renderActionsCell(cell: HTMLElement, record: ActivityRecord): void {
        const actionGroup = cell.createDiv({ cls: 'pb_actions_group' });

        /*
        // Since the debounce is automatically flushed on note window losing focus
        // this is unnecessary
        if (record.debounce?.status === 'active') {
            createButton({
                parent: actionGroup,
                cls: 'pb_btn_sm mod-cta',
                text: 'Flush Now',
                ariaLabel: 'Flush now',
                icon: 'zap',
                onClick: async () => {
                    await this.context.operationsManager.flushDebouncedFiles(record.path);
                    new Notice(`Flushed debounce for ${record.path}`);
                    this.renderTableBody();
                },
            });
        }
        // Calling this.context.operationsManager.retryUploadQueue() without path doesn't work as expected
        // It calls quemenager retryNow which processes the first task
        // Leftover from when failed tasks remained in activity
        if (record.upload?.status === 'failed') {
            createButton({
                parent: actionGroup,
                cls: 'pb_btn_sm mod-warning',
                text: 'Retry Now',
                icon: 'refresh-cw',
                onClick: async () => {
                    await this.context.operationsManager.retryUploadQueue();
                    new Notice(`Retrying upload for ${record.path}`);
                    this.renderTableBody();
                },
            });
        }
        */

        // Removing the status check to account for the edge case where the app got close while the task was in queue
        // Since the record action is stateless, it should insert or update record regardlessly
        // if (record.status !== 'ongoing') {
        createButton({
            parent: actionGroup,
            cls: 'clickable-icon',
            ariaLabel: 'Dismiss record',
            icon: 'x',
            onClick: () => {
                this.context.tracker.dismissRecord(record.id);
            },
        });
        // }
    }
}
