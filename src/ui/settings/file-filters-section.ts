import { Setting } from 'obsidian';
import type OBPBBackupPlugin from '../../main';
import { SettingsSection, SettingsSectionContext } from './types';

export class FileFiltersSection implements SettingsSection {
    constructor(private plugin: OBPBBackupPlugin) {}

    render(context: SettingsSectionContext): void {
        const { containerEl } = context;

        containerEl.createEl('h3', { text: 'Thresholds & File Filters' });

        new Setting(containerEl)
            .setName('Monitored File Extensions')
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
            .setName('Safety Backup Before Restore')
            .setDesc('Record a local snapshot of current unsaved edits before restoring a historical revision.')
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
