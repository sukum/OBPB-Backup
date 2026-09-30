export interface SettingsSectionContext {
    containerEl: HTMLElement;
    refreshTab: () => void;
}

export interface SettingsSection {
    render(context: SettingsSectionContext): void | Promise<void>;
}
