import type OBPBBackupPlugin from '../../main';
import type { Container } from '../../container';
import { PocketBaseStore } from '../../remote/pocketbase-store';
import { DeviceManager } from '../../state/device-manager';
import { VaultStatsViewRecord } from '../../types/database';
import { formatBytes } from '../../utils/format';
import { SettingsSection, SettingsSectionContext } from './types';
import { Setting, Notice, setIcon } from 'obsidian';

export class StorageMetricsSection implements SettingsSection {
    container: Container;
    constructor(private plugin: OBPBBackupPlugin) {
        this.container = this.plugin.container;
    }

    render(context: SettingsSectionContext): void {
        const { containerEl } = context;
        containerEl.createEl('h3', { text: 'Remote storage metrics' });

        new Setting(containerEl)
            .setName('Fetch DB stats')
            .setDesc('Fetch the latest statistics from the remote PocketBase database.')
            .addButton((btn) => {
                btn
                    .setButtonText('Load stats')
                    .setCta()
                    .onClick(async () => {
                        btn.setDisabled(true);
                        btn.buttonEl.empty();
                        setIcon(btn.buttonEl, 'refresh-cw');
                        btn.buttonEl.addClass('obpb_spin');
                        try {
                            await this.renderStorageDashboard(dashboardEl);
                            btn.buttonEl.removeClass('obpb_spin');
                            btn.buttonEl.empty();
                            btn.setButtonText('Fetched ✓');
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            new Notice(`Failed to fetch stats: ${msg}`);
                            btn.buttonEl.removeClass('obpb_spin');
                            btn.buttonEl.empty();
                            btn.setButtonText('Load stats');
                        } finally {
                            btn.setDisabled(false);
                        }
                    });
            });
        containerEl.createEl('div', { cls: 'obpb_spacer' });
        const dashboardEl = containerEl.createDiv({ cls: 'obpb_dashboard' });
    }

    private async renderStorageDashboard(container: HTMLElement): Promise<void> {
        const store = this.container.resolve(PocketBaseStore);
        const deviceManager = this.container.resolve(DeviceManager);

        container.empty();
        const loading = container.createEl('p', { text: 'Loading remote storage statistics...' });

        try {
            // From the pocketbase view  - vault_stats
            // Need to test the performance of the query later
            const stats: VaultStatsViewRecord | null = await store.getVaultStats(
                deviceManager.getVaultId()
            );

            loading.remove();

            if (!stats || stats.total_objects === 0) {
                container.createEl('p', {
                    cls: 'obpb_empty',
                    text: 'No backups recorded yet in remote database.',
                });
                return;
            }

            const grid = container.createDiv({ cls: 'obpb_metrics_grid' });

            this.createMetricCard(grid, 'Total remote storage', formatBytes(stats.total_bytes));
            this.createMetricCard(grid, 'Stored versions', `${stats.total_objects}`);
            this.createMetricCard(grid, 'Snapshots / Diffs', `${stats.snapshot_count} / ${stats.diff_count}`);
            this.createMetricCard(grid, 'Total events logged', `${stats.total_entries}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            loading.setText(`Storage statistics unavailable: ${msg}`);
            loading.addClass('obpb_error');
        }
    }

    private createMetricCard(container: HTMLElement, label: string, value: string): void {
        const card = container.createDiv({ cls: 'obpb_metric_card' });
        card.createDiv({ cls: 'obpb_metric_value', text: value });
        card.createDiv({ cls: 'obpb_metric_label', text: label });
    }
}
