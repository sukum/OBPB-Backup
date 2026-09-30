import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PocketBaseError } from '../../../src/remote/pocketbase-client';
import { createFile, createQueueHarness, createUploadHarness } from './helpers';

describe('Rename failure and pause flows', () => {
    test('renaming a monitored file to an unmonitored destination enqueues a delete for the old path', async () => {
        const oldPath = 'Notes/Report.md';
        const newPath = 'Notes/Report.pdf';
        const file = createFile(newPath);
        const harness = await createQueueHarness();

        try {
            harness.queueManager.pause('test');
            await harness.operationsManager.handleFileRename(file, oldPath);

            assert.deepEqual(harness.cancelledPaths, [oldPath]);
            assert.deepEqual(harness.queueStore.getTasks().map(({ intent }) => ({
                event: intent.event,
                operation: intent.operation,
                path: intent.path,
            })), [{ event: 'delete', operation: 'delete', path: oldPath }]);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), [
                { operation: 'DELETE', path: oldPath },
            ]);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('a destination that becomes unmonitored before preparation is skipped and leaves the source history unchanged', async () => {
        const oldPath = 'Notes/Tracked.md';
        const newPath = 'Notes/TrackedToo.md';
        const file = createFile(newPath);
        const monitoredExtensions = ['md'];
        const pipeline = await createUploadHarness({
            files: new Map([[newPath, file]]),
            monitoredExtensions,
            history: [{
                id: 'source-save',
                vault: 'vault-test',
                path: oldPath,
                oldPath: null,
                objectId: 'object-sha256:source',
                hash: 'sha256:source',
                operation: 'save',
                device: 'device-test',
                timestamp: 1000,
            }],
        });

        try {
            pipeline.queueManager.pause('settings-change');
            await pipeline.operationsManager.handleFileRename(file, oldPath);
            monitoredExtensions.splice(0, 1, 'txt');
            pipeline.queueManager.resume('settings-change');
            await pipeline.queueManager.process();

            assert.equal(pipeline.queueStore.count(), 0);
            assert.deepEqual(pipeline.entries.map(({ operation, path }) => ({ operation, path })), [
                { operation: 'save', path: oldPath },
            ]);
            assert.deepEqual(pipeline.dirtyFileManager.getEntries(), []);
        } finally {
            pipeline.queueManager.destroy();
        }
    });

    test('a terminal rename upload error records the failed intent, acknowledges it, and clears both paths', async () => {
        const oldPath = 'Notes/InvalidSource.md';
        const newPath = 'Notes/InvalidTarget.md';
        const harness = await createQueueHarness({
            execute: async () => { throw new PocketBaseError(400, 'Invalid rename entry'); },
        });

        try {
            await harness.operationsManager.handleFileRename(createFile(newPath), oldPath);

            assert.equal(harness.failedTasks.length, 1);
            const failedIntent = harness.failedTasks[0].intent as any;
            assert.ok(failedIntent);
            assert.equal(harness.failedTasks[0].id, failedIntent.id);
            assert.equal(failedIntent.operation, 'rename');
            assert.equal(failedIntent.path, newPath);
            assert.equal(failedIntent.oldPath, oldPath);
            assert.equal(harness.queueStore.count(), 0);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
        } finally {
            harness.queueManager.destroy();
        }
    });

    for (const status of [401, 403]) {
        test(`${status} pauses a rename for authentication and retryUploadQueue resumes it`, async () => {
            const oldPath = `Notes/Auth${status}Old.md`;
            const newPath = `Notes/Auth${status}New.md`;
            let executions = 0;
            const harness = await createQueueHarness({
                execute: async (intent) => {
                    executions++;
                    if (executions === 1) throw new PocketBaseError(status, 'Authentication required');
                    return { status: 'uploaded', intent };
                },
            });

            try {
                await harness.operationsManager.handleFileRename(createFile(newPath), oldPath);

                assert.equal(executions, 1);
                assert.equal(harness.queueManager.isPaused(), true);
                assert.equal(harness.processor.getPauseReasons().has('auth-required'), true);
                assert.equal(harness.queueStore.peek()?.intent.operation, 'rename');
                assert.equal(harness.queueStore.peek()?.attempts, 1);
                assert.equal(harness.dirtyFileManager.isDirty(newPath), true);

                await harness.queueManager.retryNow();

                assert.equal(executions, 2);
                assert.equal(harness.queueManager.isPaused(), false);
                assert.equal(harness.queueStore.count(), 0);
                assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
            } finally {
                harness.queueManager.destroy();
            }
        });
    }

    test('a user-paused queue retains the rename and its journal entry until resumed', async () => {
        const oldPath = 'Notes/PausedOld.md';
        const newPath = 'Notes/PausedNew.md';
        let executions = 0;
        const harness = await createQueueHarness({ execute: async () => { executions++; return {}; } });

        try {
            harness.queueManager.pause('user');
            await harness.operationsManager.handleFileRename(createFile(newPath), oldPath);

            assert.equal(executions, 0);
            assert.equal(harness.queueStore.peek()?.intent.operation, 'rename');
            assert.equal(harness.dirtyFileManager.isDirty(newPath), true);

            harness.queueManager.resume('user');
            await harness.queueManager.process();

            assert.equal(executions, 1);
            assert.equal(harness.queueStore.count(), 0);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
        } finally {
            harness.queueManager.destroy();
        }
    });
});
