import { Setting, Notice } from 'obsidian';
import type OBPBBackupPlugin from '../../main';
import type { Container } from '../../container';
import { OperationsManager } from '../../operations/operations-manager';
import { SettingsSection, SettingsSectionContext } from './types';
import { activateActivityManagerView } from '../view-registry';
import { DEFAULT_ACTIVITY_HISTORY_LIMIT } from '../../state/constants';

export class ActivityManagerSection implements SettingsSection {
    container: Container;
    constructor(private plugin: OBPBBackupPlugin) {
        this.container = this.plugin.container;
    }

    render(context: SettingsSectionContext): void {
        const { containerEl, refreshTab } = context;

        containerEl.createEl('h3', { text: 'Activity History & Realtime Manager' });

        const historyLimit = this.plugin.settings.activityHistoryLimit || DEFAULT_ACTIVITY_HISTORY_LIMIT;

        new Setting(containerEl)
            .setName('Activity History Limit')
            .setDesc('Maximum number of completed backup events retained on disk in local_data/activity_history.json.')
            .addSlider((slider) =>
                slider
                    .setLimits(20, 500, 10) //min,max,step
                    .setValue(historyLimit)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.activityHistoryLimit = value;
                        await this.plugin.saveSettings();
                    })
            )
            .addExtraButton((btn) =>
                btn
                    .setIcon('reset')
                    .setTooltip(`Reset to default (${DEFAULT_ACTIVITY_HISTORY_LIMIT})`)
                    .onClick(async () => {
                        this.plugin.settings.activityHistoryLimit = DEFAULT_ACTIVITY_HISTORY_LIMIT;
                        await this.plugin.saveSettings();
                        refreshTab();
                    })
            );

        new Setting(containerEl)
            .setName('Open Activity Manager')
            .setDesc('Open the realtime activity manager workspace tab to monitor active debounces, upload queue, and event logs.')
            .addButton((btn) =>
                btn
                    .setButtonText('Open Activity Manager Tab')
                    .onClick(() => {
                        void activateActivityManagerView(this.plugin.app);
                    })
            );

        new Setting(containerEl)
            .setName('Upload Queue')
            .setDesc('Temporarily pause or resume uploading queued backup files to remote storage. When paused, edits and diffs continue being recorded into the local queue.')
            .addButton((btn) => {
                const updateBtn = () => {
                    const operationsManager = this.container.resolve(OperationsManager);
                    const isPaused = operationsManager.isQueuePaused();
                    if (isPaused) {
                        btn.setButtonText('Resume Uploads');
                        btn.setCta();
                        btn.setIcon('play');
                    } else {
                        btn.setButtonText('Pause Uploads');
                        btn.removeCta();
                        btn.setIcon('pause');
                    }
                };
                updateBtn();
                btn.onClick(() => {
                    const operationsManager = this.container.resolve(OperationsManager);
                    if (operationsManager.isQueuePaused()) {
                        operationsManager.resumeQueue();
                        new Notice('Resumed upload queue.');
                    } else {
                        operationsManager.pauseQueue();
                        new Notice('Paused upload queue.');
                    }
                    updateBtn();
                });
            });
    }
}
