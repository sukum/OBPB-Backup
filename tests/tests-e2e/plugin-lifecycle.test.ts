import { test } from 'node:test';
import assert from 'node:assert/strict';
import './setup-dom';
import OBPBBackupPlugin from '../../src/main';

test('OBPBBackupPlugin.onload waits for layout readiness before vault events and commands', async (t) => {
    t.mock.method(console, 'log', () => {});
    const plugin = new OBPBBackupPlugin({} as any, {} as any);
    let layoutReadyCallback: (() => Promise<void>) | undefined;
    (plugin.app.workspace as any).onLayoutReady = (callback: () => Promise<void>) => {
        layoutReadyCallback = callback;
    };

    await plugin.onload();

    assert.equal(typeof layoutReadyCallback, 'function');
    assert.deepEqual((plugin as any).commands, [], 'commands are registered only after layout readiness');
    assert.ok((plugin as any).registeredViews['historical-backup-view']);
    assert.ok((plugin as any).registeredViews['historical-backup-activity-manager']);
    assert.equal((plugin as any).statusBarItems.length, 1);
    assert.equal((plugin as any).ribbonIcons.length, 1);

    plugin.container.resolve((await import('../../src/ui/status-bar')).StatusBarWidget).destroy();
    plugin.container.resolve((await import('../../src/queue/automatic-queue-manager')).AutomaticQueueManager).destroy();
});
