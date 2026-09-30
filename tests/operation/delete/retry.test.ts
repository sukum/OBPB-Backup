import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticQueueManager } from '../../../src/queue/automatic-queue-manager';
import { AutomaticQueueProcessor } from '../../../src/queue/automatic-queue-processor';
import { AutomaticQueueStore } from '../../../src/queue/automatic-queue-store';
import { DirtyFileManager } from '../../../src/state/dirty-file-manager';
import { RecentNotesCache } from '../../../src/state/recent-notes-cache';
import { DeleteFileOperation } from '../../../src/operations/delete-file-op';
import { OperationsManager } from '../../../src/operations/operations-manager';
import { RetryFailedTaskOperation } from '../../../src/operations/retry-failed-task-op';
import { PocketBaseError } from '../../../src/remote/pocketbase-client';
import { BASE_EXECUTION_POLICIES, type TaskIntent } from '../../../src/operations/types';
import type { FailedTaskRecord } from '../../../src/types/state';
import { DebounceController } from '../mocks';

interface MemoryDirtyStorage {
    read(name: string): Promise<string | null>;
    write(name: string, content: string): Promise<void>;
    append(name: string, content: string): Promise<void>;
}

function createMemoryDirtyStorage(): MemoryDirtyStorage {
    let content = '';
    return {
        read: async () => content || null,
        write: async (_name, nextContent) => { content = nextContent; },
        append: async (_name, text) => { content += text; },
    };
}

async function createDeletePipeline(
    path: string,
    execute: (intent: TaskIntent) => Promise<unknown>,
    connectivityChecker?: { healthCheck(): Promise<void> }
) {
    const dirtyFileManager = new DirtyFileManager(createMemoryDirtyStorage());
    await dirtyFileManager.load();
    const cache = new RecentNotesCache();
    const queueStore = new AutomaticQueueStore({ record: () => {} });
    const runner = {
        execute: async (intent: TaskIntent) => {
            const result = await execute(intent);
            await dirtyFileManager.markClean(intent.path);
            return result as any;
        },
    };
    const processor = new AutomaticQueueProcessor(
        queueStore,
        runner as any,
        { record: () => {} },
        {
            connectivityChecker,
            failedTasksManager: { recordTerminalFailure: async () => {} } as any,
            recentNotesCache: cache,
            dirtyFileMarker: dirtyFileManager,
        }
    );
    const queueManager = new AutomaticQueueManager(queueStore, processor);
    await queueManager.initialize();

    const deleteFileOp = new DeleteFileOperation({
        queue: queueManager,
        dirtyFileManager,
        debounceController: new DebounceController(),
    });
    const operationsManager = new OperationsManager({
        deleteFileOp,
        automaticQueueManager: queueManager,
    } as any);

    return { dirtyFileManager, operationsManager, processor, queueManager, queueStore };
}

function failedDeleteRecord(id: string, path: string): FailedTaskRecord {
    return {
        id,
        timestamp: Date.now(),
        attempts: 4,
        stage: 'upload',
        error: 'Terminal delete failure',
        cause: { name: 'PocketBaseError', message: 'Terminal delete failure', status: 400 },
        intent: { id, trigger: 'auto', event: 'delete', operation: 'delete', path, policy: BASE_EXECUTION_POLICIES.AUTO },
    };
}


describe('Delete retries', () => {
    test('transient errors schedule retries after 5, 30, and 120 seconds before a successful acknowledgement', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const path = 'Notes/TransientDelete.md';
        const executions: TaskIntent[] = [];
        const pipeline = await createDeletePipeline(path, async (intent) => {
            executions.push(intent);
            const firstDeleteAttempts = executions.filter((item) => item.path === path).length;
            if (firstDeleteAttempts <= 3) {
                throw new PocketBaseError(429, 'Too Many Requests');
            }
            return { status: 'uploaded', intent };
        });

        try {
            await pipeline.operationsManager.handleFileDelete(path);
            const retryingTaskId = pipeline.queueStore.peek()?.id;
            assert.ok(retryingTaskId);
            assert.equal(executions.length, 1);
            assert.equal(pipeline.queueStore.peek()?.nextRetryAt, Date.now() + 5_000);
            assert.equal(pipeline.dirtyFileManager.isDirty(path), true);

            const laterPath = 'Notes/LaterDelete.md';
            await pipeline.operationsManager.handleFileDelete(laterPath);
            const laterTaskId = pipeline.queueStore.getTasks()[1]?.id;
            assert.ok(laterTaskId);
            assert.equal(pipeline.queueStore.count(), 2);
            assert.equal(pipeline.queueStore.peek()?.id, retryingTaskId, 'later work stays behind the retrying delete');
            assert.equal(pipeline.dirtyFileManager.isDirty(laterPath), true);

            mock.timers.tick(4_999);
            await Promise.resolve();
            assert.equal(executions.length, 1, 'the first retry must wait for five seconds');
            mock.timers.tick(1);
            await pipeline.queueManager.process();
            assert.equal(executions.length, 2);
            assert.equal(pipeline.queueStore.peek()?.nextRetryAt, Date.now() + 30_000);
            assert.equal(pipeline.dirtyFileManager.isDirty(path), true);

            mock.timers.tick(29_999);
            await Promise.resolve();
            assert.equal(executions.length, 2, 'the second retry must wait for thirty seconds');
            mock.timers.tick(1);
            await pipeline.queueManager.process();
            assert.equal(executions.length, 3);
            assert.equal(pipeline.queueStore.peek()?.nextRetryAt, Date.now() + 60_000);
            assert.equal(pipeline.dirtyFileManager.isDirty(path), true);

            mock.timers.tick(59_999);
            await Promise.resolve();
            assert.equal(executions.length, 3, 'the final retry must wait for one hundred and twenty seconds');
            mock.timers.tick(1);
            await pipeline.queueManager.process();

            assert.equal(executions.length, 5, 'the later delete starts only after the retrying head succeeds');
            assert.deepEqual(executions.map(({ id, operation, path: taskPath }) => ({ id, operation, path: taskPath })), [
                { id: retryingTaskId, operation: 'delete', path },
                { id: retryingTaskId, operation: 'delete', path },
                { id: retryingTaskId, operation: 'delete', path },
                { id: retryingTaskId, operation: 'delete', path },
                { id: laterTaskId, operation: 'delete', path: laterPath },
            ]);
            assert.equal(pipeline.queueStore.count(), 0, 'successful retry acknowledges the queued delete');
            assert.equal(pipeline.dirtyFileManager.isDirty(path), false, 'successful retry clears the dirty path');
            assert.equal(pipeline.dirtyFileManager.isDirty(laterPath), false);
        } finally {
            pipeline.queueManager.destroy();
            mock.timers.reset();
        }
    });

    test('connectivity recovery resumes the same queued delete and completes it', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const path = 'Notes/OfflineDelete.md';
        let online = false;
        let healthChecks = 0;
        const executions: TaskIntent[] = [];
        const pipeline = await createDeletePipeline(
            path,
            async (intent) => {
                executions.push(intent);
                if (executions.length === 1) throw new Error('Network unavailable');
                return { status: 'uploaded', intent };
            },
            {
                healthCheck: async () => {
                    healthChecks++;
                    if (!online) throw new Error('Still offline');
                },
            }
        );

        try {
            await pipeline.operationsManager.handleFileDelete(path);
            const taskId = executions[0]?.id;
            assert.ok(taskId);

            assert.equal(executions.length, 1);
            assert.equal(pipeline.operationsManager.isQueuePaused(), true);
            assert.equal(pipeline.queueStore.peek()?.id, taskId);
            assert.equal(pipeline.queueStore.count(), 1);
            assert.equal(pipeline.dirtyFileManager.isDirty(path), true);
            assert.ok(healthChecks >= 1, 'the queue checks connectivity after the request fails');

            online = true;
            mock.timers.tick(5_000);
            for (let i = 0; i < 10 && pipeline.operationsManager.isQueuePaused(); i++) {
                await Promise.resolve();
            }
            await pipeline.queueManager.process();

            assert.equal(healthChecks, 2, 'a successful health check detects recovery');
            assert.equal(executions.length, 2);
            assert.deepEqual(executions.map(({ id, operation, path: taskPath }) => ({ id, operation, path: taskPath })), [
                { id: taskId, operation: 'delete', path },
                { id: taskId, operation: 'delete', path },
            ]);
            assert.equal(pipeline.operationsManager.isQueuePaused(), false);
            assert.equal(pipeline.queueStore.count(), 0);
            assert.equal(pipeline.dirtyFileManager.isDirty(path), false);
        } finally {
            pipeline.queueManager.destroy();
            mock.timers.reset();
        }
    });

    test('a user-paused queue retains the delete and its dirty path until the user resumes it', async () => {
        const path = 'Notes/UserPausedDelete.md';
        const executions: TaskIntent[] = [];
        const pipeline = await createDeletePipeline(path, async (intent) => {
            executions.push(intent);
            return { status: 'uploaded', intent };
        });

        try {
            pipeline.operationsManager.pauseQueue();
            await pipeline.operationsManager.handleFileDelete(path);
            const taskId = pipeline.queueStore.peek()?.id;
            assert.ok(taskId);

            assert.equal(executions.length, 0);
            assert.equal(pipeline.operationsManager.isQueuePaused(), true);
            assert.equal(pipeline.queueStore.peek()?.id, taskId);
            assert.equal(pipeline.queueStore.count(), 1);
            assert.equal(pipeline.dirtyFileManager.isDirty(path), true);

            pipeline.operationsManager.resumeQueue();
            await pipeline.queueManager.process();

            assert.equal(executions.length, 1);
            assert.equal(executions[0].id, taskId);
            assert.equal(pipeline.queueStore.count(), 0);
            assert.equal(pipeline.dirtyFileManager.isDirty(path), false);
            assert.equal(pipeline.operationsManager.isQueuePaused(), false);
        } finally {
            pipeline.queueManager.destroy();
        }
    });

    test('retrying a failed delete from Failed Tasks runs a manual intent and removes its record on success', async () => {
        const path = 'Notes/ManualRetryDelete.md';
        const executed: TaskIntent[] = [];
        const removed: string[] = [];
        const retryOperation = new RetryFailedTaskOperation({
            vault: {} as any,
            runner: {
                execute: async (intent: TaskIntent) => {
                    executed.push(intent);
                    return { status: 'uploaded', intent } as any;
                },
            } as any,
            manualFileOp: {} as any,
            failedTasksManager: {
                remove: async (id: string) => { removed.push(id); return true; },
                updateFailedTask: async () => {},
            } as any,
        });
        const operationsManager = new OperationsManager({ retryFailedTaskOp: retryOperation } as any);
        const record = failedDeleteRecord('failed-delete-retry', path);

        await operationsManager.retryFailedTask(record);

        assert.equal(executed.length, 1);
        assert.equal(executed[0].operation, 'delete');
        assert.equal(executed[0].path, path);
        assert.equal(executed[0].trigger, 'manual');
        assert.deepEqual(removed, ['failed-delete-retry']);
    });

    for (const status of [401, 403]) {
        test(`${status} pauses for authentication; retryUploadQueue releases the pause and retries the delete`, async () => {
            const path = `Notes/AuthRequiredDelete${status}.md`;
            const executions: TaskIntent[] = [];
            const pipeline = await createDeletePipeline(path, async (intent) => {
                executions.push(intent);
                if (executions.length === 1) throw new PocketBaseError(status, 'Authentication required');
                return { status: 'uploaded', intent };
            });

            try {
                await pipeline.operationsManager.handleFileDelete(path);
                const taskId = executions[0]?.id;
                assert.ok(taskId);

                assert.equal(executions.length, 1);
                assert.equal(pipeline.operationsManager.isQueuePaused(), true);
                assert.equal(pipeline.processor.getPauseReasons().has('auth-required'), true);
                assert.equal(pipeline.queueStore.peek()?.attempts, 1);
                assert.equal(pipeline.queueStore.peek()?.id, taskId);
                assert.equal(pipeline.dirtyFileManager.isDirty(path), true);

                // The queue retry API can release this pause. The Activity tab's "Retry Now" action is commented out.
                await pipeline.operationsManager.retryUploadQueue();

                assert.equal(executions.length, 2);
                assert.equal(executions[1].trigger, 'auto');
                assert.equal(pipeline.operationsManager.isQueuePaused(), false);
                assert.equal(pipeline.processor.getPauseReasons().has('auth-required'), false);
                assert.equal(pipeline.queueStore.count(), 0);
                assert.equal(pipeline.dirtyFileManager.isDirty(path), false);
            } finally {
                pipeline.queueManager.destroy();
            }
        });
    }
});
