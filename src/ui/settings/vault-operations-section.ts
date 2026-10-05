import { Setting, Notice, ButtonComponent, debounce } from 'obsidian';
import type PBBackupPlugin from '../../main';
import type { Container } from '../../container';
import { OperationsManager } from '../../operations/operations-manager';

import { SettingsSection, SettingsSectionContext } from './types';

export class VaultOperationsSection implements SettingsSection {
    container: Container;

    constructor(private plugin: PBBackupPlugin) {
        this.container = this.plugin.container;
    }

    render(context: SettingsSectionContext): void {
        const operationsManager = this.container.resolve(OperationsManager);
        const { containerEl, refreshTab } = context;

        containerEl.createEl('h3', { text: 'Vault operations' });

        new Setting(containerEl)
            .setName('Batch upload concurrency')
            .setDesc(
                'Maximum number of concurrent file uploads during Backup and Sync operations. (Default: 3, Range: 1-10)'
            )
            .addSlider((slider) =>
                slider
                    .setLimits(1, 10, 1)
                    .setValue(this.plugin.settings.batchConcurrency || 3)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.batchConcurrency = value;
                        await this.plugin.saveSettings();
                    })
            )
            .addExtraButton((btn) =>
                btn
                    .setIcon('reset')
                    .setTooltip('Reset to default (3)')
                    .onClick(async () => {
                        this.plugin.settings.batchConcurrency = 3;
                        await this.plugin.saveSettings();
                        refreshTab();
                    })
            );

        const vaultOpStatusEl = containerEl.createDiv({ cls: 'pb_vault_op_status' });
        vaultOpStatusEl.style.display = 'none';

        let backupBtnRef: ButtonComponent | null = null;
        let syncBtnRef: ButtonComponent | null = null;
        let stopBtnRef: ButtonComponent | null = null;
        let activeProgressDebouncer: { cancel(): void } | null = null;


        const updateButtons = (running: boolean | null = null) => {
            const isRunning = operationsManager.isOperationRunning();
            running ??= isRunning;
            if (backupBtnRef) {
                backupBtnRef.setDisabled(running);
                backupBtnRef.setButtonText(running ? 'Running...' : 'Backup (snapshot)');
            }
            if (syncBtnRef) {
                syncBtnRef.setDisabled(running);
                syncBtnRef.setButtonText(running ? 'Running...' : 'Sync (reconcile)');
            }
            if (stopBtnRef) {
                stopBtnRef.setDisabled(!running);
                stopBtnRef.setButtonText('Stop');
            }
        };

        new Setting(containerEl)
            .setName('Run vault operations')
            .setDesc(
                'Backup creates a snapshot for all files. Sync reconciles against remote latest backup state (diffs modified, snapshots new, deletes missing).'
            )
            .addButton((btn) => {
                backupBtnRef = btn;
                btn.setButtonText('Backup (snapshot)')
                    .setCta()
                    .setDisabled(operationsManager.isOperationRunning())
                    .onClick(async () => {
                        updateButtons(true);
                        vaultOpStatusEl.style.display = 'block';
                        vaultOpStatusEl.setText('Starting vault snapshot backup...');

                        const updateStatus = debounce((cur: number, tot: number, p: string, action: string) => {
                            const filename = p ? p.split('/').pop() : '';
                            vaultOpStatusEl.setText(`Backup (${cur}/${tot}) [${action}] ${filename}`);
                        }, 500, false);
                        activeProgressDebouncer = updateStatus;

                        try {
                            // The callback passed to backupVault is called on each file processed
                            const res = await operationsManager.backupVault((cur, tot, p, action) => {
                                updateStatus(cur, tot, p, action);
                            });
                            updateStatus.cancel();
                            if (res.stopped) {
                                new Notice(
                                    `Vault backup stopped: ${res.uploaded} snapshotted (${res.processed}/${res.totalFiles} processed).`
                                );
                                vaultOpStatusEl.setText(
                                    `Backup stopped by user: ${res.uploaded} files snapshotted (${res.processed}/${res.totalFiles} processed).`
                                );
                            } else {
                                new Notice(`Vault backup complete: ${res.uploaded} files snapshotted.`);
                                vaultOpStatusEl.setText(`Backup complete: ${res.uploaded} files snapshotted.`);
                            }
                        } catch (err) {
                            updateStatus.cancel();
                            const msg = err instanceof Error ? err.message : String(err);
                            new Notice(`Vault backup failed: ${msg}`);
                            vaultOpStatusEl.setText(`Backup failed: ${msg}`);
                        } finally {
                            activeProgressDebouncer = null;
                            updateButtons(false);
                        }
                    });
            })
            .addButton((btn) => {
                syncBtnRef = btn;
                btn.setButtonText('Sync (reconcile)')
                    .setDisabled(operationsManager.isOperationRunning())
                    .onClick(async () => {
                        updateButtons(true);
                        vaultOpStatusEl.style.display = 'block';
                        vaultOpStatusEl.setText('Starting vault sync...');

                        const updateStatus = debounce((cur: number, tot: number, p: string, action: string) => {
                            const filename = p ? p.split('/').pop() : '';
                            vaultOpStatusEl.setText(`Sync (${cur}/${tot}) [${action}] ${filename}`);
                        }, 500, false);
                        activeProgressDebouncer = updateStatus;

                        try {
                            // The callback passed to syncVault is called on each file processed
                            const res = await operationsManager.syncVault((cur, tot, p, action) => {
                                updateStatus(cur, tot, p, action);
                            });
                            updateStatus.cancel();
                            const delMsg = res.deleted && res.deleted > 0 ? `, ${res.deleted} deleted` : '';
                            const skippedMsg = res.skipped ? `, ${res.skipped} skipped` : '';
                            const failedMsg = res.failed ? `, ${res.failed} failed` : '';
                            if (res.stopped) {
                                new Notice(
                                    `Vault sync stopped: ${res.uploaded} uploaded, ${res.unchanged} unchanged${skippedMsg}${delMsg}${failedMsg} (${res.processed}/${res.totalFiles} processed).`
                                );
                                vaultOpStatusEl.setText(
                                    `Sync stopped by user: ${res.uploaded} uploaded, ${res.unchanged} unchanged${skippedMsg}${delMsg}${failedMsg} (${res.processed}/${res.totalFiles} processed).`
                                );
                            } else if (res.failed) {
                                new Notice(
                                    `Vault sync finished with errors: ${res.uploaded} uploaded, ${res.unchanged} unchanged${skippedMsg}${delMsg}${failedMsg}.`
                                );
                                vaultOpStatusEl.setText(
                                    `Sync finished with errors: ${res.uploaded} uploaded, ${res.unchanged} unchanged${skippedMsg}${delMsg}${failedMsg}.`
                                );
                            } else {
                                new Notice(
                                    `Vault sync complete: ${res.uploaded} uploaded, ${res.unchanged} unchanged${skippedMsg}${delMsg}.`
                                );
                                vaultOpStatusEl.setText(
                                    `Sync complete: ${res.uploaded} uploaded, ${res.unchanged} unchanged${skippedMsg}${delMsg}.`
                                );
                            }
                        } catch (err) {
                            updateStatus.cancel();
                            const msg = err instanceof Error ? err.message : String(err);
                            new Notice(`Vault sync failed: ${msg}`);
                            vaultOpStatusEl.setText(`Sync failed: ${msg}`);
                        } finally {
                            activeProgressDebouncer = null;
                            updateButtons(false);
                        }
                    });
            })
            .addButton((btn) => {
                stopBtnRef = btn;
                btn.setButtonText('Stop')
                    .setWarning()
                    .setDisabled(!operationsManager.isOperationRunning())
                    .onClick(async () => {
                        btn.setDisabled(true);
                        btn.setButtonText('Stopping...');
                        activeProgressDebouncer?.cancel();
                        vaultOpStatusEl.setText('Stopping vault operation... completing active batch...');
                        await operationsManager.stopVaultOperation();
                    });
            });
    }
}
