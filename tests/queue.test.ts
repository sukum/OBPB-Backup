import { test, mock, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LocalDataStorage } from '../src/state/local-data-storage';
import { AutomaticQueueStore } from '../src/queue/automatic-queue-store';
import { AutomaticQueueProcessor } from '../src/queue/automatic-queue-processor';
import { UploadCoordinator } from '../src/upload/upload-coordinator';
import { AutomaticQueueManager } from '../src/queue/automatic-queue-manager';
import { PocketBaseError } from '../src/remote/pocketbase-client';
import { ConnectivityMonitor } from '../src/queue/connectivity-monitor';
import {
    SAVE_EXECUTION_POLICIES,
    type AutoSaveIntent,
    type ManualSaveIntent,
    type TaskIntent,
    type SaveIntent,
} from '../src/operations/types';
import type { QueuedTask } from '../src/queue/types';
import { RunnerExecutionError } from '../src/runner/types';
import { FailedTasksManager } from '../src/state/failed-tasks-manager';
import { RecentNotesCache } from '../src/state/recent-notes-cache';
import { DirtyFileManager } from '../src/state/dirty-file-manager';
import { QueueStatusNotifier } from '../src/queue/queue-status-notifier';
import type { SyncStatusEvent } from '../src/types/events';
import { logger } from './mocks/logger';

function task(id: string): AutoSaveIntent {
    return {
        id,
        path: `${id}.md`,
        operation: 'save',
        trigger: 'auto',
        event: 'modify',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        createdAt: 1,
    };
}

function store(): AutomaticQueueStore {
    return new AutomaticQueueStore(logger);
}

describe("FIFO Queue Behavior", () => {
test('AutomaticQueueStore preserves enqueue order and retries only its head', async () => {
    const queue = store();
    await queue.load();
    await queue.enqueue(task('first'));
    await queue.enqueue(task('second'));
    await queue.recordRetry('first', 'temporary', Date.now() + 60_000);
    assert.equal(queue.peek()?.id, 'first');
    // attempt incremented only in processSingleTask and store.recordRetry
    assert.equal(queue.peek()?.attempts, 1);
    assert.equal(await queue.acknowledge('second'), false);
    assert.equal(queue.count(), 2);
});

test('AutomaticQueueProcessor blocks later FIFO tasks while the head is retrying', async () => {
    const queue = store();
    await queue.load();
    const attempted: string[] = [];
    const processor = new AutomaticQueueProcessor(
        queue,
        {
            execute: async (intent: TaskIntent) => {
                attempted.push(intent.id);
                if (intent.id === 'first') {
                    throw new PocketBaseError(429, 'temporary rate limit');
                }
                return { status: 'uploaded' as const, intent };
            },
        },
        logger,
        {
            failedTasksManager: {recordTerminalFailure: () => mock.fn()} as any,
            recentNotesCache: {delete: mock.fn()} as any,
            dirtyFileMarker: { markClean: async () => {} } as any,
        }
    );
    const queueManager = new AutomaticQueueManager(queue, processor);

    try {
        await queueManager.enqueue(task('first'));
        assert.equal(queue.peek()?.id, 'first');
        assert.equal(queue.peek()?.attempts, 1);
        assert.ok((queue.peek()?.nextRetryAt ?? 0) > Date.now());

        await queueManager.enqueue(task('second'));

        assert.deepEqual(attempted, ['first']);
        assert.deepEqual(queue.getTasks().map(({ id }) => id), ['first', 'second']);
        assert.equal(queue.getTasks()[1]?.attempts, 0);
    } finally {
        queueManager.destroy();
    }
});
});

describe("Queue Processor behaviour", () => {
// Skipped: AutomaticQueueProcessor no longer provides prepareTask. SingleFileRunner and PayloadPreparer now own preparing uploads on demand before publication (covered by tests/single-file-runner.test.ts and tests/payload-preparer.test.ts).
test.skip('AutomaticQueueProcessor executes prepareTask on demand, skips unchanged null, and uploads prepared tasks', async () => {
});
});

describe("Queue Processor pause/resume", () => {
test('AutomaticQueueProcessor pauses on "user" reason, holds modified files in queue, and uploads on resume', async () => {
    const queue = store();
    await queue.load();

    const uploadMock = mock.fn(async (intent: TaskIntent) => ({ status: 'uploaded' as const, intent }));
    const onStateChangeMock = mock.fn(() => {});
    const loggerMock = { record: mock.fn() };

    const processor = new AutomaticQueueProcessor(
        queue,
        { execute: uploadMock },
        loggerMock,
        {
            onStateChange: onStateChangeMock,
            failedTasksManager: {} as any,
            recentNotesCache: {} as any,
            dirtyFileMarker: { markClean: async () => {} } as any,
        }
    );

    const queueManager = new AutomaticQueueManager(queue, processor);

    try {
        // 1. One file is modified, goes through queue, and gets uploaded
        const file1 = task('file-1');
        await queueManager.enqueue(file1);

        assert.equal(uploadMock.mock.callCount(), 1);
        assert.equal(uploadMock.mock.calls[0].arguments[0].id, 'file-1');
        assert.equal(queue.count(), 0);

        // 2. AutomaticQueueProcessor.pause("user") is called
        processor.pause('user');
        assert.equal(processor.isPaused(), true);
        assert.ok(processor.getPauseReasons().has('user'));

        // 3. Two more files are modified, but not uploaded due to the pause
        const file2 = task('file-2');
        const file3 = task('file-3');
        await queueManager.enqueue(file2);
        await queueManager.enqueue(file3);

        assert.equal(uploadMock.mock.callCount(), 1, 'No new uploads should have occurred while paused');
        assert.equal(queue.count(), 2, 'Both modified files should remain in the queue');
        assert.equal(queue.peek()?.id, 'file-2');

        // 4. AutomaticQueueProcessor.resume("user") is called and the two modified files get uploaded
        processor.resume('user');
        assert.equal(processor.isPaused(), false);

        await processor.process();

        assert.equal(uploadMock.mock.callCount(), 3, 'All three files should now be uploaded');
        assert.equal(uploadMock.mock.calls[1].arguments[0].id, 'file-2');
        assert.equal(uploadMock.mock.calls[2].arguments[0].id, 'file-3');
        assert.equal(queue.count(), 0, 'Queue should be empty after resume');
    } finally {
        processor.destroy();
        queueManager.destroy();
    }
});
});

describe("Upload tasks", () => {
test('upload task gets HTTP 401 error', async () => {
    const queue = store();
    await queue.load();
    await queue.enqueue(task('task-401'));

    const uploadMock = mock.fn(async (_intent: TaskIntent) => {
        throw new PocketBaseError(401, 'Unauthorized');
    });
    const onStateChangeMock = mock.fn(() => {});
    const loggerMock = { record: mock.fn() };

    const processor = new AutomaticQueueProcessor(
        queue,
        { execute: uploadMock },
        loggerMock,
        {
            onStateChange: onStateChangeMock,
            failedTasksManager: {} as any,
            recentNotesCache: {} as any,
            dirtyFileMarker: { markClean: async () => {} } as any,
        }
    );

    try {
        await processor.process();

        assert.equal(uploadMock.mock.callCount(), 1);
        assert.equal(processor.isPaused(), true);
        assert.ok(processor.getPauseReasons().has('auth-required'));
        assert.equal(queue.count(), 1);
        assert.equal(queue.peek()?.id, 'task-401');
        assert.equal(queue.peek()?.attempts, 1);
        assert.match(queue.peek()?.errorMessage || '', /401/);
    } finally {
        processor.destroy();
    }
});

test('upload task gets HTTP 400 error', async () => {
    const queue = store();
    await queue.load();
    await queue.enqueue(task('task-400'));

    const uploadMock = mock.fn(async (_intent: TaskIntent) => {
        throw new PocketBaseError(400, 'Invalid schema');
    });
    const failedTasks: any[] = [];
    const mockFailedTasksManager = {
        recordTerminalFailure: async (rec: any) => { failedTasks.push(rec); return rec; },
    };
    const mockRecentNotesCache = { delete: () => {} };
    const mockDirtyFileMarker = { markClean: async () => {} };
    const loggerMock = { record: mock.fn() };

    const processor = new AutomaticQueueProcessor(
        queue,
        { execute: uploadMock },
        loggerMock,
        {
            failedTasksManager: mockFailedTasksManager as any,
            recentNotesCache: mockRecentNotesCache as any,
            dirtyFileMarker: mockDirtyFileMarker as any,
        }
    );

    try {
        await processor.process();

        assert.equal(uploadMock.mock.callCount(), 1);
        assert.equal(failedTasks.length, 1);
        assert.equal(failedTasks[0].id, 'task-400');
        assert.match(failedTasks[0].error, /400.*Invalid schema/);
        assert.equal(failedTasks[0].likelyReason, 'validation_error');
        assert.equal(queue.count(), 0);
        assert.equal(processor.isPaused(), false);
        assert.equal(loggerMock.record.mock.callCount(), 2);
        assert.equal(loggerMock.record.mock.calls[0].arguments[0].status, 'active');
        assert.equal(loggerMock.record.mock.calls[1].arguments[0].status, 'failed');
        assert.equal(loggerMock.record.mock.calls[1].arguments[0].stage, 'queue');
    } finally {
        processor.destroy();
    }
});

test('upload task gets HTTP 500 error and ConnectivityMonitor.waitForRecovery is called, healthCheck triggers error 3 times and then returns without error', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    const queue = store();
    await queue.load();
    await queue.enqueue(task('task-500'));

    let uploadAttempts = 0;
    const uploadMock = mock.fn(async (_intent: TaskIntent) => {
        uploadAttempts++;
        if (uploadAttempts === 1) {
            throw new PocketBaseError(500, 'Internal Server Error');
        }
        return { status: 'uploaded' as const, intent: _intent };
    });

    let healthCheckErrors = 0;
    const healthCheckMock = mock.fn(async () => {
        if (healthCheckErrors < 3) {
            healthCheckErrors++;
            throw new Error(`health check error #${healthCheckErrors}`);
        }
    });

    const mockStore = { healthCheck: healthCheckMock };
    const waitForRecoverySpy = mock.method(ConnectivityMonitor.prototype, 'waitForRecovery');
    const loggerMock = { record: mock.fn() };

    const processor = new AutomaticQueueProcessor(
        queue,
        { execute: uploadMock },
        loggerMock,
        {
            connectivityChecker: mockStore,
            failedTasksManager: {} as any,
            recentNotesCache: {} as any,
            dirtyFileMarker: { markClean: async () => {} } as any,
        }
    );

    try {
        await processor.process();

        assert.equal(uploadMock.mock.callCount(), 1);
        assert.equal(waitForRecoverySpy.mock.callCount(), 1);
        assert.equal(processor.isPaused(), true);
        assert.ok(processor.getPauseReasons().has('offline'));
        assert.equal(queue.count(), 1);

        for (let i = 0; i < 20 && processor.isPaused(); i++) {
            mock.timers.tick(5000);
            await Promise.resolve();
        }

        assert.equal(healthCheckErrors, 3, 'healthCheck should have triggered error 3 times');
        assert.equal(healthCheckMock.mock.callCount(), 4, 'healthCheck should be called 4 times (3 errors + 1 success)');
        assert.equal(processor.isPaused(), false, 'processor should be resumed after healthCheck succeeds');

        await processor.process();

        assert.equal(uploadMock.mock.callCount(), 2, 'upload should succeed on retry');
        assert.equal(queue.count(), 0, 'queue should be empty after successful upload');
    } finally {
        processor.destroy();
        mock.timers.reset();
    }
});

test('upload task gets HTTP 429 errors and fails after 3 retry attempts', async () => {
    const queue = store();
    await queue.load();
    await queue.enqueue(task('task-429'));

    const uploadMock = mock.fn(async (_intent: TaskIntent) => {
        throw new PocketBaseError(429, 'Too Many Requests');
    });
    const failedTasks: any[] = [];
    const mockFailedTasksManager = {
        recordTerminalFailure: async (rec: any) => { failedTasks.push(rec); return rec; },
    };
    const loggerMock = { record: mock.fn() };

    const processor = new AutomaticQueueProcessor(
        queue,
        { execute: uploadMock },
        loggerMock,
        {
            failedTasksManager: mockFailedTasksManager as any,
            recentNotesCache: { delete: () => {} } as any,
            dirtyFileMarker: { markClean: async () => {} } as any,
        }
    );

    try {
        // Attempt 0: initial upload attempt fails with 429 -> scheduled for retry (delay: 5000)
        await processor.process();
        assert.equal(uploadMock.mock.callCount(), 1, "call count should be 1 after initial attempt");
        assert.equal(queue.peek()?.attempts, 1, "attempts should be 1 after initial attempt");
        assert.equal(queue.count(), 1, "queue should have 1 task after initial attempt");
        assert.equal(failedTasks.length, 0, "no tasks should have failed after initial attempt");

        // Attempt 1: retry fails with 429 -> scheduled for retry (delay: 30000)
        await queue.retryNow();
        await processor.process();
        assert.equal(uploadMock.mock.callCount(), 2);
        assert.equal(queue.peek()?.attempts, 2);
        assert.equal(queue.count(), 1);
        assert.equal(failedTasks.length, 0);

        // Attempt 2: retry fails with 429 -> scheduled for retry (delay: 120000)
        await queue.retryNow();
        await processor.process();
        assert.equal(uploadMock.mock.callCount(), 3);
        assert.equal(queue.peek()?.attempts, 3);
        assert.equal(queue.count(), 1);
        assert.equal(failedTasks.length, 0);

        // Attempt 3: attempts is now 3, delay is undefined -> terminal failure
        await queue.retryNow();
        await processor.process();
        assert.equal(uploadMock.mock.callCount(), 4, "upload calls should be 4 after final attempt");
        assert.equal(failedTasks.length, 1, "there should be 1 failed task after final attempt");
        assert.equal(failedTasks[0].id, 'task-429', "failed task should have the correct ID");
        assert.equal(failedTasks[0].attempts, 4, "failed task should have 4 attempts");
        assert.match(failedTasks[0].error, /429.*Too Many Requests/, "failed task should have the correct error message");
        assert.equal(queue.count(), 0, "queue should be empty after final failure");
    } finally {
        processor.destroy();
    }
});
});

describe("Queue status notifier", () => {
test('QueueStatusNotifier manages status, counts, subscriptions, and specialized notification events', () => {
    let pendingCount = 5;
    const notifier = new QueueStatusNotifier(() => pendingCount);

    const receivedEvents: SyncStatusEvent[] = [];
    const unsubscribe = notifier.subscribe((evt) => {
        receivedEvents.push(evt);
    });

    // 1. Initial status is synced; subscription immediately receives current status
    assert.equal(notifier.getStatus(), 'synced');
    assert.equal(receivedEvents.length, 1);
    assert.equal(receivedEvents[0].status, 'synced');
    assert.equal(receivedEvents[0].pendingCount, 5);

    // 2. Notify syncing
    notifier.notifySyncing('DocA.md', 5);
    assert.equal(notifier.getStatus(), 'syncing');
    assert.equal(receivedEvents.length, 2);
    assert.equal(receivedEvents[1].status, 'syncing');
    assert.equal(receivedEvents[1].message, 'Uploading DocA.md...');
    assert.equal(receivedEvents[1].pendingCount, 5);

    // 3. Notify offline
    notifier.notifyOffline('Network down', 4);
    assert.equal(notifier.getStatus(), 'offline');
    assert.equal(receivedEvents.length, 3);
    assert.equal(receivedEvents[2].status, 'offline');
    assert.equal(receivedEvents[2].message, 'Network down');
    assert.equal(receivedEvents[2].pendingCount, 4);

    // 4. Notify auth required
    notifier.notifyAuthRequired(3);
    assert.equal(notifier.getStatus(), 'auth_required');
    assert.equal(receivedEvents.length, 4);
    assert.equal(receivedEvents[3].status, 'auth_required');
    assert.equal(receivedEvents[3].message, 'Authentication failed; please check login credentials.');

    // 5. Notify waiting
    notifier.notifyWaiting(1, 10000, 2);
    assert.equal(notifier.getStatus(), 'waiting');
    assert.equal(receivedEvents.length, 5);
    assert.equal(receivedEvents[4].status, 'waiting');
    assert.equal(receivedEvents[4].message, 'Upload failed (1 attempt). Waiting 10 sec to retry again.');

    // 6. Notify paused
    notifier.notifyPaused(1);
    assert.equal(notifier.getStatus(), 'paused');
    assert.equal(receivedEvents.length, 6);
    assert.equal(receivedEvents[5].status, 'paused');
    assert.equal(receivedEvents[5].message, 'Uploads paused (1 queued)');

    // 7. Notify synced & test unsubscribe
    pendingCount = 0;
    notifier.notifySynced(0);
    assert.equal(notifier.getStatus(), 'synced');
    assert.equal(receivedEvents.length, 7);
    assert.equal(receivedEvents[6].status, 'synced');

    unsubscribe();
    notifier.notifySynced(0);
    assert.equal(receivedEvents.length, 7); // no new events delivered after unsubscribe
});
});

describe("Queue initialize", () => {
test('AutomaticQueueManager.initialize loads persisted tasks, does not runs processor or update status', async () => {
    const queue = store();
    await queue.enqueue(task('task-init'));

    const executedIds: string[] = [];
    const processor = new AutomaticQueueProcessor(
        queue,
        {
            execute: async (intent: TaskIntent) => {
                executedIds.push(intent.id);
                return { status: 'uploaded' as const, intent };
            },
        },
        logger,
        {
            failedTasksManager: {} as any,
            recentNotesCache: {} as any,
            dirtyFileMarker: { markClean: async () => {} } as any,
        }
    );

    const manager = new AutomaticQueueManager(queue, processor);

    try {
        await manager.initialize();
        assert.deepEqual(executedIds, []);
        assert.equal(queue.count(), 1);
        assert.equal(manager.getStatus(), 'syncing');
    } finally {
        processor.destroy();
    }
});
});

describe("Queue retryNow", () => {
test('AutomaticQueueManager.retryNow resets retry delay, clears offline and auth pauses, and resumes processing', async () => {
    const queue = store();
    await queue.load();
    await queue.enqueue(task('task-retry'));
    await queue.recordRetry('task-retry', 'network timeout', Date.now() + 60_000);

    const executedIds: string[] = [];
    const processor = new AutomaticQueueProcessor(
        queue,
        {
            execute: async (intent: TaskIntent) => {
                executedIds.push(intent.id);
                return { status: 'uploaded' as const, intent };
            },
        },
        logger,
        {
            failedTasksManager: {} as any,
            recentNotesCache: {} as any,
            dirtyFileMarker: { markClean: async () => {} } as any,
        }
    );

    const manager = new AutomaticQueueManager(queue, processor);

    try {
        // Pause for offline and auth-required
        manager.pause('offline');
        manager.pause('auth-required');
        assert.equal(manager.isPaused(), true);

        // Call retryNow: should clear delay, unpause offline/auth-required, and process queue
        await manager.retryNow();

        assert.equal(manager.isPaused(), false);
        assert.deepEqual(executedIds, ['task-retry']);
        assert.equal(queue.count(), 0);
        assert.equal(manager.getStatus(), 'synced');
    } finally {
        processor.destroy();
    }
});
});

describe("Step 5 Queue Refactoring & SingleFileRunner Integration", () => {
test('AutomaticQueueStore enforces identity invariant task.id === task.intent.id', async () => {
    const queue = store();
    const validIntent: AutoSaveIntent = {
        id: 'valid-id',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'doc.md',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        createdAt: 1000,
    };

    // Valid enqueue with TaskIntent
    await queue.enqueue(validIntent);
    assert.equal(queue.count(), 1);
    assert.equal(queue.peek()?.id, 'valid-id');
    assert.equal(queue.peek()?.intent.id, 'valid-id');

    // Non-automatic intent should reject
    const manualIntent: ManualSaveIntent = {
        ...validIntent,
        trigger: 'manual',
        policy: SAVE_EXECUTION_POLICIES.MANUAL_SYNC,
    };
    await assert.rejects(
        // @ts-expect-error Testing runtime rejection of manual intent
        async () => await queue.enqueue(manualIntent),
        /AutomaticQueueStore only accepts automatic TaskIntent instances/
    );
});

test('AutomaticQueueProcessor executes SingleFileRunner directly with task.intent', async () => {
    const queue = store();
    const intent: AutoSaveIntent = {
        id: 'run-task-1',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'executed.md',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        createdAt: 2000,
    };
    await queue.enqueue(intent);

    const executedIntents: TaskIntent[] = [];
    const mockRunner = {
        execute: async (targetIntent: TaskIntent) => {
            executedIntents.push(targetIntent);
            return { status: 'uploaded' as const, intent: targetIntent };
        },
    };

    const processor = new AutomaticQueueProcessor(
        queue,
        mockRunner,
        logger,
        {
            failedTasksManager: {} as any,
            recentNotesCache: {} as any,
            dirtyFileMarker: { markClean: async () => {} } as any,
        }
    );

    try {
        await processor.process();
        assert.equal(executedIntents.length, 1);
        assert.equal(executedIntents[0].id, 'run-task-1');
        assert.equal(executedIntents[0].path, 'executed.md');
        assert.equal(queue.count(), 0);
    } finally {
        processor.destroy();
    }
});

test('AutomaticQueueProcessor executes terminal failure atomic sequence: record -> evict cache -> ack queue -> markClean', async () => {
    const memory = new Map<string, string>();
    const adapter: any = {
        exists: async (p: string) => memory.has(p),
        mkdir: async () => {},
        read: async (p: string) => memory.get(p) || '',
        write: async (p: string, v: string) => memory.set(p, v),
        append: async (p: string, v: string) => memory.set(p, (memory.get(p) || '') + v),
    };
    const storage = new LocalDataStorage(adapter, '.');

    const queue = new AutomaticQueueStore(logger);
    const failedTasksManager = new FailedTasksManager(storage);
    const recentNotesCache = new RecentNotesCache();
    const dirtyFileManager = new DirtyFileManager(storage);

    recentNotesCache.set('failing.md', {
        path: 'failing.md',
        hash: 'hash-fail',
        baseText: 'content',
        diffDepth: 0,
        timestamp: 1000,
    });
    await dirtyFileManager.markDirty('failing.md');
    assert.equal(dirtyFileManager.isDirty('failing.md'), true);

    const intent: AutoSaveIntent = {
        id: 'terminal-fail-task',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'failing.md',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        createdAt: 1000,
    };
    await queue.enqueue(intent);

    const terminalError = new RunnerExecutionError(
        'Upload failed: HTTP 400 Validation error',
        'upload',
        new PocketBaseError(400, 'Invalid fields'),
        {
            id: 'terminal-fail-task',
            operation: 'save',
            vault: 'v1',
            device: 'd1',
            path: 'failing.md',
            targetHash: 'hash-fail',
            timestamp: 1000,
            objectPayload: {
                deterministicId: 'obj-1',
                dataHash: 'hash-fail',
                hash: 'hash-fail',
                size: 50,
                data: 'bad content',
                type: 'snapshot',
                parentHash: null,
                diffFormat: null,
            },
        },
        50,
        'bad content'
    );

    const mockRunner = {
        execute: async () => {
            throw terminalError;
        },
    };

    const processor = new AutomaticQueueProcessor(
        queue,
        mockRunner,
        logger,
        {
            failedTasksManager,
            recentNotesCache,
            dirtyFileMarker: dirtyFileManager,
        }
    );

    try {
        await processor.process();

        // 1. Task removed from queue
        assert.equal(queue.count(), 0);

        // 2. Note evicted from RecentNotesCache
        assert.equal(recentNotesCache.has('failing.md'), false);

        // 3. FailedTasksManager durably recorded the failure
        const failedTasks = failedTasksManager.getFailedTasks();
        assert.equal(failedTasks.length, 1);
        assert.equal(failedTasks[0].id, 'terminal-fail-task');
        assert.equal(failedTasks[0].stage, 'upload');
        assert.equal(failedTasks[0].targetHash, 'hash-fail');
        assert.equal(failedTasks[0].noteSizeBytes, 50);
        assert.equal(failedTasks[0].payloadPreview, 'bad content');
        assert.equal(failedTasks[0].likelyReason, 'validation_error');

        // 4. DirtyFileManager has marked the file clean
        assert.equal(dirtyFileManager.isDirty('failing.md'), false);
    } finally {
        processor.destroy();
    }
});
});
