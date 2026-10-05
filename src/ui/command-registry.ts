import { Notice } from 'obsidian';
import { Container } from '../container';
import { OperationsManager } from '../operations/operations-manager';
import { activateHistoryView } from './view-registry';
import type PBBackupPlugin from '../main';

/**
 * Registers all user commands for PB Backup with Obsidian.
 */
export function registerCommands(plugin: PBBackupPlugin, container: Container): void {

    /*
    // Open Activity Manager
    plugin.addCommand({
        id: 'open-activity-manager',
        name: 'Open Activity History & Manager',
        callback: () => {
            void activateActivityManagerView(plugin.app);
        },
    });
    */
    // Open History View
    plugin.addCommand({
        id: 'open-history',
        name: 'Open note version history',
        callback: () => {
            void activateHistoryView(plugin.app);
        },
    });

    // Backup All Files (Snapshot)
    plugin.addCommand({
        id: 'backup-all',
        name: 'Backup all files (snapshot)',
        callback: async () => {
            const ops = container.resolve(OperationsManager);
            new Notice('Starting full vault snapshot backup...');
            try {
                const res = await ops.backupVault();
                new Notice(`Vault backup complete: ${res.uploaded} files snapshotted.`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                new Notice(`Vault backup failed: ${msg}`);
            }
        },
    });

    // Sync All Files (Diff/Snapshot)
    plugin.addCommand({
        id: 'sync-all',
        name: 'Sync all files (diff/snapshot)',
        callback: async () => {
            const ops = container.resolve(OperationsManager);
            new Notice('Starting vault sync...');
            try {
                const res = await ops.syncVault();
                const delMsg = res.deleted && res.deleted > 0 ? `, ${res.deleted} deleted` : '';
                const skippedMsg = res.skipped ? `, ${res.skipped} skipped` : '';
                new Notice(`Vault sync complete: ${res.uploaded} uploaded, ${res.unchanged} unchanged${skippedMsg}${delMsg}.`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                new Notice(`Vault sync failed: ${msg}`);
            }
        },
    });
    /*
    // Pause Queue
    plugin.addCommand({
        id: 'pause-queue',
        name: 'Pause Upload Queue',
        callback: () => {
            container.resolve(OperationsManager).pauseQueue();
            new Notice('PB Backup: Upload queue paused.');
        },
    });

    // Resume Queue
    plugin.addCommand({
        id: 'resume-queue',
        name: 'Resume Upload Queue',
        callback: () => {
            container.resolve(OperationsManager).resumeQueue();
            new Notice('PB Backup: Upload queue resumed.');
        },
    });

    // Stop Vault Operation
    plugin.addCommand({
        id: 'stop-operation',
        name: 'Stop Vault Backup / Sync',
        callback: async () => {
            const ops = container.resolve(OperationsManager);
            if (ops.isOperationRunning()) {
                await ops.stopVaultOperation();
                new Notice('Stopping vault operation... completing active file/batch.');
            } else {
                new Notice('No vault backup or sync operation is currently running.');
            }
        },
    });
    // Browse Deleted Files (Trash)
    plugin.addCommand({
        id: 'browse-deleted',
        name: 'Browse Deleted Files (Trash)',
        callback: () => {
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
        },
    });
    */

    // Backup Active File Now
    plugin.addCommand({
        id: 'save-active-now',
        name: 'Backup active file to Pocketbase',
        checkCallback: (checking: boolean) => {
            const file = plugin.app.workspace.getActiveFile();
            if (file) {
                if (!checking) {
                    const ops = container.resolve(OperationsManager);
                    void ops.backupFileNow(file);
                    new Notice(`Backup enqueued for ${file.name}`);
                }
                return true;
            }
            return false;
        },
    });

    /*
    // Flush All Pending Backups
    plugin.addCommand({
        id: 'flush-all',
        name: 'Flush All Pending Backups',
        callback: async () => {
            const ops = container.resolve(OperationsManager);
            await ops.flushAndProcessQueue();
            new Notice('Flushed all pending backups to queue.');
        },
    });
    */
}
