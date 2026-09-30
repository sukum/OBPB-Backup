import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { PocketBaseError } from '../../../src/remote/pocketbase-client';
import { SAVE_EXECUTION_POLICIES, type AutoSaveIntent, type TaskIntent } from '../../../src/operations/types';
import { createFile, createModifyHarness } from './helpers';

async function settlePromises(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('Modify retry and pause flows', () => {
    test('a retryable save waits 5, 30, and 120 seconds and blocks later FIFO work until it succeeds', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const file = createFile('Notes/Retrying.md');
        const executions: TaskIntent[] = [];
        const harness = await createModifyHarness({
            execute: async (intent) => {
                executions.push(intent);
                if (intent.path === file.path && executions.filter((item) => item.path === file.path).length <= 3) {
                    throw new PocketBaseError(429, 'Too Many Requests');
                }
                return { status: 'uploaded', intent };
            },
        });

        try {
            await harness.listeners.get('modify')!(file);
            await harness.debounceController.flushFile(file.path);
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
            assert.equal(harness.queueStore.peek()?.intent.path, file.path);
            assert.equal(harness.queueStore.peek()?.nextRetryAt, Date.now() + 5_000);
            assert.equal(harness.queueStore.count(), 2);
            assert.equal(harness.dirtyFileManager.isDirty(file.path), true);

            mock.timers.tick(4_999);
            await settlePromises();
            assert.equal(executions.length, 1);
            mock.timers.tick(1);
            await harness.queueManager.process();
            assert.equal(executions.length, 2);
            assert.equal(harness.queueStore.peek()?.nextRetryAt, Date.now() + 30_000);

            mock.timers.tick(29_999);
            await settlePromises();
            assert.equal(executions.length, 2);
            mock.timers.tick(1);
            await harness.queueManager.process();
            assert.equal(executions.length, 3);
            assert.equal(harness.queueStore.peek()?.nextRetryAt, Date.now() + 60_000);

            mock.timers.tick(59_999);
            await settlePromises();
            assert.equal(executions.length, 3);
            mock.timers.tick(1);
            await harness.queueManager.process();

            assert.deepEqual(executions.map(({ operation, path }) => ({ operation, path })), [
                { operation: 'save', path: file.path },
                { operation: 'save', path: file.path },
                { operation: 'save', path: file.path },
                { operation: 'save', path: file.path },
                { operation: 'save', path: later.path },
            ]);
            assert.equal(harness.queueStore.count(), 0);
            assert.equal(harness.dirtyFileManager.isDirty(file.path), false);
        } finally {
            harness.queueManager.destroy();
            mock.timers.reset();
        }
    });

    test('a retryable save that exhausts its retry budget is recorded as failed and clears its journal path', async () => {
        const file = createFile('Notes/Exhausted.md');
        const harness = await createModifyHarness({
            execute: async () => { throw new PocketBaseError(429, 'Too Many Requests'); },
        });

        try {
            await harness.listeners.get('modify')!(file);
            await harness.debounceController.flushFile(file.path);
            for (let attempt = 0; attempt < 3; attempt++) {
                await harness.queueManager.retryNow();
            }

            assert.equal(harness.executions.length, 4, 'the first attempt plus three retries are executed');
            assert.equal(harness.failedTasks.length, 1);
            assert.equal(harness.failedTasks[0].attempts, 4);
            assert.equal((harness.failedTasks[0].intent as any).operation, 'save');
            assert.equal((harness.failedTasks[0].intent as any).path, file.path);
            assert.equal(harness.queueStore.count(), 0);
            assert.equal(harness.dirtyFileManager.isDirty(file.path), false);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('offline detection pauses a modify save, then health recovery resumes the same FIFO head', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const file = createFile('Notes/Offline.md');
        let online = false;
        let healthChecks = 0;
        let harness!: Awaited<ReturnType<typeof createModifyHarness>>;
        harness = await createModifyHarness({
            connectivityChecker: {
                healthCheck: async () => {
                    healthChecks++;
                    if (!online) throw new Error('Still offline');
                },
            },
            execute: async (intent) => {
                if (harness.executions.length === 1) throw new Error('Network unavailable');
                return { status: 'uploaded', intent };
            },
        });

        try {
            await harness.listeners.get('modify')!(file);
            await harness.debounceController.flushFile(file.path);

            assert.equal(harness.executions.length, 1);
            assert.equal(harness.queueManager.isPaused(), true);
            assert.equal(harness.processor.getPauseReasons().has('offline'), true);
            assert.equal(harness.queueStore.peek()?.intent.operation, 'save');
            assert.equal(harness.dirtyFileManager.isDirty(file.path), true);
            assert.equal(healthChecks, 1, 'connectivity is checked after the failed upload');

            online = true;
            mock.timers.tick(5_000);
            await settlePromises();
            await harness.queueManager.process();

            assert.equal(healthChecks, 2);
            assert.equal(harness.executions.length, 2);
            assert.equal(harness.executions[0].id, harness.executions[1].id);
            assert.equal(harness.queueManager.isPaused(), false);
            assert.equal(harness.queueStore.count(), 0);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
        } finally {
            harness.queueManager.destroy();
            mock.timers.reset();
        }
    });

    for (const status of [401, 403]) {
        test(`${status} pauses a modify save for authentication and retryNow resumes it`, async () => {
            const file = createFile(`Notes/Auth${status}.md`);
            let attempts = 0;
            const harness = await createModifyHarness({
                execute: async (intent) => {
                    attempts++;
                    if (attempts === 1) throw new PocketBaseError(status, 'Authentication required');
                    return { status: 'uploaded', intent };
                },
            });

            try {
                await harness.listeners.get('modify')!(file);
                await harness.debounceController.flushFile(file.path);

                assert.equal(attempts, 1);
                assert.equal(harness.queueManager.isPaused(), true);
                assert.equal(harness.processor.getPauseReasons().has('auth-required'), true);
                assert.equal(harness.queueStore.peek()?.intent.operation, 'save');
                assert.equal(harness.queueStore.peek()?.attempts, 1);
                assert.equal(harness.dirtyFileManager.isDirty(file.path), true);

                await harness.queueManager.retryNow();

                assert.equal(attempts, 2);
                assert.equal(harness.queueManager.isPaused(), false);
                assert.equal(harness.queueStore.count(), 0);
                assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
            } finally {
                harness.queueManager.destroy();
            }
        });
    }

    test('a user-paused queue retains the modify save and its journal entry until resumed', async () => {
        const file = createFile('Notes/Paused.md');
        const harness = await createModifyHarness();

        try {
            harness.queueManager.pause('user');
            await harness.listeners.get('modify')!(file);
            await harness.debounceController.flushFile(file.path);

            assert.equal(harness.executions.length, 0);
            assert.equal(harness.queueStore.peek()?.intent.operation, 'save');
            assert.equal(harness.dirtyFileManager.isDirty(file.path), true);

            harness.queueManager.resume('user');
            await harness.queueManager.process();

            assert.equal(harness.executions.length, 1);
            assert.equal(harness.queueStore.count(), 0);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
        } finally {
            harness.queueManager.destroy();
        }
    });
});
