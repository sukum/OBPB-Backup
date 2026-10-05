import { Setting } from 'obsidian';
import type PBBackupPlugin from '../../main';
import { SettingsSection, SettingsSectionContext } from './types';

export class FileFiltersSection implements SettingsSection {
    constructor(private plugin: PBBackupPlugin) {}

    render(context: SettingsSectionContext): void {
        const { containerEl } = context;

        containerEl.createEl('h3', { text: 'Thresholds & file filters' });

        new Setting(containerEl)
            .setName('Monitored file extensions')
            .setDesc('Comma-separated list of file extensions to track (e.g. md, canvas)')
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.monitoredExtensions.join(', '))
                    .onChange(async (val) => {
                        this.plugin.settings.monitoredExtensions = val
                            .split(',')
                            .map((s) => s.trim().replace(/^\./, ''))
                            .filter(Boolean);
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Safety backup before restore')
            .setDesc('Backup existing note when you click to restore a historical revision.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.safetyBackupBeforeRestore)
                    .onChange(async (val) => {
                        this.plugin.settings.safetyBackupBeforeRestore = val;
                        await this.plugin.saveSettings();
                    })
            );
    }
}
