import { Setting } from 'obsidian';
import type OBPBBackupPlugin from '../../main';
import type { Container } from '../../container';
import { DebounceController } from '../../vault/debounce-controller';
import { SettingsSection, SettingsSectionContext } from './types';

export class DebounceTimingSection implements SettingsSection {
    container: Container;
    debounceController: DebounceController;
    constructor(private plugin: OBPBBackupPlugin) {
        this.container = this.plugin.container;
        this.debounceController = this.container.resolve(DebounceController);
    }

    render(context: SettingsSectionContext): void {
        const { containerEl, refreshTab } = context;

        containerEl.createEl('h3', { text: 'Debounce & backup timing' });

        new Setting(containerEl)
            .setName('Debounce interval')
            .setDesc(
                'Pause duration before computing a diff and queuing an upload. Higher values prevent repeated backups during typing pauses. (Default: 30s)'
            )
            .addSlider((slider) =>
                slider
                    .setLimits(10, 120, 5)
                    .setValue(this.plugin.settings.debounceIntervalMs / 1000)
                    .setDynamicTooltip()
                    .onChange(async (seconds) => {
                        this.plugin.settings.debounceIntervalMs = seconds * 1000;
                        await this.plugin.saveSettings();
                        this.debounceController.updateSettings(
                            this.plugin.settings.debounceIntervalMs,
                            this.plugin.settings.maxWaitMs
                        );
                    })
            )
            .addExtraButton((btn) =>
                btn
                    .setIcon('reset')
                    .setTooltip('Reset to default (30s)')
                    .onClick(async () => {
                        this.plugin.settings.debounceIntervalMs = 30000;
                        await this.plugin.saveSettings();
                        this.debounceController.updateSettings(
                            this.plugin.settings.debounceIntervalMs,
                            this.plugin.settings.maxWaitMs
                        );
                        refreshTab();
                    })
            );

        new Setting(containerEl)
            .setName('Maximum continuous wait')
            .setDesc(
                'Maximum time the above debounces pauses before this value overrides it and forces a backup. (Default: 5 minutes)'
            )
            .addSlider((slider) =>
                slider
                    .setLimits(1, 30, 1)
                    .setValue(this.plugin.settings.maxWaitMs / 60000)
                    .setDynamicTooltip()
                    .onChange(async (minutes) => {
                        this.plugin.settings.maxWaitMs = minutes * 60000;
                        await this.plugin.saveSettings();
                        this.debounceController.updateSettings(
                            this.plugin.settings.debounceIntervalMs,
                            this.plugin.settings.maxWaitMs
                        );
                    })
            )
            .addExtraButton((btn) =>
                btn
                    .setIcon('reset')
                    .setTooltip('Reset to default (5 mins)')
                    .onClick(async () => {
                        this.plugin.settings.maxWaitMs = 300000;
                        await this.plugin.saveSettings();
                        this.debounceController.updateSettings(
                            this.plugin.settings.debounceIntervalMs,
                            this.plugin.settings.maxWaitMs
                        );
                        refreshTab();
                    })
            );
    }
}
