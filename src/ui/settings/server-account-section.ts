import { Setting, Notice, ButtonComponent, setIcon } from 'obsidian';
import type PBBackupPlugin from '../../main';
import type { Container } from '../../container';
import { AutomaticQueueManager } from '../../queue/automatic-queue-manager';
import { AuthManager } from '../../remote/auth-manager';
import { PocketBaseHealthChecker } from '../../remote/pocketbase-health-checker';
import { DeviceManager } from '../../state/device-manager';

import { SettingsSection, SettingsSectionContext } from './types';

export class ServerAccountSection implements SettingsSection {
    container: Container;
    authManager: AuthManager;
    queueManager: AutomaticQueueManager;
    deviceManager: DeviceManager;
    healthChecker: PocketBaseHealthChecker;
    constructor(private plugin: PBBackupPlugin) {
        this.container = this.plugin.container;
        this.authManager = this.container.resolve(AuthManager);
        this.queueManager = this.container.resolve(AutomaticQueueManager);
        this.deviceManager = this.container.resolve(DeviceManager);
        this.healthChecker = this.container.resolve(PocketBaseHealthChecker);
    }

    render(context: SettingsSectionContext): void {
        const { containerEl } = context;

        containerEl.createEl('h3', { text: 'Server & account' });

        let pocketbaseUrl = this.plugin.settings.serverUrl;
        let testConnectionBtn: ButtonComponent;
        new Setting(containerEl)
            .setName('Server URL')
            .setDesc('PocketBase instance endpoint (e.g. https://backup.example.com)')
            .addButton((btn) => {
                testConnectionBtn = btn;
                btn
                    .setButtonText('Test connection')
                    .setCta()
                    .onClick(async () => {
                        if (!pocketbaseUrl) {
                            new Notice('Please enter the PocketBase server URL.');
                            return;
                        }
                        btn.setDisabled(true);
                        btn.setButtonText('Connecting...');
                        try {
                            await this.healthChecker.healthCheck();
                            new Notice('Connection successful!');
                            btn.setButtonText('Connection ✓');
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            new Notice(`Connection failed: ${msg}`);
                            btn.setButtonText('Test connection');
                        } finally {
                            btn.setDisabled(false);
                        }
                    })
            })
            .addText((text) =>
                text
                    .setPlaceholder('https://...')
                    .setValue(this.plugin.settings.serverUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.serverUrl = value.trim();
                        await this.plugin.saveSettings();
                        pocketbaseUrl = value.trim();
                        if (testConnectionBtn) {
                            testConnectionBtn.setButtonText('Test connection');
                        }
                    })
            );

        new Setting(containerEl)
            .setName('User email')
            .setDesc('Account email used for authentication')
            .addText((text) =>
                text
                    .setPlaceholder('user@example.com')
                    .setValue(this.plugin.settings.userEmail)
                    .onChange(async (value) => {
                        this.plugin.settings.userEmail = value.trim();
                        await this.plugin.saveSettings();
                    })
            );

        let passwordInput = '';
        new Setting(containerEl)
            .setName('Account password')
            .setDesc('Saved.')
            .addText((text) => {
                text.inputEl.type = 'password';
                text.setPlaceholder('••••••••');
                text.onChange((value) => {
                    passwordInput = value;
                });
            });

        let updatePasswordBtn: ButtonComponent;
        let testLoginBtn: ButtonComponent;

        const authSetting = new Setting(containerEl);
        const statusSpan = authSetting.controlEl.createSpan({ cls: 'pb_status_waiting' });
        statusSpan.style.marginRight = '12px';
        statusSpan.style.fontWeight = '500';
        statusSpan.setText('Checking authentication...');

        authSetting
            .addButton((btn) => {
                updatePasswordBtn = btn;
                btn
                    .setButtonText('Update password')
                    .setCta()
                    .onClick(async () => {
                        if (!passwordInput) {
                            new Notice('Please enter a password to update.');
                            return;
                        }
                        btn.setDisabled(true);
                        if (testLoginBtn) testLoginBtn.setDisabled(true);
                        btn.buttonEl.empty();
                        setIcon(btn.buttonEl, 'refresh-cw');
                        btn.buttonEl.addClass('pb_spin');
                        btn.buttonEl.createSpan({ text: ' Logging in...' });
                        try {
                            await this.authManager.login(passwordInput);
                            new Notice('Password updated and authenticated successfully! Token saved.');
                            statusSpan.className = 'pb_status_completed';
                            statusSpan.setText('Authenticated');
                            btn.buttonEl.removeClass('pb_spin');
                            btn.buttonEl.empty();
                            btn.setButtonText('Updated ✓');
                            await this.queueManager.process();
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            new Notice(`Failed to update password: ${msg}`);
                            statusSpan.className = 'pb_status_failed';
                            statusSpan.setText('Not authenticated');
                            btn.buttonEl.removeClass('pb_spin');
                            btn.buttonEl.empty();
                            btn.setButtonText('Update password');
                        } finally {
                            btn.setDisabled(false);
                            if (testLoginBtn) testLoginBtn.setDisabled(false);
                        }
                    });
            })
            .addButton((btn) => {
                testLoginBtn = btn;
                btn
                    .setButtonText('Test login')
                    .onClick(async () => {
                        if (!passwordInput) {
                            new Notice('Please enter your account password to test.');
                            return;
                        }
                        btn.setDisabled(true);
                        if (updatePasswordBtn) updatePasswordBtn.setDisabled(true);
                        btn.buttonEl.empty();
                        setIcon(btn.buttonEl, 'refresh-cw');
                        btn.buttonEl.addClass('pb_spin');
                        btn.buttonEl.createSpan({ text: ' Testing...' });
                        try {
                            await this.authManager.testLogin(passwordInput);
                            new Notice('Test login successful! Credentials are valid.');
                            btn.buttonEl.removeClass('pb_spin');
                            btn.buttonEl.empty();
                            btn.setButtonText('Test login ✓');
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            new Notice(`Test login failed: ${msg}`);
                            btn.buttonEl.removeClass('pb_spin');
                            btn.buttonEl.empty();
                            btn.setButtonText('Test login');
                        } finally {
                            btn.setDisabled(false);
                            if (updatePasswordBtn) updatePasswordBtn.setDisabled(false);
                        }
                    });
            });

        // Run background auth check on settings load
        // Display "authenticated" or "not authenticated"
        setTimeout(async () => {
            try {
                const isAuthenticated = await this.authManager.checkAuth();
                if (isAuthenticated) {
                    statusSpan.className = 'pb_status_completed';
                    statusSpan.setText('Authenticated');
                } else {
                    statusSpan.className = 'pb_status_failed';
                    statusSpan.setText('Not authenticated');
                }
            } catch {
                statusSpan.className = 'pb_status_failed';
                statusSpan.setText('Not authenticated');
            }
        }, 5_000);

        // Any point in displaying it? Remove it later?
        new Setting(containerEl)
            .setName('Vault ID')
            .setDesc('Unique identifier for this vault')
            .addText((text) =>
                text
                    .setValue(this.deviceManager.getVaultId())
                    .setDisabled(true)
            );
    }
}
