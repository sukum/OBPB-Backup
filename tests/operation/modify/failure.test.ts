import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { StartupRecoveryOperation } from '../../../src/operations/startup-recovery-op';
import { PocketBaseError } from '../../../src/remote/pocketbase-client';
import { createFile, createModifyHarness } from './helpers';

describe('Modify terminal failure and recovery flows', () => {
    test('a terminal save failure is recorded, acknowledged, and clears its dirty journal path', async () => {
        const file = createFile('Notes/InvalidSave.md');
        const harness = await createModifyHarness({
            execute: async () => { throw new PocketBaseError(400, 'Invalid save entry'); },
        });

        try {
            await harness.listeners.get('modify')!(file);
            await harness.debounceController.flushFile(file.path);

            assert.equal(harness.executions.length, 1);
            assert.equal(harness.failedTasks.length, 1);
            const failedIntent = harness.failedTasks[0].intent as any;
            assert.equal(harness.failedTasks[0].id, failedIntent.id);
            assert.equal(failedIntent.operation, 'save');
            assert.equal(failedIntent.event, 'modify');
            assert.equal(failedIntent.path, file.path);
            assert.equal(harness.queueStore.count(), 0);
            assert.equal(harness.dirtyFileManager.isDirty(file.path), false);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('startup recovery re-enqueues a dirty SAVE when its file still exists', async () => {
        const file = createFile('Notes/Recovered.md');
        const harness = await createModifyHarness({
            initialJournal: `SAVE\t${file.path}\n`,
            files: new Map([[file.path, file]]),
        });
        assert.deepEqual(harness.dirtyFileManager.getEntries(), [
            { operation: 'SAVE', path: file.path },
        ], "loaded SAVE entry omits oldPath");

        try {
            harness.queueManager.pause('startup-recovery');
            const recovery = new StartupRecoveryOperation({
                vault: harness.app.vault,
                dirtyFileManager: harness.dirtyFileManager,
                queue: harness.queueManager,
            });
            await recovery.execute();

            const recovered = harness.queueStore.peek()?.intent;
            assert.ok(recovered);
            assert.equal(recovered!.operation, 'save');
            assert.equal(recovered!.event, 'recovery');
            assert.equal(recovered!.path, file.path);
            assert.equal(recovered!.trigger, 'auto');
            assert.deepEqual(harness.dirtyFileManager.getEntries(), [
                { operation: 'SAVE', path: file.path },
            ], "recovery state omits oldPath for SAVE entries");

            harness.queueManager.resume('startup-recovery');
            await harness.queueManager.process();
            assert.equal(harness.queueStore.count(), 0);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('startup recovery converts a dirty SAVE with a missing file into a DELETE', async () => {
        const missingPath = 'Notes/RemovedWhileOffline.md';
        const harness = await createModifyHarness({ initialJournal: `SAVE\t${missingPath}\n` });
        assert.deepEqual(harness.dirtyFileManager.getEntries(), [
                { operation: 'SAVE', path: missingPath },
            ], "loaded SAVE entry omits oldPath");

        try {
            harness.queueManager.pause('startup-recovery');
            const recovery = new StartupRecoveryOperation({
                vault: harness.app.vault,
                dirtyFileManager: harness.dirtyFileManager,
                queue: harness.queueManager,
            });
            await recovery.execute();

            assert.deepEqual(harness.queueStore.getTasks().map(({ intent }) => ({
                operation: intent.operation,
                event: intent.event,
                path: intent.path,
            })), [{ operation: 'delete', event: 'recovery', path: missingPath }]);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), [
                { operation: 'DELETE', path: missingPath },
            ], "recovery state omits oldPath for DELETE entries");

            harness.queueManager.resume('startup-recovery');
            await harness.queueManager.process();
            assert.equal(harness.queueStore.count(), 0);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
        } finally {
            harness.queueManager.destroy();
        }
    });
});
