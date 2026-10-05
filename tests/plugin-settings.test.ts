import { test } from 'node:test';
import assert from 'node:assert/strict';
import PBBackupPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/types/settings';

test('loadSettings uses defaults when no settings are stored and merges partial settings', async () => {
    const plugin = new PBBackupPlugin({} as any, {} as any);
    plugin.loadData = async () => undefined;
    await plugin.loadSettings();
    assert.deepEqual(plugin.settings, DEFAULT_SETTINGS);

    plugin.loadData = async () => ({ serverUrl: 'https://pb.example.test', batchConcurrency: 12 });
    await plugin.loadSettings();
    assert.deepEqual(plugin.settings, {
        ...DEFAULT_SETTINGS,
        serverUrl: 'https://pb.example.test',
        batchConcurrency: 12,
    });
});

test.skip('loadSettings migrates legacy activity settings only when replacement fields are absent', async () => {
    const plugin = new PBBackupPlugin({} as any, {} as any);
    plugin.loadData = async () => ({ processHistoryLimit: 17, processManagerRefreshSec: 8 });
    await plugin.loadSettings();
    assert.equal(plugin.settings.activityHistoryLimit, 17);
    assert.equal(plugin.settings.activityManagerRefreshSec, 8);

    plugin.loadData = async () => ({
        processHistoryLimit: 17,
        processManagerRefreshSec: 8,
        activityHistoryLimit: 25,
        activityManagerRefreshSec: 4,
    });
    await plugin.loadSettings();
    assert.equal(plugin.settings.activityHistoryLimit, 25);
    assert.equal(plugin.settings.activityManagerRefreshSec, 4);
});

test('saveSettings persists the current settings object', async () => {
    const plugin = new PBBackupPlugin({} as any, {} as any);
    let saved: unknown;
    plugin.settings = { ...DEFAULT_SETTINGS, serverUrl: 'https://pb.example.test' };
    plugin.saveData = async (value: unknown) => { saved = value; };

    await plugin.saveSettings();

    assert.strictEqual(saved, plugin.settings);
});
