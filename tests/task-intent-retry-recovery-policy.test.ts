import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { TFile, Vault } from 'obsidian';
import { DiffEngine } from '../src/diff/diff-engine';
import { ManualFileOperation } from '../src/operations/manual-file-operation';
import { RetryFailedTaskOperation } from '../src/operations/retry-failed-task-op';
import { StartupRecoveryOperation } from '../src/operations/startup-recovery-op';
import { SAVE_EXECUTION_POLICIES, type SaveExecutionPolicy, type TaskIntent, type TaskRunner } from '../src/operations/types';
import { PocketBaseError } from '../src/remote/pocketbase-client';
import { isRecord } from '../src/utils/guards';
import { TaskFactory } from '../src/tasks/task-factory';
import { Hasher } from '../src/hashing/hasher';
import type { FailedTaskRecord } from '../src/types/state';
import { DebounceController as TestDebounceController } from './operation/mocks';
import { createFile, createModifyHarness } from './operation/modify/helpers';

function failedSaveRecord(path: string, targetHash?: string): FailedTaskRecord {
    return {
        id: `failed-${path}`,
        timestamp: 100,
        attempts: 1,
        stage: 'upload',
        error: 'Upload failed',
        cause: { name: 'Error', message: 'Upload failed' },
        targetHash,
        intent: {
            id: `task-${path}`,
            trigger: 'auto',
            event: 'modify',
            operation: 'save',
            path,
            policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        },
    };
}

function failedIntentPolicy(record: Record<string, unknown>): unknown {
    assert.ok(isRecord(record.intent));
    return record.intent.policy;
}

function createRetryHarness(file: TFile, content: string, failUpload: boolean) {
    const executedIntents: TaskIntent[] = [];
    const runner: TaskRunner = {
        execute: async (intent) => {
            executedIntents.push(intent);
            if (failUpload) throw new Error('Retry upload failed');
            return { status: 'uploaded', intent };
        },
    };

    // RetryFailedTaskOperation and ManualFileOperation only need these Vault methods in this test.
    const vault = {
        getAbstractFileByPath: (path: string) => path === file.path ? file : null,
        cachedRead: async (_file: TFile) => content,
    } as unknown as Vault;

    const removedIds: string[] = [];
    const updatedRecords: FailedTaskRecord[] = [];
    const manualFileOp = new ManualFileOperation({
        vault,
        runner,
        taskFactory: new TaskFactory(),
        debounceController: new TestDebounceController(),
    });
    const operation = new RetryFailedTaskOperation({
        vault,
        runner,
        manualFileOp,
        failedTasksManager: {
            remove: async (id) => {
                removedIds.push(id);
                return true;
            },
            updateFailedTask: async (record) => { updatedRecords.push(record); },
        },
    });

    return { executedIntents, operation, removedIds, updatedRecords };
}

function assertExecutedSavePolicy(
    intents: TaskIntent[],
    expectedMode: 'auto' | 'snapshot',
    expectedPolicy: SaveExecutionPolicy,
): void {
    const intent = intents[0];
    assert.ok(intent);
    if (intent.operation !== 'save') assert.fail('Expected a save intent');
    assert.equal(intent.trigger, 'manual');
    assert.equal(intent.mode, expectedMode);
    assert.deepEqual(intent.policy, expectedPolicy);
}

describe('Task intent policy during modify recovery and failed-task retry', () => {
    test('dirty SAVE recovery uses AUTO_MODIFY and completes successfully', async () => {
        const file = createFile('Notes/RecoveredPolicy.md');
        const harness = await createModifyHarness({
            initialJournal: `SAVE\t${file.path}\n`,
            files: new Map([[file.path, file]]),
        });

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
            assert.equal(recovered.trigger, 'auto');
            assert.deepEqual(recovered.policy, SAVE_EXECUTION_POLICIES.AUTO_MODIFY);

            harness.queueManager.resume('startup-recovery');
            await harness.queueManager.process();
            assert.equal(harness.queueStore.count(), 0);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('dirty SAVE recovery retains AUTO_MODIFY when processing ends in a terminal failure', async () => {
        const file = createFile('Notes/RecoveryFailurePolicy.md');
        const harness = await createModifyHarness({
            initialJournal: `SAVE\t${file.path}\n`,
            files: new Map([[file.path, file]]),
            execute: async () => { throw new PocketBaseError(400, 'Terminal upload failure'); },
        });

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
            assert.deepEqual(recovered.policy, SAVE_EXECUTION_POLICIES.AUTO_MODIFY);

            harness.queueManager.resume('startup-recovery');
            await harness.queueManager.process();

            assert.equal(harness.failedTasks.length, 1);
            const failedRecord = harness.failedTasks[0];
            assert.ok(failedRecord);
            assert.deepEqual(failedIntentPolicy(failedRecord), SAVE_EXECUTION_POLICIES.AUTO_MODIFY);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('retrying an unchanged failed SAVE executes with MANUAL_SYNC and removes the record', async () => {
        const file = createFile('Notes/RetrySyncPolicy.md');
        const content = '# Same content\n';
        const targetHash = await Hasher.computeHash(DiffEngine.normalizeNewlines(content));
        const harness = createRetryHarness(file, content, false);

        await harness.operation.execute(failedSaveRecord(file.path, targetHash));

        assertExecutedSavePolicy(harness.executedIntents, 'auto', SAVE_EXECUTION_POLICIES.MANUAL_SYNC);
        assert.deepEqual(harness.removedIds, [`failed-${file.path}`]);
        assert.deepEqual(harness.updatedRecords, []);
    });

    test('retrying a changed failed SAVE executes with MANUAL_SNAPSHOT and removes the record', async () => {
        const file = createFile('Notes/RetrySnapshotPolicy.md');
        const harness = createRetryHarness(file, '# Changed content\n', false);

        await harness.operation.execute(failedSaveRecord(file.path, 'previous-content-hash'));

        assertExecutedSavePolicy(harness.executedIntents, 'snapshot', SAVE_EXECUTION_POLICIES.MANUAL_SNAPSHOT);
        assert.deepEqual(harness.removedIds, [`failed-${file.path}`]);
        assert.deepEqual(harness.updatedRecords, []);
    });

    test('a failed unchanged-content retry still executes with MANUAL_SYNC and preserves the record', async () => {
        const file = createFile('Notes/RetrySyncFailurePolicy.md');
        const content = '# Same content\n';
        const targetHash = await Hasher.computeHash(DiffEngine.normalizeNewlines(content));
        const harness = createRetryHarness(file, content, true);
        const record = failedSaveRecord(file.path, targetHash);

        await assert.rejects(harness.operation.execute(record), /Retry upload failed/);

        assertExecutedSavePolicy(harness.executedIntents, 'auto', SAVE_EXECUTION_POLICIES.MANUAL_SYNC);
        assert.deepEqual(harness.removedIds, []);
        assert.equal(harness.updatedRecords.length, 1);
        assert.equal(harness.updatedRecords[0].attempts, 2);
        assert.equal(harness.updatedRecords[0].error, 'Retry upload failed');
    });

    test('a failed changed-content retry still executes with MANUAL_SNAPSHOT and preserves the record', async () => {
        const file = createFile('Notes/RetrySnapshotFailurePolicy.md');
        const harness = createRetryHarness(file, '# Changed content\n', true);
        const record = failedSaveRecord(file.path, 'previous-content-hash');

        await assert.rejects(harness.operation.execute(record), /Retry upload failed/);

        assertExecutedSavePolicy(harness.executedIntents, 'snapshot', SAVE_EXECUTION_POLICIES.MANUAL_SNAPSHOT);
        assert.deepEqual(harness.removedIds, []);
        assert.equal(harness.updatedRecords.length, 1);
        assert.equal(harness.updatedRecords[0].attempts, 2);
        assert.equal(harness.updatedRecords[0].error, 'Retry upload failed');
    });
});
