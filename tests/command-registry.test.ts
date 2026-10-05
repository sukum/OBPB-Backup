import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TFile, Notice } from 'obsidian';
import { Container } from '../src/container';
import { OperationsManager } from '../src/operations/operations-manager';
import { registerCommands } from '../src/ui/command-registry';

test('registerCommands adds active-file backup command', async () => {
    const plugin: any = {
        app: { workspace: { getActiveFile: () => null } },
        commands: [] as any[],
        addCommand(command: any) { this.commands.push(command); },
    };
    const container = new Container();
    const calls: Array<{ operation: string; file?: TFile }> = [];
    container.registerInstance(OperationsManager, {
        backupFileNow: async (file: TFile) => { calls.push({ operation: 'backup', file }); },
        flushAndProcessQueue: async () => { calls.push({ operation: 'flush' }); },
    } as any);

    (Notice as any).clear?.();
    registerCommands(plugin, container);

    const commandIds = plugin.commands.map((command: any) => command.id);
    assert.ok(commandIds.includes('save-active-now'));
    // assert.ok(commandIds.includes('flush-all'));

    const backupCommand = plugin.commands.find((c: any) => c.id === 'save-active-now');
    assert.ok(backupCommand, 'active backup command must be registered');
    plugin.app.workspace.getActiveFile = () => null;
    assert.equal(backupCommand.checkCallback(false), false);
    assert.equal(calls.length, 0);

    const activeFile = new TFile();
    activeFile.name = 'Active.md';
    plugin.app.workspace.getActiveFile = () => activeFile;
    assert.equal(backupCommand.checkCallback(true), true);
    assert.equal(calls.length, 0, 'checking the command must not start a backup');
    assert.equal(backupCommand.checkCallback(false), true);
    await Promise.resolve();
    assert.deepEqual(calls, [{ operation: 'backup', file: activeFile }]);
    assert.ok((Notice as any).messages?.includes('Backup enqueued for Active.md'));

    // const flushCommand = plugin.commands.find((c: any) => c.id === 'pb-backup-flush-all');
    // assert.ok(flushCommand, 'flush command must be registered');
    // await flushCommand.callback();
    // assert.deepEqual(calls.map((call) => call.operation), ['backup', 'flush']);
    // assert.ok((Notice as any).messages?.includes('Flushed all pending backups to queue.'));
});
