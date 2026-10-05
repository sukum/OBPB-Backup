import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './setup-dom';
import { ActivityManagerView } from '../../src/ui/activity-manager/activity-manager-view';
import { ActivityTab } from '../../src/ui/activity-manager/activity-tab';
import { FailedTasksTab } from '../../src/ui/activity-manager/failed-tasks-tab';
import { FailedTaskDetailsModal } from '../../src/ui/activity-manager/failed-task-details-modal';
// import { DashboardTab } from '../../src/ui/activity-manager/dashboard-tab';
import { PopupModal } from '../../src/ui/popup';
import { createTestContext } from './mocks/test-context';
import { WorkspaceLeaf } from 'obsidian';
import { ActivityRecord, FailedTaskRecord } from '../../src/types/state';
import { SAVE_EXECUTION_POLICIES } from '../../src/operations/types';
import { FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS } from '../../src/utils/failed-task-payload-preview';
import moment from 'moment';

    // Runs before EACH test in this describe block
    beforeEach(async () => {
        mock.fn(moment, (d: number) => ({ fromNow: () => `${d} ago` }));
    });

    // Runs after EACH test in this describe block
    afterEach(async () => {
        mock.reset();
    });

describe('ActivityManagerView', () => {
test('ActivityManagerView lifecycle, subscriptions, and sub-tab switching', async () => {
    const { plugin, mocks } = createTestContext();
    const leaf = new (WorkspaceLeaf as any)(plugin.app);

    const view = new ActivityManagerView(
        leaf,
        mocks.activityTracker,
        mocks.queueManager,
        () => plugin.settings,
        async (updated) => { plugin.settings = updated; },
        mocks.failedTasksManager,
        mocks.operationsManager
    );

    assert.equal(view.getViewType(), 'historical-backup-activity-manager');
    assert.equal(view.getDisplayText(), 'Activity Manager');
    assert.equal(view.getIcon(), 'activity');

    try {
        await view.onOpen();

        // Verify initial layout
        assert.ok(view.containerEl.classList.contains('pb_activity_manager_view'));
        const tabNav = view.containerEl.querySelector('.pb_tab_nav');
        assert.ok(tabNav);

        const liveTabBtn = view.containerEl.querySelector('.pb_tab_btn:nth-child(1)') as HTMLButtonElement;
        const failedTabBtn = view.containerEl.querySelector('.pb_tab_btn:nth-child(2)') as HTMLButtonElement;
        assert.ok(liveTabBtn);
        assert.ok(failedTabBtn);
        assert.ok(liveTabBtn.classList.contains('is-active'));
        assert.equal(failedTabBtn.classList.contains('is-active'), false);

        // Dynamic badge update when failed tasks manager notifies
        mocks.failedTasksManager.tasks = [
            {
                id: 'failed-1',
                intent: { id: 't1', path: 'bad.md', operation: 'save', trigger: 'auto', event: 'modify', policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY },
                stage: 'upload',
                cause: { name: 'Error', message: 'Database error' },
                error: 'Database error',
                noteSizeBytes: 500,
                attempts: 3,
                timestamp: Date.now(),
            },
        ];
        mocks.failedTasksManager.notify();
        assert.ok(failedTabBtn.textContent?.includes('Failed Tasks (1)'));

        // Switch to Failed Tasks tab
        failedTabBtn.click();
        assert.ok(failedTabBtn.classList.contains('is-active'));
        assert.equal(liveTabBtn.classList.contains('is-active'), false);
        const failedTable = view.containerEl.querySelector('.pb_table');
        assert.ok(failedTable);

        // Switch back to Live Activity tab
        liveTabBtn.click();
        assert.ok(liveTabBtn.classList.contains('is-active'));
    } finally {
        // Close view and verify cleanup
        await view.onClose();
    }
    assert.ok(true, 'onClose executes without errors');
});

test('ActivityTab toolbar controls, table rendering, row caching, and actions', async () => {
    const { plugin, mocks } = createTestContext();
    const container = document.createElement('div');

    let refreshIntervalChangedTo = 0;
    const activityTab = new ActivityTab({
        app: plugin.app,
        tracker: mocks.activityTracker,
        operationsManager: mocks.operationsManager,
        getSettings: () => plugin.settings,
        onSettingsChange: async (s) => { plugin.settings = s; },
        onRefreshIntervalChange: (sec) => { refreshIntervalChangedTo = sec; },
    });

    assert.equal(activityTab.getRefreshSec(), 2);
    activityTab.render(container);

    // 1. Toolbar: Refresh dropdown change
    const refreshSelect = container.querySelector('select.dropdown') as HTMLSelectElement;
    assert.ok(refreshSelect);
    refreshSelect.value = '4';
    refreshSelect.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(activityTab.getRefreshSec(), 4);
    assert.equal(refreshIntervalChangedTo, 4);
    assert.equal(plugin.settings.activityManagerRefreshSec, 4);

    // 2. Toolbar: Pause / Resume queue toggle
    const pauseBtn = container.querySelector('.clickable-icon') as HTMLButtonElement;
    assert.ok(pauseBtn);
    assert.ok(pauseBtn.textContent?.includes('Pause Uploads'));
    pauseBtn.click();
    assert.equal(mocks.operationsManager.isQueuePaused(), true);
    assert.ok(pauseBtn.textContent?.includes('Resume Uploads'));

    // 3. Toolbar: Flush All Active & Clear Completed
    let flushed = false;
    mocks.operationsManager.flushDebouncedFiles = async () => { flushed = true; };
    const flushBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Flush All Active'));
    assert.ok(flushBtn);
    flushBtn.click();
    assert.equal(flushed, true);

    let clearedCompleted = false;
    mocks.activityTracker.clearCompleted = () => { clearedCompleted = true; };
    const clearBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Clear Completed'));
    assert.ok(clearBtn);
    clearBtn.click();
    assert.equal(clearedCompleted, true);

    // 4. Table: Empty state
    const emptyCell = container.querySelector('.pb_empty_cell');
    assert.ok(emptyCell);
    assert.ok(emptyCell.textContent?.includes('No activity history recorded yet.'));

    // 5. Table: Populate records
    const record1: ActivityRecord = {
        id: 'rec-1',
        path: 'Daily/2026-09-19.md',
        event: 'modify',
        status: 'ongoing',
        timestamp: Date.now(),
        debounce: { status: 'active', note: '15s', timestamp: Date.now() },
        queue: { status: 'waiting', timestamp: Date.now() },
        upload: { status: 'active', timestamp: Date.now() },
    };

    mocks.activityTracker.records = [record1];
    mocks.activityTracker.getRecordHashes = () => new Map([['rec-1', 'hash-v1']]);

    activityTab.renderTableBody();
    // Flush setTimeout row rendering
    await new Promise(r => setTimeout(r, 10));

    const row = container.querySelector('#trrec1') as HTMLElement;
    assert.ok(row, 'Row for rec-1 should exist');
    assert.equal(row.dataset.recordHash, 'hash-v1');
    assert.ok(row.querySelector('.pb_badge_modify'));
    assert.ok(row.querySelector('.pb_status_active'));

    // Test row caching: same hash skips recreate
    activityTab.renderTableBody();
    await new Promise(r => setTimeout(r, 10));
    const cachedRow = container.querySelector('#trrec1') as HTMLElement;
    assert.strictEqual(cachedRow, row);

    // 6. Action: Dismiss record
    let dismissedId = '';
    mocks.activityTracker.dismissRecord = (id: string) => { dismissedId = id; };
    const dismissBtn = row.querySelector('.pb_cell_actions button') as HTMLButtonElement;
    assert.ok(dismissBtn);
    dismissBtn.click();
    assert.equal(dismissedId, 'rec-1');

    // 7. Active only checkbox filter
    const activeCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    assert.ok(activeCheckbox);
    activeCheckbox.checked = true;
    activeCheckbox.dispatchEvent(new Event('change'));

    // 8. Filter input
    const filterInput = container.querySelector('.pb_filter_input') as HTMLInputElement;
    assert.ok(filterInput);
    filterInput.value = 'Nonexistent';
    filterInput.dispatchEvent(new Event('input'));
    assert.ok(container.querySelector('.pb_empty_cell'));
});

test('ActivityTab opens the full failed-stage note in a popup modal', async () => {
    const { plugin, mocks } = createTestContext();
    const container = document.createElement('div');
    const activityTab = new ActivityTab({
        app: plugin.app,
        tracker: mocks.activityTracker,
        operationsManager: mocks.operationsManager,
        getSettings: () => plugin.settings,
        onSettingsChange: async (settings) => { plugin.settings = settings; },
        onRefreshIntervalChange: () => {},
    });
    const longNote = 'A detailed failure explanation that exceeds the inline preview threshold.';
    mocks.activityTracker.records = [{
        id: 'failed-stage',
        path: 'Daily/Failed.md',
        event: 'modify',
        status: 'ongoing',
        timestamp: Date.now(),
        upload: { status: 'failed', note: longNote, timestamp: Date.now() },
    }];
    mocks.activityTracker.getRecordHashes = () => new Map([['failed-stage', 'failed-hash']]);
    activityTab.render(container);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const failureBadge = container.querySelector('.pb_status_failed_clickable') as HTMLElement;
    assert.ok(failureBadge);
    assert.ok(failureBadge.textContent?.includes('...'));

    const originalOpen = PopupModal.prototype.open;
    const openedModals: PopupModal[] = [];
    PopupModal.prototype.open = function () {
        openedModals.push(this);
        originalOpen.call(this);
    };
    try {
        failureBadge.click();
    } finally {
        PopupModal.prototype.open = originalOpen;
    }

    assert.equal(openedModals.length, 1);
    assert.equal((openedModals[0] as any).title, 'Failure Details');
    assert.equal(openedModals[0].contentEl.querySelector('.pb_popup_modal')?.textContent, longNote);
    openedModals[0].close();
});
});

describe('FailedTasksTab', () => {
test('FailedTasksTab table, oversize limit warning, purge, and removal', async () => {
    const { plugin, mocks } = createTestContext();
    const container = document.createElement('div');

    let tasksUpdatedCalled = false;
    const failedTasksTab = new FailedTasksTab({
        app: plugin.app,
        failedTasksManager: mocks.failedTasksManager,
        operationsManager: mocks.operationsManager,
        onTasksUpdated: () => { tasksUpdatedCalled = true; },
    });

    failedTasksTab.render(container);

    // Empty state
    assert.ok(container.querySelector('.pb_empty_cell')?.textContent?.includes('No failed tasks recorded.'));

    // Add normal failed task and oversized failed task
    const normalTask: FailedTaskRecord = {
        id: 'fail-normal',
        intent: { id: 't1', path: 'Short.md', operation: 'save', trigger: 'auto', event: 'modify', policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY },
        stage: 'upload',
        cause: { name: 'Error', message: 'Network timeout error message that is quite long to test trimming preview behavior' },
        error: 'Network timeout error message that is quite long to test trimming preview behavior',
        noteSizeBytes: 1024,
        attempts: 2,
        timestamp: Date.now(),
        likelyReason: 'network_outage',
    };

    const oversizedTask: FailedTaskRecord = {
        id: 'fail-large',
        intent: {
            id: 't2',
            path: 'Large.md',
            operation: 'save',
            trigger: 'auto',
            event: 'modify',
            policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        },
        stage: 'upload',
        cause: { name: 'Error', message: 'PocketBase 400 validation error', status: 400 },
        error: 'PocketBase 400 validation error',
        noteSizeBytes: 4_500_000,
        attempts: 5,
        timestamp: Date.now(),
        likelyReason: 'size_limit',
        payloadPreview: 'a'.repeat(4_000_001),
    };

    mocks.failedTasksManager.tasks = [normalTask, oversizedTask];
    failedTasksTab.renderTableBody();

    const rows = container.querySelectorAll('tbody tr');
    assert.equal(rows.length, 2);

    // Oversized row should have limit warning badge
    const largeRow = rows[1];
    assert.ok(largeRow.querySelector('.pb_warning_badge'), 'Should display limit warning badge');

    // Test remove single task
    const removeBtn = largeRow.querySelector('.clickable-icon') as HTMLButtonElement;
    assert.ok(removeBtn);
    await removeBtn.click();
    assert.equal(mocks.failedTasksManager.tasks.length, 1);
    assert.equal(mocks.failedTasksManager.tasks[0].id, 'fail-normal');
    assert.equal(tasksUpdatedCalled, true);

    // Test Purge All button
    tasksUpdatedCalled = false;
    const purgeBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Purge All Errors'));
    assert.ok(purgeBtn);
    await purgeBtn.click();
    assert.equal(mocks.failedTasksManager.tasks.length, 0);
    assert.equal(tasksUpdatedCalled, true);
    assert.ok(container.querySelector('.pb_empty_cell'));
});

test('FailedTaskDetailsModal metadata, callout banner, payload preview truncation, and actions', async () => {
    const { plugin } = createTestContext();

    const record: FailedTaskRecord = {
        id: 'fail-detail',
        intent: {
            id: 't-detail',
            path: 'Deep/Nested/LargeDocument.md',
            operation: 'save',
            trigger: 'auto',
            event: 'modify',
            policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        },
        targetHash: 'testhash12345678',
        stage: 'upload',
        cause: { name: 'Error', message: 'PocketBase write failed with status 400', status: 400 },
        error: 'PocketBase write failed with status 400',
        noteSizeBytes: 5_000_000,
        attempts: 4,
        timestamp: Date.now(),
        likelyReason: 'size_limit',
        payloadPreview: 'x'.repeat(2000),
    };

    let removedRecord: FailedTaskRecord | null = null;
    const modal = new FailedTaskDetailsModal(
        plugin.app,
        record,
        async (r) => { removedRecord = r; }
    );

    modal.open();

    // Verify modal header & metadata grid
    assert.ok(modal.contentEl.querySelector('h2')?.textContent?.includes('LargeDocument.md'));
    assert.ok(modal.contentEl.querySelector('.pb_warning_callout'), 'Should render warning callout');

    // Verify payload preview truncation (> 1500 chars)
    const previewBlock = modal.contentEl.querySelector('.pb_payload_block code');
    assert.ok(previewBlock);
    assert.equal(previewBlock.textContent?.length, FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS);
    assert.ok(modal.contentEl.querySelector('.pb_trimmed_badge'));

    // Test Remove From Log button
    const removeBtn = Array.from(modal.contentEl.querySelectorAll('button')).find(b => b.textContent?.includes('Remove From Log'));
    assert.ok(removeBtn);
    removeBtn.click();
    assert.strictEqual(removedRecord, record);

    // Test Close button
    let closed = false;
    modal.close = () => { closed = true; };
    const closeBtn = Array.from(modal.contentEl.querySelectorAll('button')).find(b => b.textContent === 'Close');
    assert.ok(closeBtn);
    closeBtn.click();
    assert.equal(closed, true);
});

// test.skip('DashboardTab render does not throw', () => {
//     const dashboard = new DashboardTab();
//     const container = document.createElement('div');
//     assert.doesNotThrow(() => {
//         dashboard.render(container);
//     });
// });
});
