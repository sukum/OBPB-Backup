import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './setup-dom';
import { OBPBBackupSettingTab } from '../../src/ui/settings-tab';
import { ServerAccountSection } from '../../src/ui/settings/server-account-section';
import { DebounceTimingSection } from '../../src/ui/settings/debounce-timing-section';
import { FileFiltersSection } from '../../src/ui/settings/file-filters-section';
import { ActivityManagerSection } from '../../src/ui/settings/activity-manager-section';
import { VaultOperationsSection } from '../../src/ui/settings/vault-operations-section';
import { StorageMetricsSection } from '../../src/ui/settings/storage-metrics-section';
import { createTestContext } from './mocks/test-context';
import { Notice } from 'obsidian';
import type { VaultOperationProgressCallback, BatchResult } from '../../src/operations/types';
import { DEFAULT_ACTIVITY_HISTORY_LIMIT } from '../../src/state/constants';

test('OBPBBackupSettingTab instantiates and displays all 6 sections', () => {
    const { plugin } = createTestContext();
    mock.timers.enable({ apis: ['setTimeout'] });
    const tab = new OBPBBackupSettingTab(plugin.app, plugin);

    assert.equal(tab.containerEl.children.length, 0);
    tab.display();
    mock.timers.reset();

    assert.ok(tab.containerEl.querySelector('h2')?.textContent?.includes('OBPB Backup Settings'));
    const sectionHeadings = Array.from(tab.containerEl.querySelectorAll('h3')).map((h: Element) => h.textContent);
    assert.ok(sectionHeadings.includes('Server & Account'));
    assert.ok(sectionHeadings.includes('Debounce & Backup Timing'));
    assert.ok(sectionHeadings.includes('Thresholds & File Filters'));
    assert.ok(sectionHeadings.includes('Activity History & Realtime Manager'));
    assert.ok(sectionHeadings.includes('Vault Operations'));
    assert.ok(sectionHeadings.includes('Remote Storage Metrics'));
});

test('ServerAccountSection server URL, auth tests, login, and vault ID', async () => {
    const { plugin, mocks } = createTestContext({
        serverUrl: 'https://initial.pocketbase.io',
        userEmail: 'initial@test.com',
    });

    mock.timers.enable({ apis: ['setTimeout'] });
    const section = new ServerAccountSection(plugin);
    const containerEl = document.createElement('div');
    section.render({ containerEl, refreshTab: () => {} });
    mock.timers.reset();

    // 1. Check Server URL and Email inputs
    const inputs = Array.from(containerEl.querySelectorAll('input[type="text"], input[type="password"]')) as HTMLInputElement[];
    const urlInput = inputs.find(i => i.value === 'https://initial.pocketbase.io');
    assert.ok(urlInput);

    urlInput.value = 'https://updated.pocketbase.io';
    urlInput.dispatchEvent(new Event('input'));
    assert.equal(plugin.settings.serverUrl, 'https://updated.pocketbase.io');

    const emailInput = inputs.find(i => i.value === 'initial@test.com');
    assert.ok(emailInput);
    emailInput.value = 'updated@test.com';
    emailInput.dispatchEvent(new Event('input'));
    assert.equal(plugin.settings.userEmail, 'updated@test.com');

    // 2. Test Connection button (success & error)
    let healthChecked = false;
    mocks.healthChecker.healthCheck = async () => { healthChecked = true; };
    const testConnBtn = Array.from(containerEl.querySelectorAll('button')).find(b => b.textContent?.includes('Test connection'));
    assert.ok(testConnBtn);
    await testConnBtn.click();
    assert.equal(healthChecked, true);
    assert.ok(testConnBtn.textContent?.includes('Connection ✓'));

    // Test Connection failure
    mocks.healthChecker.healthCheck = async () => { throw new Error('Offline'); };
    await testConnBtn.click();
    assert.ok((Notice as any).notices.some((n: any) => n.message.includes('Connection failed: Offline')));

    // 3. Password and Authentication actions
    const passInput = inputs.find(i => i.type === 'password');
    assert.ok(passInput);

    // Update password with empty string should warn
    const updatePassBtn = Array.from(containerEl.querySelectorAll('button')).find(b => b.textContent?.includes('Update password'));
    assert.ok(updatePassBtn);
    (Notice as any).clear();
    await updatePassBtn.click();
    assert.ok((Notice as any).notices.some((n: any) => n.message.includes('Please enter a password to update.')));

    // Update password success
    let loggedInWith = '';
    let queueProcessed = false;
    mocks.authManager.login = async (p: string) => { loggedInWith = p; };
    mocks.queueManager.process = async () => { queueProcessed = true; };

    passInput.value = 'secret-token-123';
    passInput.dispatchEvent(new Event('input'));
    updatePassBtn.click();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(loggedInWith, 'secret-token-123');
    assert.equal(queueProcessed, true);
    assert.ok(updatePassBtn.textContent?.includes('Updated ✓'));

    // Test Login button
    let testLoginWith = '';
    mocks.authManager.testLogin = async (p: string) => { testLoginWith = p; };
    const testLoginBtn = Array.from(containerEl.querySelectorAll('button')).find(b => b.textContent?.includes('Test Login'));
    assert.ok(testLoginBtn);
    testLoginBtn.click();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(testLoginWith, 'secret-token-123');

    // 4. Vault ID is disabled
    const vaultIdInput = inputs.find(i => i.value === 'test-vault-id');
    assert.ok(vaultIdInput);
    assert.equal(vaultIdInput.disabled, true);
    mock.timers.reset();
});

test('DebounceTimingSection sliders and reset buttons', async () => {
    const { plugin, mocks } = createTestContext({
        debounceIntervalMs: 45000,
        maxWaitMs: 180000,
    });

    let updatedInterval = 0;
    let updatedMaxWait = 0;
    mocks.debounceController.updateSettings = (i: number, m: number) => {
        updatedInterval = i;
        updatedMaxWait = m;
    };

    const section = new DebounceTimingSection(plugin);
    const containerEl = document.createElement('div');
    let refreshed = 0;
    section.render({ containerEl, refreshTab: () => { refreshed++; } });

    // Slider inputs
    const sliders = Array.from(containerEl.querySelectorAll('input[type="range"]')) as HTMLInputElement[];
    assert.equal(sliders.length, 2);

    // Change debounce slider (seconds * 1000)
    sliders[0].value = '60';
    sliders[0].dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(plugin.settings.debounceIntervalMs, 60000);
    assert.equal(updatedInterval, 60000);

    // Change max wait slider (minutes * 60000)
    sliders[1].value = '10';
    sliders[1].dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(plugin.settings.maxWaitMs, 600000);
    assert.equal(updatedMaxWait, 600000);

    // Click reset buttons
    const resetButtons = Array.from(containerEl.querySelectorAll('.clickable-icon')) as HTMLElement[];
    assert.equal(resetButtons.length, 2);

    // Reset debounce
    await resetButtons[0].click();
    assert.equal(plugin.settings.debounceIntervalMs, 30000);
    assert.equal(refreshed, 1);

    // Reset max wait
    await resetButtons[1].click();
    assert.equal(plugin.settings.maxWaitMs, 300000);
    assert.equal(refreshed, 2);
});

test('FileFiltersSection extension parsing and safety backup toggle', async () => {
    const { plugin } = createTestContext({
        monitoredExtensions: ['md', 'canvas'],
        safetyBackupBeforeRestore: true,
    });

    const section = new FileFiltersSection(plugin);
    const containerEl = document.createElement('div');
    section.render({ containerEl, refreshTab: () => {} });

    // Text input for extensions
    const extInput = containerEl.querySelector('input[type="text"]') as HTMLInputElement;
    assert.ok(extInput);
    assert.equal(extInput.value, 'md, canvas');

    extInput.value = '.md,   canvas, .txt, json ';
    extInput.dispatchEvent(new Event('input'));
    assert.deepEqual(plugin.settings.monitoredExtensions, ['md', 'canvas', 'txt', 'json']);

    // Toggle for safety backup
    const toggle = containerEl.querySelector('input[type="checkbox"]') as HTMLInputElement;
    assert.ok(toggle);
    assert.equal(toggle.checked, true);

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    assert.equal(plugin.settings.safetyBackupBeforeRestore, false);
});

test('ActivityManagerSection history limit, open view, and pause queue toggle', async () => {
    const { plugin, mocks } = createTestContext({
        activityHistoryLimit: 50,
    });

    const section = new ActivityManagerSection(plugin);
    const containerEl = document.createElement('div');
    let refreshed = false;
    section.render({ containerEl, refreshTab: () => { refreshed = true; } });

    // History limit slider
    const slider = containerEl.querySelector('input[type="range"]') as HTMLInputElement;
    assert.ok(slider);
    slider.value = '200';
    slider.dispatchEvent(new Event('change'));
    assert.equal(plugin.settings.activityHistoryLimit, 200);

    // Reset button
    const resetBtn = containerEl.querySelector('.clickable-icon') as HTMLElement;
    assert.ok(resetBtn);
    await resetBtn.click();
    assert.equal(plugin.settings.activityHistoryLimit, DEFAULT_ACTIVITY_HISTORY_LIMIT);
    assert.equal(refreshed, true);

    // Open Activity Manager button
    const openBtn = Array.from(containerEl.querySelectorAll('button')).find(b => b.textContent?.includes('Open Activity Manager Tab'));
    assert.ok(openBtn);
    openBtn.click();
    // Verify leaf creation in workspace
    assert.equal((plugin.app.workspace as any).leaves.length, 1);

    // Pause / Resume uploads toggle button
    const pauseBtn = Array.from(containerEl.querySelectorAll('button')).find(b => b.textContent?.includes('Pause Uploads'));
    assert.ok(pauseBtn);
    assert.equal(mocks.operationsManager.isQueuePaused(), false);

    pauseBtn.click();
    assert.equal(mocks.operationsManager.isQueuePaused(), true);
    assert.ok(pauseBtn.textContent?.includes('Resume Uploads'));

    pauseBtn.click();
    assert.equal(mocks.operationsManager.isQueuePaused(), false);
    assert.ok(pauseBtn.textContent?.includes('Pause Uploads'));
});

test('VaultOperationsSection batch size, backup snapshot, sync, and stop', async () => {
    const { plugin, mocks } = createTestContext({
        batchConcurrency: 15,
    });

    const section = new VaultOperationsSection(plugin);
    const containerEl = document.createElement('div');
    section.render({ containerEl, refreshTab: () => {} });

    // Batch size slider
    const slider = containerEl.querySelector('input[type="range"]') as HTMLInputElement;
    assert.ok(slider);
    assert.equal(slider.value, '15');
    slider.value = '25';
    slider.dispatchEvent(new Event('change'));
    assert.equal(plugin.settings.batchConcurrency, 25);

    // Reset button
    const resetBtn = containerEl.querySelector('.clickable-icon') as HTMLElement;
    assert.ok(resetBtn);
    await resetBtn.click();
    assert.equal(plugin.settings.batchConcurrency, 10);

    // Backup (Snapshot) button execution
    const backupBtn = Array.from(containerEl.querySelectorAll('button')).find(b => b.textContent?.includes('Backup (Snapshot)'));
    assert.ok(backupBtn);
    (Notice as any).clear();
    await backupBtn.click();
    assert.ok((Notice as any).notices.some((n: any) => n.message.includes('Vault backup complete: 5 files snapshotted')));

    // Sync (Reconcile) button execution
    const syncBtn = Array.from(containerEl.querySelectorAll('button')).find(b => b.textContent?.includes('Sync (Reconcile)'));
    assert.ok(syncBtn);
    (Notice as any).clear();
    await syncBtn.click();
    assert.ok((Notice as any).notices.some((n: any) => n.message.includes('Vault sync complete: 3 uploaded, 5 unchanged, 2 deleted.')));

    // Stop button
    let stopCalled = false;
    mocks.operationsManager.stopVaultOperation = async () => { stopCalled = true; };
    const stopBtn = Array.from(containerEl.querySelectorAll('button')).find(b => b.textContent === 'Stop');
    assert.ok(stopBtn);
    stopBtn.disabled = false;
    stopBtn.click();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(stopCalled, true);
});

test('StorageMetricsSection empty stats, populated dashboard with savings calculation, and error', async () => {
    const { plugin, mocks } = createTestContext();

    const section = new StorageMetricsSection(plugin);

    // 1. Empty stats
    mocks.pocketBaseStore.getVaultStats = async () => null;
    const container1 = document.createElement('div');
    section.render({ containerEl: container1, refreshTab: () => {} });
    await new Promise(r => setTimeout(r, 10));
    await container1.querySelector('button')?.click();
    await new Promise(r => setTimeout(r, 10));
    assert.ok(container1.querySelector('.obpb_empty')?.textContent?.includes('No backups recorded yet'));

    // 2. Populated stats
    mocks.pocketBaseStore.getVaultStats = async () => ({
        id: 'test-vault-id',
        vault: 'test-vault-id',
        total_objects: 50,
        snapshot_count: 10,
        diff_count: 40,
        total_bytes: 1_000_000,
        snapshot_bytes: 500_000,
        diff_bytes: 500_000,
        total_entries: 60,
    });

    const container2 = document.createElement('div');
    section.render({ containerEl: container2, refreshTab: () => {} });
    await new Promise(r => setTimeout(r, 10));
    await container2.querySelector('button')?.click();
    await new Promise(r => setTimeout(r, 10));

    const cards = container2.querySelectorAll('.obpb_metric_card');
    assert.equal(cards.length, 4);

    const values = Array.from(cards).map(c => c.querySelector('.obpb_metric_value')?.textContent);
    assert.ok(values[0]?.includes('KB') || values[0]?.includes('MB')); // Total Remote Storage
    assert.equal(values[1], '50'); // Stored Versions
    assert.equal(values[2], '10 / 40'); // Snapshots / Diffs
    assert.ok(values[3]?.includes('% saved')); // Diff Savings

    // 3. Error state
    mocks.pocketBaseStore.getVaultStats = async () => {
        throw new Error('Database unavailable');
    };
    const container3 = document.createElement('div');
    section.render({ containerEl: container3, refreshTab: () => {} });
    await new Promise(r => setTimeout(r, 10));
    await container3.querySelector('button')?.click();
    await new Promise(r => setTimeout(r, 10));
    assert.ok(container3.querySelector('.obpb_error')?.textContent?.includes('Database unavailable'));
});

test('VaultOperationsSection debounces progress updates by 500ms and cancels pending timer on completion', async () => {
    const { plugin, mocks } = createTestContext();

    let capturedProgress: VaultOperationProgressCallback | undefined;
    let finishBackup: (res: BatchResult) => void = () => {};
    mocks.operationsManager.backupVault = async (progress) => {
        capturedProgress = progress;
        return new Promise<BatchResult>((resolve) => {
            finishBackup = resolve;
        });
    };

    const section = new VaultOperationsSection(plugin);
    const containerEl = document.createElement('div');
    section.render({ containerEl, refreshTab: () => {} });

    const statusEl = containerEl.querySelector('.obpb_vault_op_status') as HTMLElement;
    assert.ok(statusEl);

    const backupBtn = Array.from(containerEl.querySelectorAll('button')).find(b => b.textContent?.includes('Backup (Snapshot)'));
    assert.ok(backupBtn);

    const clickPromise = backupBtn.click();
    assert.equal(statusEl.style.display, 'block');
    assert.equal(statusEl.textContent, 'Starting vault snapshot backup...');
    assert.ok(capturedProgress);

    // Rapid progress calls within 500ms window
    capturedProgress(1, 10, 'file1.md', 'Creating snapshot...');
    capturedProgress(2, 10, 'file2.md', 'Creating snapshot...');
    capturedProgress(3, 10, 'file3.md', 'Creating snapshot...');

    // Before 500ms, debounced status should not have updated yet
    assert.equal(statusEl.textContent, 'Starting vault snapshot backup...');

    // Wait 550ms for debounce timer to fire
    await new Promise((r) => setTimeout(r, 550));
    assert.equal(statusEl.textContent, 'Backup (3/10) [Creating snapshot...] file3.md');

    // More rapid progress calls
    capturedProgress(4, 10, 'file4.md', 'Creating snapshot...');
    capturedProgress(5, 10, 'file5.md', 'Creating snapshot...');

    // Complete backup immediately (before the next 500ms debounce fires)
    finishBackup({
        uploaded: 5,
        unchanged: 5,
        skipped: 0,
        deleted: 0,
        totalFiles: 10,
        processed: 10,
        stopped: false,
    });
    await new Promise((r) => setTimeout(r, 10));

    // Immediately shows completion
    assert.equal(statusEl.textContent, '✓ Backup complete: 5 files snapshotted.');

    // Wait past 500ms to ensure the pending debounce was cancelled and did NOT overwrite completion text
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(statusEl.textContent, '✓ Backup complete: 5 files snapshotted.');
});

test('VaultOperationsSection debounces sync progress updates and cancels on completion', async () => {
    const { plugin, mocks } = createTestContext();

    let capturedProgress: VaultOperationProgressCallback | undefined;
    let finishSync: (res: BatchResult) => void = () => {};
    mocks.operationsManager.syncVault = async (progress) => {
        capturedProgress = progress;
        return new Promise<BatchResult>((resolve) => {
            finishSync = resolve;
        });
    };

    const section = new VaultOperationsSection(plugin);
    const containerEl = document.createElement('div');
    section.render({ containerEl, refreshTab: () => {} });

    const statusEl = containerEl.querySelector('.obpb_vault_op_status') as HTMLElement;
    assert.ok(statusEl);

    const syncBtn = Array.from(containerEl.querySelectorAll('button')).find(b => b.textContent?.includes('Sync (Reconcile)'));
    assert.ok(syncBtn);

    const clickPromise = syncBtn.click();
    assert.equal(statusEl.style.display, 'block');
    assert.equal(statusEl.textContent, 'Starting vault sync...');
    assert.ok(capturedProgress);

    capturedProgress(1, 20, 'note1.md', 'Checking diff...');
    capturedProgress(2, 20, 'note2.md', 'Checking diff...');

    assert.equal(statusEl.textContent, 'Starting vault sync...');

    await new Promise((r) => setTimeout(r, 550));
    assert.equal(statusEl.textContent, 'Sync (2/20) [Checking diff...] note2.md');

    capturedProgress(3, 20, 'note3.md', 'Checking diff...');

    finishSync({
        uploaded: 2,
        unchanged: 18,
        skipped: 0,
        deleted: 0,
        totalFiles: 20,
        processed: 20,
        stopped: false,
    });
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(statusEl.textContent, '✓ Sync complete: 2 uploaded, 18 unchanged.');

    await new Promise((r) => setTimeout(r, 600));
    assert.equal(statusEl.textContent, '✓ Sync complete: 2 uploaded, 18 unchanged.');
});

test('VaultOperationsSection cancels debounced progress when stop is requested', async () => {
    const { plugin, mocks } = createTestContext();

    let capturedProgress: VaultOperationProgressCallback | undefined;
    let finishBackup: (res: BatchResult) => void = () => {};
    mocks.operationsManager.backupVault = async (progress) => {
        capturedProgress = progress;
        return new Promise<BatchResult>((resolve) => {
            finishBackup = resolve;
        });
    };

    const section = new VaultOperationsSection(plugin);
    const containerEl = document.createElement('div');
    section.render({ containerEl, refreshTab: () => {} });

    const statusEl = containerEl.querySelector('.obpb_vault_op_status') as HTMLElement;
    const backupBtn = Array.from(containerEl.querySelectorAll('button')).find(b => b.textContent?.includes('Backup (Snapshot)'));
    const stopBtn = Array.from(containerEl.querySelectorAll('button')).find(b => b.textContent === 'Stop');
    assert.ok(backupBtn);
    assert.ok(stopBtn);

    const clickPromise = backupBtn.click();
    assert.ok(capturedProgress);

    capturedProgress(1, 10, 'file1.md', 'Creating snapshot...');

    // Click stop button before 500ms
    await stopBtn.click();
    assert.equal(statusEl.textContent, 'Stopping vault operation... completing active batch...');

    // Even after 550ms, progress debounce was cancelled and should not overwrite "Stopping vault operation..."
    await new Promise((r) => setTimeout(r, 550));
    assert.equal(statusEl.textContent, 'Stopping vault operation... completing active batch...');

    finishBackup({
        uploaded: 1,
        unchanged: 0,
        skipped: 0,
        deleted: 0,
        totalFiles: 10,
        processed: 1,
        stopped: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(statusEl.textContent?.includes('Backup stopped by user'));
});
