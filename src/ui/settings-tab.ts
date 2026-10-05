import { App, PluginSettingTab } from 'obsidian';
import type PBBackupPlugin from '../main';
import { SettingsSection } from './settings/types';
import { ServerAccountSection } from './settings/server-account-section';
import { DebounceTimingSection } from './settings/debounce-timing-section';
import { FileFiltersSection } from './settings/file-filters-section';
import { ActivityManagerSection } from './settings/activity-manager-section';
import { VaultOperationsSection } from './settings/vault-operations-section';
import { StorageMetricsSection } from './settings/storage-metrics-section';

export class PBBackupSettingTab extends PluginSettingTab {
    plugin: PBBackupPlugin;
    private sections: SettingsSection[];

    constructor(app: App, plugin: PBBackupPlugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.sections = [
            new ServerAccountSection(this.plugin),
            new DebounceTimingSection(this.plugin),
            new FileFiltersSection(this.plugin),
            new ActivityManagerSection(this.plugin),
            new VaultOperationsSection(this.plugin),
            new StorageMetricsSection(this.plugin),
        ];
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'PB backup settings' });

        const context = {
            containerEl,
            refreshTab: () => this.display(),
        };

        for (const section of this.sections) {
            void section.render(context);
        }
    }
}
