import { describe, test } from 'node:test';
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

async function createDeleteQueue(
    path: string,
    execute: (intent: TaskIntent) => Promise<unknown>
) {
    const dirtyFileManager = new DirtyFileManager(createMemoryDirtyStorage());
    await dirtyFileManager.load();

    const cache = new RecentNotesCache();
    cache.set(path, {
        path,
        hash: 'sha256:prior-version',
        baseText: 'previous contents',
        diffDepth: 0,
        timestamp: 1000,
    });

    const failedTasks: Array<Record<string, unknown>> = [];
    const queueStore = new AutomaticQueueStore({ record: () => {} });
    const processor = new AutomaticQueueProcessor(
        queueStore,
        { execute } as any,
        { record: () => {} },
        {
            failedTasksManager: {
                recordTerminalFailure: async (record: Record<string, unknown>) => {
                    failedTasks.push(record);
                },
            } as any,
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
    const operationsManager = new OperationsManager({ deleteFileOp } as any);

    return {
        cache,
        dirtyFileManager,
        failedTasks,
        operationsManager,
        processor,
        queueManager,
        queueStore,
    };
}

describe('Delete event failures', () => {
    test('retryable remote error leaves the delete at the FIFO head and dirty while scheduling a retry', async () => {
        const path = 'Notes/RateLimitedDelete.md';
        const pipeline = await createDeleteQueue(path, async () => {
            throw new PocketBaseError(429, 'Too Many Requests');
        });

        try {
            await pipeline.operationsManager.handleFileDelete(path);

            const queued = pipeline.queueStore.peek();
            assert.ok(queued, 'the failed task should remain in the automatic queue');
            assert.ok(queued!.id);
            assert.equal(queued!.intent.operation, 'delete');
            assert.equal(queued!.intent.path, path);
            assert.equal(queued!.attempts, 1);
            assert.match(queued!.errorMessage ?? '', /429.*Too Many Requests/);
            assert.ok(queued!.nextRetryAt && queued!.nextRetryAt > Date.now(), 'a future retry should be scheduled');
            assert.equal(pipeline.queueStore.count(), 1, 'later tasks must not pass the FIFO head');
            assert.equal(pipeline.dirtyFileManager.isDirty(path), true, 'the path remains dirty while retrying');
            assert.equal(pipeline.failedTasks.length, 0, 'retryable errors are not terminal failures');
        } finally {
            pipeline.queueManager.destroy();
        }
    });

    test('terminal remote error records a failed task, acknowledges the delete, and clears the dirty path', async () => {
        const path = 'Notes/InvalidDelete.md';
        const pipeline = await createDeleteQueue(path, async () => {
            throw new PocketBaseError(400, 'Invalid delete entry');
        });

        try {
            await pipeline.operationsManager.handleFileDelete(path);

            assert.equal(pipeline.failedTasks.length, 1);
            assert.ok(pipeline.failedTasks[0].id);
            assert.equal(pipeline.failedTasks[0].attempts, 1);
            assert.equal(pipeline.failedTasks[0].stage, 'upload');
            assert.match(String(pipeline.failedTasks[0].error), /400.*Invalid delete entry/);
            assert.equal(pipeline.queueStore.count(), 0, 'terminally failed task should be acknowledged');
            assert.equal(pipeline.dirtyFileManager.isDirty(path), false, 'terminal failure resolves the dirty journal entry');
            assert.equal(pipeline.cache.has(path), false, 'terminal failure evicts stale cached state');
        } finally {
            pipeline.queueManager.destroy();
        }
    });

    test('retryable remote error records a failed task and clears dirty state after the retry budget is exhausted', async () => {
        const path = 'Notes/ExhaustedDelete.md';
        const pipeline = await createDeleteQueue(path, async () => {
            throw new PocketBaseError(429, 'Too Many Requests');
        });

        try {
            await pipeline.operationsManager.handleFileDelete(path);
            const taskId = pipeline.queueStore.peek()?.id;
            assert.ok(taskId);
            assert.equal(pipeline.queueStore.peek()?.attempts, 1);
            assert.equal(pipeline.dirtyFileManager.isDirty(path), true);

            // The first attempt plus three scheduled retries exhausts the queue budget.
            await pipeline.queueManager.retryNow();
            await pipeline.queueManager.retryNow();
            await pipeline.queueManager.retryNow();

            assert.equal(pipeline.failedTasks.length, 1);
            assert.equal(pipeline.failedTasks[0].id, taskId);
            assert.equal(pipeline.failedTasks[0].attempts, 4);
            assert.match(String(pipeline.failedTasks[0].error), /429.*Too Many Requests/);
            assert.equal(pipeline.queueStore.count(), 0, 'exhausted task should be acknowledged');
            assert.equal(pipeline.dirtyFileManager.isDirty(path), false, 'exhausted failure clears the dirty path');
            assert.equal(pipeline.cache.has(path), false);
        } finally {
            pipeline.queueManager.destroy();
        }
    });
});

describe('Failed Tasks retry', () => {
    test('retrying a failed delete updates its attempt and error details when the retry fails', async () => {
        const runnerIntents: TaskIntent[] = [];
        const updatedRecords: FailedTaskRecord[] = [];
        const removedRecords: string[] = [];
        const path = 'Notes/RetryDelete.md';
        const retryError = new Error('PocketBase HTTP 503: retry rejected');

        const retryFailedTaskOp = new RetryFailedTaskOperation({
            vault: {} as any,
            runner: {
                execute: async (intent: TaskIntent) => {
                    runnerIntents.push(intent);
                    throw retryError;
                },
            } as any,
            manualFileOp: {} as any,
            failedTasksManager: {
                remove: async (id: string) => { removedRecords.push(id); },
                updateFailedTask: async (record: FailedTaskRecord) => { updatedRecords.push({ ...record }); },
            } as any,
        });
        const operationsManager = new OperationsManager({ retryFailedTaskOp } as any);
        const record: FailedTaskRecord = {
            id: 'failed-delete-to-retry',
            timestamp: 1000,
            attempts: 2,
            stage: 'upload',
            error: 'Original delete upload error',
            cause: { name: 'Error', message: 'Original delete upload error' },
            intent: {
                id: 'failed-delete-to-retry',
                trigger: 'auto',
                event: 'delete',
                operation: 'delete',
                path,
                policy: BASE_EXECUTION_POLICIES.AUTO,
            },
        };
        const retryStartedAt = Date.now();

        await assert.rejects(operationsManager.retryFailedTask(record), /PocketBase HTTP 503: retry rejected/);

        assert.equal(runnerIntents.length, 1);
        assert.equal(runnerIntents[0].operation, 'delete');
        assert.equal(runnerIntents[0].path, path);
        assert.equal(runnerIntents[0].trigger, 'manual', 'Failed Tasks retries run as manual work');
        assert.deepEqual(removedRecords, [], 'a failed retry must remain in Failed Tasks');
        assert.equal(updatedRecords.length, 1);
        assert.equal(updatedRecords[0].id, record.id);
        assert.equal(updatedRecords[0].attempts, 3);
        assert.equal(updatedRecords[0].error, retryError.message);
        assert.ok(updatedRecords[0].timestamp >= retryStartedAt, 'retry failure refreshes the record timestamp');
        assert.equal(record.attempts, 3);
        assert.equal(record.error, retryError.message);
    });
});
