import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseFailedTaskRecord } from '../src/state/state-validation';
import { serializeTaskIntent } from '../src/operations/types';
import { SingleFileRunner } from '../src/runner/single-file-runner';
import type { TaskIntent, IntentEvent, IntentTrigger } from '../src/operations/types';
import type { PayloadPreparerPort } from '../src/preparation/payload-preparer';
import type { PreparationResult } from '../src/preparation/types';
import type { ActivityEvent, ActivityLogger, CachedNoteState } from '../src/types/state';
import type {
    DirtyFileMarker,
    NoteStateCache,
    RunCoordinator,
    TaskUploadService,
} from '../src/runner/types';
import type { PreparedUpload } from '../src/upload/types';
import {
    saveExecutionPolicy,
    type PlannedSaveIntent,
} from './helpers/execution-policy-contract';

class TestPreparer implements PayloadPreparerPort {
    constructor(public result: PreparationResult) {}

    async prepare(_intent: TaskIntent): Promise<PreparationResult> {
        return this.result;
    }
}

class TestDirtyFileMarker implements DirtyFileMarker {
    public readonly calls: string[] = [];

    beginFlight(path: string): void {
        this.calls.push(`begin:${path}`);
    }

    endFlight(path: string): void {
        this.calls.push(`end:${path}`);
    }

    async markClean(path: string): Promise<void> {
        this.calls.push(`clean:${path}`);
    }
}

class TestNoteStateCache implements NoteStateCache {
    private readonly values = new Map<string, CachedNoteState>();

    has(path: string): boolean {
        return this.values.has(path);
    }

    get(path: string): CachedNoteState | undefined {
        return this.values.get(path);
    }

    set(path: string, state: CachedNoteState): void {
        this.values.set(path, state);
    }

    delete(path: string): boolean {
        return this.values.delete(path);
    }
}

class TestCoordinator implements RunCoordinator {
    run<T>(fn: () => Promise<T>): Promise<T> {
        return fn();
    }
}

class TestUploader implements TaskUploadService {
    public readonly logActivityValues: Array<boolean | undefined> = [];

    async upload(_task: PreparedUpload, logActivity?: boolean): Promise<void> {
        this.logActivityValues.push(logActivity);
    }
}

class TestActivityLogger implements ActivityLogger {
    public readonly events: ActivityEvent[] = [];

    record(event: ActivityEvent): void {
        this.events.push(event);
    }
}

function saveUpload(path: string): PreparedUpload {
    return {
        id: `upload-${path}`,
        operation: 'save',
        vault: 'vault-test',
        device: 'device-test',
        path,
        targetHash: `hash-${path}`,
        timestamp: 100,
        objectPayload: {
            deterministicId: `object-${path}`,
            hash: `hash-${path}`,
            dataHash: `hash-${path}`,
            size: 4,
            data: 'text',
            type: 'snapshot',
            parentHash: null,
            diffFormat: null,
        },
    };
}

function readyResult(path: string): PreparationResult {
    return {
        kind: 'ready',
        upload: saveUpload(path),
        content: 'text',
        newDiffDepth: 0,
    };
}

function setupRunner(result: PreparationResult) {
    const preparer = new TestPreparer(result);
    const dirtyMarker = new TestDirtyFileMarker();
    const cache = new TestNoteStateCache();
    const uploader = new TestUploader();
    const logger = new TestActivityLogger();
    const runner = new SingleFileRunner(
        preparer,
        new TestCoordinator(),
        uploader,
        dirtyMarker,
        cache,
        logger,
    );
    return { runner, dirtyMarker, cache, uploader, logger };
}

function plannedSaveIntent(
    trigger: IntentTrigger,
    event: IntentEvent,
    path: string,
    policy = saveExecutionPolicy(),
): PlannedSaveIntent {
    return {
        id: `task-${path}`,
        trigger,
        event,
        operation: 'save',
        path,
        policy,
    };
}

describe('Single FileRunner - Task Intent Execution Policy', () => {

test('SingleFileRunner follows policy.trackDirty when an automatic intent disables journal tracking', async () => {
    const { runner, dirtyMarker } = setupRunner(readyResult('NoJournal.md'));
    const intent = plannedSaveIntent('auto', 'modify', 'NoJournal.md', saveExecutionPolicy({
        trackDirty: false,
        logActivity: false,
        updateCache: false,
    }));

    await runner.execute(intent);

    assert.deepEqual(dirtyMarker.calls, []);
});

test('SingleFileRunner follows policy.trackDirty when a manual batch intent enables journal tracking', async () => {
    const { runner, dirtyMarker } = setupRunner(readyResult('Journal.md'));
    const intent = plannedSaveIntent('manual', 'vault-backup', 'Journal.md', saveExecutionPolicy({
        trackDirty: true,
        logActivity: false,
        updateCache: false,
    }));

    await runner.execute(intent);

    assert.deepEqual(dirtyMarker.calls, [
        'begin:Journal.md',
        'clean:Journal.md',
        'end:Journal.md',
    ]);
});

test('SingleFileRunner follows policy.logActivity for upload events despite an automatic trigger', async () => {
    const { runner, uploader } = setupRunner(readyResult('Quiet.md'));
    const intent = plannedSaveIntent('auto', 'modify', 'Quiet.md', saveExecutionPolicy({
        logActivity: false,
        trackDirty: false,
        updateCache: false,
    }));

    await runner.execute(intent);

    assert.deepEqual(uploader.logActivityValues, [false]);
});

test('SingleFileRunner follows policy.logActivity for unchanged completion despite a batch event', async () => {
    const { runner, logger } = setupRunner({ kind: 'unchanged', path: 'Unchanged.md' });
    const intent = plannedSaveIntent('manual', 'vault-backup', 'Unchanged.md', saveExecutionPolicy({
        logActivity: true,
        trackDirty: false,
        updateCache: false,
    }));

    await runner.execute(intent);

    assert.equal(logger.events.length, 1);
    assert.equal(logger.events[0].status, 'completed');
    assert.equal(logger.events[0].note, 'Unchanged');
});

test('SingleFileRunner follows policy.updateCache=false outside batch operations', async () => {
    const { runner, cache } = setupRunner(readyResult('NoCache.md'));
    const intent = plannedSaveIntent('manual', 'modify', 'NoCache.md', saveExecutionPolicy({
        logActivity: false,
        trackDirty: false,
        updateCache: false,
    }));

    await runner.execute(intent);

    assert.equal(cache.has('NoCache.md'), false);
});

test('SingleFileRunner follows policy.updateCache=true during a batch event', async () => {
    const { runner, cache } = setupRunner(readyResult('CacheMe.md'));
    const intent = plannedSaveIntent('manual', 'vault-backup', 'CacheMe.md', saveExecutionPolicy({
        logActivity: false,
        trackDirty: false,
        updateCache: true,
    }));

    await runner.execute(intent);

    assert.equal(cache.has('CacheMe.md'), true);
});
});

describe('Failed Task Deserialization', () => {
test('failed-task deserialization rejects invalid base execution-policy values', () => {
    const envelope = {
        id: 'failed-1',
        timestamp: 100,
        attempts: 1,
        stage: 'upload',
        error: 'Upload failed',
        intent: {
            id: 'task-1',
            trigger: 'auto',
            event: 'modify',
            operation: 'save',
            path: 'Policy.md',
            policy: {
                logActivity: true,
                trackDirty: true,
                updateCache: true,
            },
        },
    };

    assert.throws(() => parseFailedTaskRecord(JSON.stringify({
        ...envelope,
        intent: { ...envelope.intent, policy: { ...envelope.intent.policy, trackDirty: 'yes' } },
    })), /Invalid failed task record/);
    assert.throws(() => parseFailedTaskRecord(JSON.stringify({
        ...envelope,
        intent: { ...envelope.intent, policy: undefined },
    })), /Invalid failed task record/);
});

test('failed-task deserialization requires SaveExecutionPolicy.skipIfUnchanged', () => {
    const intent = {
        id: 'task-save',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'Policy.md',
        policy: { logActivity: true, trackDirty: true, updateCache: true },
    };

    assert.throws(() => parseFailedTaskRecord(JSON.stringify({
        id: 'failed-save',
        timestamp: 100,
        attempts: 1,
        error: 'Upload failed',
        intent,
    })), /Invalid failed task record/);
});

test('failed-task deserialization requires a base policy for rename and delete intents', () => {
    const shared = {
        trigger: 'auto',
        path: 'Policy.md',
    };

    assert.throws(() => parseFailedTaskRecord(JSON.stringify({
        intent: {
            ...shared,
            id: 'task-rename',
            event: 'rename',
            operation: 'rename',
            oldPath: 'Old.md',
        },
        id: 'failed-rename',
        timestamp: 100,
        attempts: 1,
        error: 'Rename failed',
    })), /Invalid failed task record/);
    assert.throws(() => parseFailedTaskRecord(JSON.stringify({
        intent: {
            ...shared,
            id: 'task-delete',
            event: 'delete',
            operation: 'delete',
        },
        id: 'failed-delete',
        timestamp: 100,
        attempts: 1,
        error: 'Delete failed',
    })), /Invalid failed task record/);
});

test('failed-task deserialization preserves a valid policy on the serialized intent', () => {
    const policy = saveExecutionPolicy({ logActivity: false, trackDirty: false, updateCache: true });
    const record = {
        id: 'failed-2',
        timestamp: 200,
        attempts: 2,
        stage: 'upload',
        error: 'Upload failed',
        intent: {
            id: 'task-2',
            trigger: 'manual',
            event: 'modify',
            operation: 'save',
            path: 'Policy.md',
            mode: 'snapshot',
            policy,
        },
    };

    const parsed = parseFailedTaskRecord(JSON.stringify(record));
    assert.deepEqual(parsed.intent, record.intent);
});
});

describe('Task Intent Serialization', () => {
test('serializeTaskIntent keeps the policy in the durable projection', () => {
    const intent = plannedSaveIntent('auto', 'modify', 'Serialized.md', saveExecutionPolicy({
        logActivity: true,
        trackDirty: false,
        updateCache: true,
        skipIfUnchanged: false,
    }));
    const taskIntent: TaskIntent = intent;
    const serialized = serializeTaskIntent(taskIntent);

    assert.ok('policy' in serialized);
    if ('policy' in serialized) {
        assert.deepEqual(serialized.policy, intent.policy);
    }
});
});
