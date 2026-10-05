import { Plugin } from 'obsidian';
import { PBBackupSettings, DEFAULT_SETTINGS } from './types/settings';
import { Container } from './container';
import { runOnLayoutReady, bootstrapContainer, teardownContainer } from './bootstrap';
import { registerCommands } from './ui/command-registry';
import { registerViews } from './ui/view-registry';
import { registerEvents } from './vault/event-registry';
import { PBBackupSettingTab } from './ui/settings-tab';
import { parsePersistedSettings } from './state/settings-validation';

export default class PBBackupPlugin extends Plugin {
    public settings: PBBackupSettings = DEFAULT_SETTINGS;
    public container!: Container;
    public readonly shutdownController = new AbortController();

    async onload(): Promise<void> {
        // console.info('[PB Backup] Loading plugin...');

        // Load user settings
        await this.loadSettings();

        //  Bootstrap container with all core services & sequential initializations
        this.container = await bootstrapContainer(this);
        // await asyncInitialize(this, this.container); // moved to onLayoutReady

        // Register Views, status bar, and ribbon icons
        registerViews(this, this.container);

        // Settings Tab
        this.addSettingTab(new PBBackupSettingTab(this.app, this));

        // Startup crash recovery and initial queue run
        this.app.workspace.onLayoutReady(async () => {
            if (this.shutdownController.signal.aborted) return;
            await runOnLayoutReady(this, this.container);
            if (this.shutdownController.signal.aborted) return;
            // obsidian docs recommends vault event registrations inside onLayoutReady
            registerEvents(this, this.container);
            registerCommands(this, this.container);
        });
    }

    onunload(): void {
        this.shutdownController.abort();
        // console.info('[PB Backup] Unloading plugin...');
        (async () => {
            await teardownContainer(this.container);
        })().catch((err) => {
            console.error('PB Backup: Failed teardownContainer:', err);
        });
    }

    public async loadSettings(): Promise<void> {
        const loaded: unknown = await this.loadData();
        const persistedSettings = parsePersistedSettings(loaded);
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...persistedSettings,
            monitoredExtensions: [
                ...(persistedSettings.monitoredExtensions ?? DEFAULT_SETTINGS.monitoredExtensions),
            ],
        };
    }

    public async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
