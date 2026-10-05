import { App, MarkdownView, Menu, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import { Container } from '../container';
import { HistoryView, VIEW_TYPE_HISTORICAL_BACKUP } from './note-history/history-view';
import { HistoryModal } from './note-history/history-modal';
import { NoteHistoryBuildContext } from './note-history/types';
import { ActivityManagerView, VIEW_TYPE_ACTIVITY_MANAGER } from './activity-manager';
import { StatusBarWidget } from './status-bar';
import { PocketBaseStore } from '../remote/pocketbase-store';
import { OperationsManager } from '../operations/operations-manager';
import { ActivityTracker } from '../state/activity-tracker';
import { AutomaticQueueManager } from '../queue/automatic-queue-manager';
import { FailedTasksManager } from '../state/failed-tasks-manager';
import { DeviceManager } from '../state/device-manager';
import type PBBackupPlugin from '../main';
import { TrashModal } from './trash/trash-modal';

export { VIEW_TYPE_HISTORICAL_BACKUP, VIEW_TYPE_ACTIVITY_MANAGER };

/**
 * Registers all workspace views, ribbon icons, and status bar items.
 */
export function registerViews(plugin: PBBackupPlugin, container: Container): void {

    // Register Note Version History View
    plugin.registerView(
        VIEW_TYPE_HISTORICAL_BACKUP,
        (leaf: WorkspaceLeaf) => {
            const deviceManager = container.resolve(DeviceManager);
            const historyContext: NoteHistoryBuildContext = {
                getVaultId: () => deviceManager.getVaultId(),
                operationsManager: container.resolve(OperationsManager),
            };
            // List of historical versions for the note
            return new HistoryView(
                leaf,
                () => deviceManager.getVaultId(),
                container.resolve(PocketBaseStore),
                // On selecting a note version, open it in modal
                (item) => {
                    new HistoryModal(
                        plugin.app,
                        historyContext,
                        item
                    ).open();
                }
            );
        }
    );

    // Register Activity Manager View (with backward compatibility)
    const viewFactory = (leaf: WorkspaceLeaf) =>
        new ActivityManagerView(
            leaf,
            container.resolve(ActivityTracker),
            container.resolve(AutomaticQueueManager),
            () => plugin.settings,
            async (updated) => {
                plugin.settings = updated;
                await plugin.saveSettings();
            },
            container.resolve(FailedTasksManager),
            container.resolve(OperationsManager)
        );

    plugin.registerView(VIEW_TYPE_ACTIVITY_MANAGER, viewFactory);

    // Register Status Bar Widget
    const statusBarItem = plugin.addStatusBarItem();
    const statusBarWidget = new StatusBarWidget(
        statusBarItem,
        container.resolve(AutomaticQueueManager)
    );
    statusBarWidget.initialize();
    container.registerInstance(StatusBarWidget, statusBarWidget);

    // Register Ribbon Icons
    // plugin.addRibbonIcon('history', 'PB Backup: Note History', () => {
    //     void activateHistoryView(plugin.app);
    // });

    // plugin.addRibbonIcon('activity', 'PB Backup: Activity Manager', () => {
    //     void activateProcessManagerView(plugin.app);
    // });

    // left bar buttons
    plugin.addRibbonIcon('archive', 'PB Backup', (event) => {
        const centralLeaf = plugin.app.workspace.getMostRecentLeaf(plugin.app.workspace.rootSplit);
        // const markdownView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
        // If note is open in the central leaf, use it as the active file.
        const markdownView = centralLeaf?.view instanceof MarkdownView ? centralLeaf.view : null;
        const activeFile = markdownView?.file;

        const menu = new Menu();
        menu.addItem((item) => {
            item.setTitle('Activity log')
                .setIcon('activity')
                .onClick(() => void activateActivityManagerView(plugin.app));
        });
        menu.addItem((item) => {
            item.setTitle('Trashed files')
                .setIcon('trash')
                .onClick(() => {
                    const store = container.resolve(PocketBaseStore);
                    const operationsManager = container.resolve(OperationsManager);
                    const deviceManager = container.resolve(DeviceManager);
                    const modal = new TrashModal(
                        plugin.app,
                        deviceManager.getVaultId(),
                        store,
                        operationsManager
                    );
                    modal.open();
                });
        });

        if (activeFile instanceof TFile) {
            menu.addSeparator();
            menu.addItem((item) => {
                item.setTitle('Note version history')
                    .setIcon('history')
                    .onClick(() => void activateHistoryView(plugin.app));
            });
            const syncTitle = activeFile.basename.length > 20 ? `Sync now: "${activeFile.basename.substring(0, 20)}..."` : `Sync now: "${activeFile.basename}"`;
            menu.addItem((item) => {
                item.setTitle(syncTitle)
                    .setIcon('save')
                    .onClick(async () => {
                        const ops = container.resolve(OperationsManager);
                        const result = await ops.backupFileNow(activeFile);
                        if (result === null) {
                            new Notice(`[PB Backup] Backup was not started for ${activeFile.name}; another backup or vault operation may be active.`);
                        }
                    });
            });

            const snapshotTitle = activeFile.basename.length > 20 ? `Snapshot now: "${activeFile.basename.substring(0, 20)}..."` : `Snapshot now: "${activeFile.basename}"`;
            menu.addItem((item) => {
                item.setTitle(snapshotTitle)
                    .setIcon('save')
                    .onClick(async () => {
                        const ops = container.resolve(OperationsManager);
                        const result = await ops.snapshotFileNow(activeFile);
                        if (result === null) {
                            new Notice(`[PB Backup] Snapshot was not started for ${activeFile.name}; another backup or vault operation may be active.`);
                        }
                    });
            });
        }

        menu.showAtMouseEvent(event);
    });
}

/**
 * Opens or reveals the Note Version History leaf in the workspace.
 */
export async function activateHistoryView(app: App): Promise<void> {
    const { workspace } = app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_HISTORICAL_BACKUP);

    if (leaves.length > 0) {
        leaf = leaves[0];
    } else {
        const rightLeaf = workspace.getRightLeaf(false);
        if (rightLeaf) {
            leaf = rightLeaf;
            await leaf.setViewState({
                type: VIEW_TYPE_HISTORICAL_BACKUP,
                active: true,
            });
        }
    }

    if (leaf) {
        await workspace.revealLeaf(leaf);
    }
}

/**
 * Opens or reveals the Activity Manager tab in the workspace.
 */
export async function activateActivityManagerView(app: App): Promise<void> {
    const { workspace } = app;
    let leaf: WorkspaceLeaf | null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_ACTIVITY_MANAGER);

    if (leaves.length > 0) {
        leaf = leaves[0];
    } else {
        leaf = workspace.getLeaf('tab');
        if (leaf) {
            await leaf.setViewState({
                type: VIEW_TYPE_ACTIVITY_MANAGER,
                active: true,
            });
        }
    }

    if (leaf) {
        await workspace.revealLeaf(leaf);
    }
}
