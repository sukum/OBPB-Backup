import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { PocketBaseError } from '../../../src/remote/pocketbase-client';
import { SAVE_EXECUTION_POLICIES, type AutoSaveIntent, type TaskIntent } from '../../../src/operations/types';
import { createFile, createFolder, createQueueHarness } from './helpers';

describe('Rename retry flows', () => {
    test('a retryable error waits 5, 30, and 60 seconds and blocks later FIFO work until the rename succeeds', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const oldPath = 'Notes/TransientOld.md';
        const newPath = 'Notes/TransientNew.md';
        const executions: TaskIntent[] = [];
        const harness = await createQueueHarness({
            execute: async (intent) => {
                executions.push(intent);
                if (intent.operation === 'rename' && executions.filter((item) => item.operation === 'rename').length <= 3) {
                    throw new PocketBaseError(429, 'Too Many Requests');
                }
                return { status: 'uploaded', intent };
            },
        });

        try {
            await harness.operationsManager.handleFileRename(createFile(newPath), oldPath);
            const later: AutoSaveIntent = {
                id: 'later-save',
                trigger: 'auto',
                event: 'modify',
                operation: 'save',
                path: 'Notes/Later.md',
                policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
            };
            await harness.queueManager.enqueue(later);

            assert.equal(executions.length, 1);
            assert.equal(harness.queueStore.peek()?.intent.operation, 'rename');
            assert.equal(harness.queueStore.peek()?.nextRetryAt, Date.now() + 5_000);
            assert.equal(harness.queueStore.count(), 2, 'later work remains behind the retrying rename');
            assert.equal(harness.dirtyFileManager.isDirty(newPath), true);

            mock.timers.tick(4_999);
            await Promise.resolve();
            assert.equal(executions.length, 1);
            mock.timers.tick(1);
            await harness.queueManager.process();
            assert.equal(executions.length, 2);
            assert.equal(harness.queueStore.peek()?.nextRetryAt, Date.now() + 30_000);

            mock.timers.tick(29_999);
            await Promise.resolve();
            assert.equal(executions.length, 2);
            mock.timers.tick(1);
            await harness.queueManager.process();
            assert.equal(executions.length, 3);
            assert.equal(harness.queueStore.peek()?.nextRetryAt, Date.now() + 60_000);

            mock.timers.tick(59_999);
            await Promise.resolve();
            assert.equal(executions.length, 3);
            mock.timers.tick(1);
            await harness.queueManager.process();

            assert.deepEqual(executions.map(({ operation, path }) => ({ operation, path })), [
                { operation: 'rename', path: newPath },
                { operation: 'rename', path: newPath },
                { operation: 'rename', path: newPath },
                { operation: 'rename', path: newPath },
                { operation: 'save', path: 'Notes/Later.md' },
            ]);
            assert.equal(harness.queueStore.count(), 0);
            assert.equal(harness.dirtyFileManager.isDirty(newPath), false);
        } finally {
            harness.queueManager.destroy();
            mock.timers.reset();
        }
    });

    test('a retryable rename that exhausts the retry budget is recorded as failed and clears the journal', async () => {
        const oldPath = 'Notes/ExhaustedOld.md';
        const newPath = 'Notes/ExhaustedNew.md';
        const executions: TaskIntent[] = [];
        const harness = await createQueueHarness({
            execute: async (intent) => {
                executions.push(intent);
                throw new PocketBaseError(429, 'Too Many Requests');
            },
        });

        try {
            await harness.operationsManager.handleFileRename(createFile(newPath), oldPath);
            for (let attempt = 0; attempt < 3; attempt++) {
                await harness.queueManager.retryNow();
            }

            assert.equal(executions.length, 4, 'the first attempt plus three retries are executed');
            assert.equal(harness.failedTasks.length, 1);
            assert.equal(harness.failedTasks[0].attempts, 4);
            assert.equal((harness.failedTasks[0].intent as any).operation, 'rename');
            assert.equal(harness.queueStore.count(), 0);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('offline detection pauses the rename, then a successful health check resumes the same FIFO head', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const oldPath = 'Notes/OfflineOld.md';
        const newPath = 'Notes/OfflineNew.md';
        let online = false;
        let healthChecks = 0;
        const executions: TaskIntent[] = [];
        const harness = await createQueueHarness({
            connectivityChecker: {
                healthCheck: async () => {
                    healthChecks++;
                    if (!online) throw new Error('Still offline');
                },
            },
            execute: async (intent) => {
                executions.push(intent);
                if (executions.length === 1) throw new Error('Network unavailable');
                return { status: 'uploaded', intent };
            },
        });

        try {
            await harness.operationsManager.handleFileRename(createFile(newPath), oldPath);

            assert.equal(executions.length, 1);
            assert.equal(harness.queueManager.isPaused(), true);
            assert.equal(harness.processor.getPauseReasons().has('offline'), true);
            assert.equal(harness.queueStore.peek()?.intent.operation, 'rename');
            assert.equal(harness.dirtyFileManager.isDirty(newPath), true);
            assert.equal(healthChecks, 1, 'connectivity is checked after the failed upload');

            online = true;
            mock.timers.tick(5_000);
            for (let i = 0; i < 10 && harness.queueManager.isPaused(); i++) {
                await Promise.resolve();
            }
            await harness.queueManager.process();

            assert.equal(healthChecks, 2, 'the monitor detects restored connectivity');
            assert.equal(executions.length, 2);
            assert.equal(executions[0].id, executions[1].id);
            assert.equal(harness.queueManager.isPaused(), false);
            assert.equal(harness.queueStore.count(), 0);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
        } finally {
            harness.queueManager.destroy();
            mock.timers.reset();
        }
    });

    test('folder children remain in FIFO order when the first child is retrying', async () => {
        const first = createFile('NewFolder/First.md');
        const second = createFile('NewFolder/Second.md');
        const folder = createFolder('NewFolder', [first, second]);
        const executions: TaskIntent[] = [];
        const harness = await createQueueHarness({
            execute: async (intent) => {
                executions.push(intent);
                if (intent.path === first.path && executions.filter((item) => item.path === first.path).length === 1) {
                    throw new PocketBaseError(429, 'Too Many Requests');
                }
                return { status: 'uploaded', intent };
            },
        });

        try {
            await harness.listeners.get('rename')!(folder, 'OldFolder');

            assert.deepEqual(harness.queueStore.getTasks().map(({ intent }) => intent.path), [
                first.path,
                second.path,
            ]);
            assert.deepEqual(executions.map(({ path }) => path), [first.path]);
            assert.equal(harness.dirtyFileManager.isDirty(first.path), true);
            assert.equal(harness.dirtyFileManager.isDirty(second.path), true);

            await harness.queueManager.retryNow();

            assert.deepEqual(executions.map(({ path }) => path), [first.path, first.path, second.path]);
            assert.equal(harness.queueStore.count(), 0);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
        } finally {
            harness.queueManager.destroy();
        }
    });
});
