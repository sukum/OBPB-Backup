import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import { PBBackupSettings } from '../../types/settings';
import type { ActivityManagerTab, ActivityOperations, ActivityViewSource, FailedTaskViewSource } from './types';
import type { SyncStatusSubscriber } from '../../types/events';
// import { DashboardTab } from './dashboard-tab';
import { ActivityTab } from './activity-tab';
import { FailedTasksTab } from './failed-tasks-tab';
import { createButton } from './button';

export const VIEW_TYPE_ACTIVITY_MANAGER = 'pb-backup-activity-manager';

/**
 * Workspace Tab ItemView - Activity Manager layout with activities tab and failed tasks tab.
 */
export class ActivityManagerView extends ItemView {
    private intervalTimer: number | null = null;
    private unsubscribeTracker: (() => void) | null = null;
    private unsubscribeQueue: (() => void) | null = null;
    private unsubscribeFailedTasks: (() => void) | null = null;

    // Tabs
    private activeTab: ActivityManagerTab = 'activity';
    // private dashboardTabBtn: HTMLButtonElement | null = null;
    private activityTabBtn: HTMLButtonElement | null = null;
    private failedTabBtn: HTMLButtonElement | null = null;
    private tabContentEl: HTMLElement | null = null;

    // Modular tab components
    // private dashboardTab: DashboardTab;
    private activityTab: ActivityTab;
    private failedTasksTab: FailedTasksTab;

    constructor(
        leaf: WorkspaceLeaf,
        private tracker: ActivityViewSource,
        private queueManager: SyncStatusSubscriber,
        private getSettings: () => PBBackupSettings,
        private onSettingsChange: (settings: PBBackupSettings) => Promise<void>,
        private failedTasksManager?: FailedTaskViewSource,
        private operationsManager?: ActivityOperations
    ) {
        super(leaf);

        // this.dashboardTab = new DashboardTab();

        this.activityTab = new ActivityTab({
            app: this.app,
            tracker: this.tracker,
            operationsManager: this.operationsManager!,
            getSettings: this.getSettings,
            onSettingsChange: this.onSettingsChange,
            onRefreshIntervalChange: () => this.startTimer(),
        });

        this.failedTasksTab = new FailedTasksTab({
            app: this.app,
            failedTasksManager: this.failedTasksManager,
            operationsManager: this.operationsManager,
            onTasksUpdated: () => this.updateTabButtons(),
        });
    }

    getViewType(): string {
        return VIEW_TYPE_ACTIVITY_MANAGER;
    }

    getDisplayText(): string {
        return 'Activity Log';
    }

    getIcon(): string {
        return 'activity';
    }

    async onOpen(): Promise<void> {
        // [Source: State: ActivityTracker] Subscribe to activity lifecycle changes
        this.unsubscribeTracker = this.tracker.subscribe(() => {
            if (this.activeTab === 'activity') {
                this.activityTab.renderTableBody();
            }
        });

        // [Source: QueueManager] Subscribe to queue sync status updates
        this.unsubscribeQueue = this.queueManager.subscribe(() => {
            this.activityTab.updatePauseButton();
            if (this.activeTab === 'activity') {
                this.activityTab.renderTableBody();
            }
        });

        if (this.failedTasksManager) {
            // [Source: State: FailedTasksManager] Subscribe to failed task list updates
            this.unsubscribeFailedTasks = this.failedTasksManager.subscribe(() => {
                // Update the hover text for the failed tasks tab button to include updated count
                this.updateTabButtons();
                if (this.activeTab === 'failed_tasks') {
                    this.failedTasksTab.renderTableBody();
                }
            });
        }

        this.renderLayout();
        this.startTimer();
    }

    async onClose(): Promise<void> {
        this.stopTimer();
        if (this.unsubscribeTracker) {
            this.unsubscribeTracker();
            this.unsubscribeTracker = null;
        }
        if (this.unsubscribeQueue) {
            this.unsubscribeQueue();
            this.unsubscribeQueue = null;
        }
        if (this.unsubscribeFailedTasks) {
            this.unsubscribeFailedTasks();
            this.unsubscribeFailedTasks = null;
        }
    }

    private startTimer(): void {
        this.stopTimer();
        const refreshSec = this.activityTab.getRefreshSec();
        this.intervalTimer = window.setInterval(() => {
            if (this.activeTab === 'activity') {
                this.activityTab.renderTableBody();
            }
        }, refreshSec * 1000);
        (this.intervalTimer as unknown as { unref?: () => void })?.unref?.();
    }

    private stopTimer(): void {
        if (this.intervalTimer) {
            window.clearInterval(this.intervalTimer);
            this.intervalTimer = null;
        }
    }

    private updateTabButtons(): void {
        if (!this.activityTabBtn || !this.failedTabBtn) return;
        // this.dashboardTabBtn.toggleClass('is-active', this.activeTab === 'dashboard');
        this.activityTabBtn.toggleClass('is-active', this.activeTab === 'activity');
        this.failedTabBtn.toggleClass('is-active', this.activeTab === 'failed_tasks');

        const failedCount = this.failedTasksManager?.getCount() || 0;
        const failedLabel = failedCount > 0 ? `Failed tasks (${failedCount})` : 'Failed tasks';
        this.failedTabBtn.setText(failedLabel);
        setIcon(this.failedTabBtn, 'alert-triangle');
    }

    private renderLayout(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('pb_activity_manager_view');

        // --- Sub-Tab Navigation ---
        const tabNav = containerEl.createDiv({ cls: 'pb_tab_nav' });

        const setActiveTab = (activeTab: ActivityManagerTab) => {
            if (this.activeTab !== activeTab) {
                this.activeTab = activeTab;
                this.updateTabButtons();
                this.renderTabContent();
            }
        }

        // this.dashboardTabBtn = createButton({
        //     parent: tabNav,
        //     cls: `pb_tab_btn ${this.activeTab === 'dashboard' ? 'is-active' : ''}`,
        //     text: 'Dashboard',
        //     icon: 'layout-dashboard',
        //     onClick: () => setActiveTab('dashboard'),
        // });

        this.activityTabBtn = createButton({
            parent: tabNav,
            cls: `pb_tab_btn ${this.activeTab === 'activity' ? 'is-active' : ''}`,
            text: 'Activity log',
            icon: 'activity',
            onClick: () => setActiveTab('activity'),
        });

        const failedCount = this.failedTasksManager?.getCount() || 0;
        const failedLabel = failedCount > 0 ? `Failed Tasks (${failedCount})` : 'Failed Tasks';
        this.failedTabBtn = createButton({
            parent: tabNav,
            cls: `pb_tab_btn ${this.activeTab === 'failed_tasks' ? 'is-active' : ''}`,
            text: failedLabel,
            icon: 'alert-triangle',
            onClick: () => setActiveTab('failed_tasks'),
        });

        this.tabContentEl = containerEl.createDiv({ cls: 'pb_tab_content' });
        this.renderTabContent();
    }

    private renderTabContent(): void {
        if (!this.tabContentEl) return;
        this.tabContentEl.empty();

        // if (this.activeTab === 'dashboard') {
        //     this.dashboardTab.render(this.tabContentEl);
        // } else
        if (this.activeTab === 'activity') {
            this.activityTab.render(this.tabContentEl);
        } else {
            this.failedTasksTab.render(this.tabContentEl);
        }
    }
}
