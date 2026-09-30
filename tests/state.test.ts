import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LocalDataStorage } from '../src/state/local-data-storage';
import { DeviceManager } from '../src/state/device-manager';
import { RecentNotesCache } from '../src/state/recent-notes-cache';
import { DirtyFileManager } from '../src/state/dirty-file-manager';
import { FailedTasksManager } from '../src/state/failed-tasks-manager';
import { BatchFailureReportManager } from '../src/state/batch-failure-report-manager';
import { parseActivityHistoryState, parseDirtyFileTsv, formatDirtyFileTsv, parseFailedTaskRecord } from '../src/state/state-validation';
import { ActivityHistoryManager } from '../src/state/activity-history-manager';
import type { ActivityRecord } from '../src/types/state';
import type { BatchFailureReport } from '../src/state/batch-failure-report-manager';
import { SAVE_EXECUTION_POLICIES, type TaskIntent } from '../src/operations/types';
import { FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS, truncatePayloadPreview } from '../src/utils/failed-task-payload-preview';

describe("State validation", () => {
test('persistent state validation accepts only the current strict schemas', () => {
    assert.deepEqual(parseDirtyFileTsv('SAVE\tNotes/Doc.md\nDELETE\tNotes/Old.md\nRENAME\tNew.md\tOld.md\n'), [
        { operation: 'SAVE', path: 'Notes/Doc.md' },
        { operation: 'DELETE', path: 'Notes/Old.md' },
        { operation: 'RENAME', path: 'New.md', oldPath: 'Old.md' },
    ]);
    assert.equal(formatDirtyFileTsv([
        { operation: 'SAVE', path: 'Notes/Doc.md' },
        { operation: 'RENAME', path: 'New.md', oldPath: 'Old.md' },
    ]), 'SAVE\tNotes/Doc.md\nRENAME\tNew.md\tOld.md\n');

    assert.deepEqual(parseActivityHistoryState(JSON.stringify({ version: 2, records: [] })), { version: 2, records: [] });
    assert.throws(() => parseActivityHistoryState(JSON.stringify({ version: 1, records: [] })), /Unsupported or invalid/);
});

test('parseFailedTaskRecord parses valid FailedTaskRecord and rejects malformed payloads', () => {
    const validRecord = {
        id: 'failed-rec-1',
        intent: {
            id: 'task-1',
            trigger: 'auto',
            event: 'modify',
            operation: 'save',
            path: 'Test.md',
            policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
        },
        timestamp: 12345690,
        attempts: 3,
        stage: 'upload',
        error: 'Connection refused',
        noteSizeBytes: 42,
    };

    // Valid JSON
    const parsed = parseFailedTaskRecord(JSON.stringify(validRecord));
    assert.equal(parsed.id, 'failed-rec-1');
    assert.equal(parsed.intent.path, 'Test.md');
    assert.equal(parsed.attempts, 3);
    assert.equal(parsed.error, 'Connection refused');
    assert.equal(parsed.noteSizeBytes, 42);

    // Malformed JSON string
    assert.throws(() => parseFailedTaskRecord('not json'), /Unexpected token|SyntaxError/);

    // Non-object
    assert.throws(() => parseFailedTaskRecord(JSON.stringify('string-payload')), /Invalid failed task record/);

    // Missing id
    assert.throws(() => parseFailedTaskRecord(JSON.stringify({ ...validRecord, id: undefined })), /Invalid failed task record/);

    // Missing or invalid intent
    assert.throws(() => parseFailedTaskRecord(JSON.stringify({ ...validRecord, intent: { corrupted: true } })), /Invalid failed task record/);
    assert.throws(() => parseFailedTaskRecord(JSON.stringify({ ...validRecord, intent: { ...validRecord.intent, policy: undefined } })), /Invalid failed task record/);

    // Missing timestamp
    assert.throws(() => parseFailedTaskRecord(JSON.stringify({ ...validRecord, timestamp: 'not-number' })), /Invalid failed task record/);

    // Missing attempts
    assert.throws(() => parseFailedTaskRecord(JSON.stringify({ ...validRecord, attempts: null })), /Invalid failed task record/);

    // Non-string error
    assert.throws(() => parseFailedTaskRecord(JSON.stringify({ ...validRecord, error: 123 })), /Invalid failed task record/);

    // Non-number noteSizeBytes defaults to undefined
    const withInvalidNoteSize = parseFailedTaskRecord(JSON.stringify({ ...validRecord, noteSizeBytes: 'forty-two' }));
    assert.equal(withInvalidNoteSize.noteSizeBytes, undefined);

    // Payload preview truncation test
    const longPayload = 'x'.repeat(FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS + 500);
    const withLongPreview = parseFailedTaskRecord(JSON.stringify({ ...validRecord, payloadPreview: longPayload }));
    assert.equal(withLongPreview.payloadPreview?.length, FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS);
});

test('truncatePayloadPreview helper handles strings, bounds, and undefined safely', () => {
    assert.equal(truncatePayloadPreview(undefined), undefined);
    assert.equal(truncatePayloadPreview(''), '');
    assert.equal(truncatePayloadPreview('short text'), 'short text');
    const long = 'a'.repeat(FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS + 100);
    const truncated = truncatePayloadPreview(long);
    assert.equal(truncated?.length, FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS);
    assert.equal(truncated, 'a'.repeat(FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS));
});
});

describe('ActivityTracker tests', () => {
test('ActivityTracker transitions through debounce, queue, and upload preserving stage metrics', async () => {
    const { ActivityTracker } = await import('../src/state/activity-tracker');

    // In-memory mock history manager
    const savedRecords: any[] = [];
    const mockHistoryManager: any = {
        async load(limit: number) {
            return [];
        },
        scheduleSave(records: any[]) {
            savedRecords.length = 0;
            savedRecords.push(...records);
        },
        async flush(records?: any[]) {
            if (records) {
                savedRecords.length = 0;
                savedRecords.push(...records);
            }
        },
    };

    const tracker = new ActivityTracker(mockHistoryManager, () => 100);
    await tracker.initialize();

    const path = 'Notes/Sprint.md';

    // 1. Debounce Starts
    tracker.record({
        path,
        stage: 'debounce',
        status: 'active',
        note: 'Active',
    });

    let records = tracker.getRecords();
    assert.equal(records.length, 1);
    let rec = records[0];
    assert.equal(rec.path, path);
    assert.equal(rec.event, 'modify');
    assert.equal(rec.status, 'ongoing');
    assert.ok(rec.debounce);
    assert.equal(rec.debounce?.status, 'active');
    assert.equal(rec.debounce?.note, 'Active');

    // CRITICAL: Unreached stages must remain undefined (rendered blank)
    assert.equal(rec.queue, undefined);
    assert.equal(rec.upload, undefined);

    // 2. Debounce Completes
    tracker.record({
        path,
        stage: 'debounce',
        status: 'completed',
        note: '30s',
    });
    rec = tracker.getRecords()[0];
    assert.equal(rec.debounce?.status, 'completed');
    assert.equal(rec.debounce?.note, '30s');
    assert.equal(rec.queue, undefined);
    assert.equal(rec.upload, undefined);

    // 3. Task Enqueued
    tracker.record({
        path,
        stage: 'queue',
        status: 'waiting',
    });
    rec = tracker.getRecords()[0];

    assert.ok(rec.queue);
    assert.equal(rec.queue?.status, 'waiting');
    // Debounce completed details preserved
    assert.equal(rec.debounce?.status, 'completed');
    // Upload not reached yet: undefined (blank)
    assert.equal(rec.upload, undefined);

    // 4. Upload Starts
    tracker.record({
        path,
        stage: 'queue',
        status: 'completed',
        note: 'waited 1.2s',
    });
    tracker.record({
        path,
        stage: 'upload',
        status: 'active',
        note: 'Uploading Object...',
    });
    rec = tracker.getRecords()[0];
    assert.equal(rec.queue?.status, 'completed');
    assert.equal(rec.queue?.note, 'waited 1.2s');
    assert.ok(rec.upload);
    assert.equal(rec.upload?.status, 'active');
    assert.equal(rec.upload?.note, 'Uploading Object...');

    // Step 2 upload entry
    tracker.record({
        path,
        stage: 'upload',
        status: 'active',
        note: 'Uploading Entry...',
    });
    rec = tracker.getRecords()[0];
    assert.equal(rec.upload?.note, 'Uploading Entry...');

    // 5. Upload Success
    tracker.record({
        path,
        stage: 'upload',
        status: 'completed',
        note: 'v5 · diff · 420 B · 180ms',
    });
    rec = tracker.getRecords()[0];

    assert.equal(rec.status, 'completed');
    assert.equal(rec.upload?.status, 'completed');
    assert.equal(rec.upload?.note, 'v5 · diff · 420 B · 180ms');
    // All completed stages retain details
    assert.equal(rec.debounce?.status, 'completed');
    assert.equal(rec.queue?.status, 'completed');

    // 6. Stable append order: Subsequent edit on the same completed file creates a new record at the bottom
    tracker.record({
        path,
        stage: 'debounce',
        status: 'active',
        note: 'Active',
    });

    records = tracker.getRecords();
    assert.equal(records.length, 2);
    // Old record is still at index 0 and marked completed
    assert.equal(records[0].id, rec.id);
    assert.equal(records[0].status, 'completed');
    // New record is appended at index 1 and is ongoing
    assert.equal(records[1].status, 'ongoing');
    assert.notEqual(records[1].id, rec.id);
});



test('ActivityTracker handles renames, deletes, and no-change events', async () => {
    const { ActivityTracker } = await import('../src/state/activity-tracker');

    const mockHistoryManager: any = {
        async load() {
            return [];
        },
        scheduleSave() {},
        async flush() {},
    };

    const tracker = new ActivityTracker(mockHistoryManager, () => 100);
    await tracker.initialize();

    // 1. Rename event
    tracker.record({
        path: 'NewName.md',
        oldPath: 'OldName.md',
        event: 'rename',
        stage: 'queue',
        status: 'waiting',
    });

    const records = tracker.getRecords();
    const renameRec = records.find(r => r.path === 'NewName.md');
    assert.ok(renameRec);
    assert.equal(renameRec.event, 'rename');
    assert.equal(renameRec.oldPath, 'OldName.md');
    assert.equal(renameRec.debounce, undefined);
    assert.equal(renameRec.queue?.status, 'waiting');

    // 2. No-change event
    tracker.record({
        path: 'NoChange.md',
        stage: 'debounce',
        status: 'active',
        note: 'Active',
    });
    const noChangeRec = tracker.getActiveRecordForPath('NoChange.md');
    assert.ok(noChangeRec);
    assert.equal(noChangeRec.status, 'ongoing');

    tracker.record({
        path: 'NoChange.md',
        stage: 'debounce',
        status: 'completed',
        note: 'Unchanged',
    });
    assert.equal(noChangeRec.status, 'completed');
    assert.equal(tracker.getActiveRecordForPath('NoChange.md'), undefined);
});

test('ActivityHistoryManager.flush flushes scheduled pending records and immediate records to storage', async () => {
    const memory = new Map<string, string>();
    const mockAdapter: any = {
        exists: async (p: string) => memory.has(p),
        mkdir: async () => {},
        read: async (p: string) => memory.get(p) || '',
        write: async (p: string, data: string) => { memory.set(p, data); },
    };

    const storage = new LocalDataStorage(mockAdapter, 'test-plugin');
    const historyManager = new ActivityHistoryManager(storage);

    const record1: ActivityRecord = {
        id: 'rec-1',
        path: 'Note1.md',
        event: 'modify',
        timestamp: Date.now(),
        status: 'completed',
    };
    const record2: ActivityRecord = {
        id: 'rec-2',
        path: 'Note2.md',
        event: 'modify',
        timestamp: Date.now(),
        status: 'ongoing',
    };

    // 1. Schedule a save then call flush() with no args to immediately write pending records
    historyManager.scheduleSave([record1, record2], 10);
    await historyManager.flush();

    const writtenJson = memory.get('test-plugin/local_data/activity_history.json');
    assert.ok(writtenJson, 'activity_history.json should have been written');
    const parsed = JSON.parse(writtenJson!);
    assert.equal(parsed.records.length, 2);
    assert.equal(parsed.records[0].id, 'rec-1');
    assert.equal(parsed.records[1].id, 'rec-2');

    // 2. Calling flush with direct records and custom limit trims and writes immediately
    const record3: ActivityRecord = {
        id: 'rec-3',
        path: 'Note3.md',
        event: 'modify',
        timestamp: Date.now() + 1000,
        status: 'completed',
    };
    await historyManager.flush([record1, record2, record3], 2);

    const updatedJson = memory.get('test-plugin/local_data/activity_history.json');
    const updatedParsed = JSON.parse(updatedJson!);
    // Limit is 2; ongoing record2 must be preserved, and newest completed record kept
    assert.equal(updatedParsed.records.length, 2);
    const ids = updatedParsed.records.map((r: ActivityRecord) => r.id);
    assert.ok(ids.includes('rec-2'), 'Ongoing record must be preserved');
});
});

describe('DeviceManager tests', () => {
test('DeviceManager preserves fallbackVaultId when device.json does not exist', async () => {
    const memoryFiles = new Map<string, string>();
    const mockAdapter: any = {
        exists: async (p: string) => memoryFiles.has(p),
        mkdir: async () => {},
        read: async (p: string) => {
            const val = memoryFiles.get(p);
            if (val === undefined) throw new Error(`File not found: ${p}`);
            return val;
        },
        write: async (p: string, data: string) => {
            memoryFiles.set(p, data);
        },
    };

    const storage = new LocalDataStorage(mockAdapter, 'test-plugin');
    const manager = new DeviceManager(storage);
    const existingVaultId = 'pre-existing-vault-uuid-1234';
    await manager.initialize(existingVaultId);

    assert.equal(manager.getVaultId(), existingVaultId);

    // Verify it was written to device.json
    const deviceJsonRaw = memoryFiles.get('test-plugin/local_data/device.json');
    assert.ok(deviceJsonRaw);
    const parsed = JSON.parse(deviceJsonRaw!);
    assert.equal(parsed.vault, existingVaultId);
    assert.ok(parsed.device, 'Device ID should be generated');

    // Subsequent initialization with different fallback preserves device.json as authority
    const secondManager = new DeviceManager(storage);
    await secondManager.initialize('different-seed-uuid');
    assert.equal(secondManager.getVaultId(), existingVaultId);
});

test('DeviceManager regenerates malformed or incomplete persisted identity data', async (t) => {
    for (const [name, corruptData] of [
        ['malformed JSON', '{not-json'],
        ['incomplete identity', JSON.stringify({ device: '', vault: 'vault-id' })],
    ] as const) {
        await t.test(name, async (subtest) => {
            const memoryFiles = new Map<string, string>([['test-plugin/local_data/device.json', corruptData]]);
            const mockAdapter: any = {
                exists: async (path: string) => memoryFiles.has(path),
                mkdir: async () => {},
                read: async (path: string) => memoryFiles.get(path) ?? null,
                write: async (path: string, data: string) => { memoryFiles.set(path, data); },
            };
            const errors: unknown[][] = [];
            subtest.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
            const storage = new LocalDataStorage(mockAdapter, 'test-plugin');
            const manager = new DeviceManager(storage);
            assert.throws(() => manager.getDevice(), /not initialized/);

            const state = await manager.initialize('fallback-vault');
            assert.ok(state.device.length > 0);
            assert.equal(state.vault, 'fallback-vault');
            assert.equal(manager.getDevice(), state.device);
            assert.equal(JSON.parse(memoryFiles.get('test-plugin/local_data/device.json')!).device, state.device);
            assert.equal(errors.length, 1);
        });
    }
});

test('DeviceManager generates both identities when no fallback vault ID is provided', async () => {
    let persisted = '';
    const storage: any = {
        read: async () => null,
        write: async (_name: string, content: string) => { persisted = content; },
    };
    const manager = new DeviceManager(storage);

    const state = await manager.initialize('   ');

    assert.ok(state.device.length > 0);
    assert.ok(state.vault.length > 0);
    assert.notEqual(state.device, state.vault);
    assert.deepEqual(JSON.parse(persisted), state);
});
});

describe('Failed Tasks Manager tests', () => {
test('FailedTasksManager manages bounded persistence, diagnosis, and task removal', async () => {
    const { FailedTasksManager } = await import('../src/state/failed-tasks-manager');
    let writtenContent = '';
    const mockAdapter: any = {
        async exists() {
            return false;
        },
        async read() {
            return writtenContent;
        },
        async write(path: string, data: string) {
            writtenContent = data;
        },
        async mkdir() {},
    };

    const storage = new LocalDataStorage(mockAdapter, 'test-plugin');
    const manager = new FailedTasksManager(storage);
    // To prevent the test run from blocking for 15sec due to setTimeout
    manager['debouncedWriteDelay'] = 100;
    await manager.initialize(3);

    // 1. Record task under limit
    const intent1: TaskIntent = {
        id: 'task-1',
        path: 'Note1.md',
        operation: 'save',
        trigger: 'auto',
        event: 'modify',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
    };

    const rec1 = await manager.recordTerminalFailure({
        id: 'task-1',
        intent: intent1,
        attempts: 2,
        stage: 'upload',
        error: 'Network timeout',
        cause: { name: 'NetworkError', message: 'Network timeout' },
        likelyReason: 'network_outage',
        noteSizeBytes: 500,
    }, 3);
    assert.equal(rec1.likelyReason, 'network_outage');
    assert.equal(manager.getCount(), 1);

    // 2. Record large task (> 100,000 bytes)
    const intent2: TaskIntent = {
        id: 'task-2',
        path: 'BigNote.md',
        operation: 'save',
        trigger: 'auto',
        event: 'modify',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
    };

    const rec2 = await manager.recordTerminalFailure({
        id: 'task-2',
        intent: intent2,
        attempts: 1,
        stage: 'upload',
        error: 'PocketBase HTTP 400: validation_max_length',
        cause: { name: 'ClientResponseError', message: 'validation_max_length', status: 400 },
        likelyReason: 'size_limit',
        noteSizeBytes: 150000,
    }, 3);
    assert.equal(rec2.likelyReason, 'size_limit');
    assert.equal(rec2.noteSizeBytes, 150000);
    assert.equal(manager.getCount(), 2);

    // 3. Test bounding to limit 3
    const createIntent = (id: string, path: string): TaskIntent => ({
        id,
        path,
        operation: 'save',
        trigger: 'auto',
        event: 'modify',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
    });

    await manager.recordTerminalFailure({
        id: 'task-3',
        intent: createIntent('task-3', 'Note3.md'),
        attempts: 1,
        stage: 'upload',
        error: 'Error 3',
        cause: { name: 'Error', message: 'Error 3' },
    }, 3);
    assert.equal(manager.getCount(), 3);

    // Adding 4th task should evict oldest (task-1)
    await manager.recordTerminalFailure({
        id: 'task-4',
        intent: createIntent('task-4', 'Note4.md'),
        attempts: 1,
        stage: 'upload',
        error: 'Error 4',
        cause: { name: 'Error', message: 'Error 4' },
    }, 3);
    assert.equal(manager.getCount(), 3);
    const tasks = manager.getFailedTasks();
    assert.equal(tasks.some((t) => t.id === 'task-1'), false);
    assert.equal(tasks.some((t) => t.id === 'task-4'), true);

    // 4. Remove single task
    const removed = await manager.removeFailedTask('task-2');
    assert.equal(removed, true);
    assert.equal(manager.getCount(), 2);

    // 5. Clear all
    await manager.clearAll();
    assert.equal(manager.getCount(), 0);
});

test('FailedTasksManager manages JSON Lines failed_tasks.jsonl correctly', async () => {
    const memory = new Map<string, string>();
    const mockAdapter: any = {
        exists: async (p: string) => memory.has(p),
        mkdir: async () => {},
        read: async (p: string) => memory.get(p) || '',
        write: async (p: string, data: string) => { memory.set(p, data); },
    };

    const storage = new LocalDataStorage(mockAdapter, 'test-plugin');
    const failedManager = new FailedTasksManager(storage);
    // To prevent the test run from blocking for 15sec due to setTimeout
    failedManager['debouncedWriteDelay'] = 100;
    await failedManager.initialize(5);

    const dummyIntent: TaskIntent = {
        id: 't-1',
        path: 'ErrorNote.md',
        operation: 'save',
        trigger: 'auto',
        event: 'modify',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
    };

    await failedManager.recordTerminalFailure({
        id: 't-1',
        intent: dummyIntent,
        attempts: 3,
        stage: 'upload',
        error: 'HTTP 400 Bad Request',
        cause: { name: 'ClientResponseError', message: 'Bad Request', status: 400 },
        likelyReason: 'validation_error',
        targetHash: 'sha256:err',
        noteSizeBytes: 500,
    });
    assert.equal(failedManager.getCount(), 1);

    await failedManager.flush();
    const jsonlRaw = memory.get('test-plugin/local_data/failed_tasks.jsonl');
    assert.ok(jsonlRaw);
    const lines = jsonlRaw!.trim().split('\n');
    assert.equal(lines.length, 1);

    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.id, 't-1');
    assert.equal(parsed.error, 'HTTP 400 Bad Request');
    assert.equal(parsed.likelyReason, 'validation_error');
    assert.equal(parsed.intent.path, 'ErrorNote.md');

    // Remove task
    await failedManager.removeFailedTask('t-1');
    assert.equal(failedManager.getCount(), 0);
    await failedManager.flush();
    assert.equal(memory.get('test-plugin/local_data/failed_tasks.jsonl'), '');
});


test('FailedTasksManager.subscribe notifies subscribers on record/remove and allows unsubscription', async () => {
    const memory = new Map<string, string>();
    const mockAdapter: any = {
        exists: async (p: string) => memory.has(p),
        mkdir: async () => {},
        read: async (p: string) => memory.get(p) || '',
        write: async (p: string, data: string) => { memory.set(p, data); },
    };

    const storage = new LocalDataStorage(mockAdapter, 'test-plugin');
    const failedManager = new FailedTasksManager(storage);
    // To prevent the test run from blocking for 15sec due to setTimeout
    failedManager['debouncedWriteDelay'] = 100;
    await failedManager.initialize(5);

    let notifyCount = 0;
    const unsubscribe = failedManager.subscribe(() => {
        notifyCount++;
    });

    const dummyIntent1: TaskIntent = {
        id: 't-sub-1',
        path: 'Sub1.md',
        operation: 'save',
        trigger: 'auto',
        event: 'modify',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
    };
    const dummyIntent2: TaskIntent = {
        id: 't-sub-2',
        path: 'Sub2.md',
        operation: 'save',
        trigger: 'auto',
        event: 'modify',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
    };

    // 1. Record task -> listener is called
    await failedManager.recordTerminalFailure({
        id: 't-sub-1',
        intent: dummyIntent1,
        attempts: 1,
        stage: 'upload',
        error: 'Error 1',
        cause: { name: 'Error', message: 'Error 1' },
    });
    assert.equal(notifyCount, 1);

    // 2. Remove task -> listener is called
    await failedManager.removeFailedTask('t-sub-1');
    assert.equal(notifyCount, 2);

    // 3. Unsubscribe -> listener is no longer called
    unsubscribe();
    await failedManager.recordTerminalFailure({
        id: 't-sub-2',
        intent: dummyIntent2,
        attempts: 1,
        stage: 'upload',
        error: 'Error 2',
        cause: { name: 'Error', message: 'Error 2' },
    });
    assert.equal(notifyCount, 2, 'Listener must not be called after unsubscribing');
});

});

describe("Local Data Storage Tests", () => {
test('LocalDataStorage performs path resolution, existence checks, read, write, append, and remove', async () => {
    const memory = new Map<string, string>();
    const mockAdapter: any = {
        exists: async (p: string) => memory.has(p),
        mkdir: async () => {},
        read: async (p: string) => memory.get(p) || '',
        write: async (p: string, data: string) => { memory.set(p, data); },
        append: async (p: string, data: string) => { memory.set(p, (memory.get(p) || '') + data); },
        remove: async (p: string) => { memory.delete(p); },
    };

    const storage = new LocalDataStorage(mockAdapter, 'my-plugin');
    assert.equal(storage.getPath('foo.txt'), 'my-plugin/local_data/foo.txt');

    assert.equal(await storage.exists('foo.txt'), false);
    assert.equal(await storage.read('foo.txt'), null);

    await storage.write('foo.txt', 'Line 1\n');
    assert.equal(await storage.exists('foo.txt'), true);
    assert.equal(await storage.read('foo.txt'), 'Line 1\n');

    await storage.append('foo.txt', 'Line 2\n');
    assert.equal(await storage.read('foo.txt'), 'Line 1\nLine 2\n');

    await storage.remove('foo.txt');
    assert.equal(await storage.exists('foo.txt'), false);
});
});

describe("Recent Notes Cache Tests", () => {
test('RecentNotesCache implements in-memory LRU eviction, capacity limits, and CRUD operations', () => {
    const cache = new RecentNotesCache();

    assert.equal(cache.size(), 0);
    assert.equal(cache.has('Note1.md'), false);
    assert.equal(cache.get('Note1.md'), undefined);

    // 1. Basic CRUD
    cache.set('Note1.md', {
        path: 'Note1.md',
        hash: 'sha256:hash1',
        baseText: 'Text 1',
        diffDepth: 0,
        timestamp: 1000,
    });
    assert.equal(cache.size(), 1);
    assert.equal(cache.has('Note1.md'), true);
    assert.equal(cache.get('Note1.md')?.hash, 'sha256:hash1');

    cache.delete('Note1.md');
    assert.equal(cache.size(), 0);
    assert.equal(cache.has('Note1.md'), false);

    // 2. Capacity & LRU eviction (MAX_CAPACITY = 50)
    // Add 50 items
    for (let i = 1; i <= 50; i++) {
        cache.set(`Doc${i}.md`, {
            path: `Doc${i}.md`,
            hash: `sha256:hash${i}`,
            baseText: `Text ${i}`,
            diffDepth: i,
            timestamp: 1000 + i,
        });
    }
    assert.equal(cache.size(), 50);
    assert.equal(cache.has('Doc1.md'), true);
    assert.equal(cache.has('Doc50.md'), true);

    // Access Doc1.md so it becomes most recently used
    const doc1 = cache.get('Doc1.md');
    assert.ok(doc1);

    // Now insert Doc51.md - capacity is exceeded (51).
    // The least recently used should be evicted. Since Doc1 was accessed, Doc2 should be evicted!
    cache.set('Doc51.md', {
        path: 'Doc51.md',
        hash: 'sha256:hash51',
        baseText: 'Text 51',
        diffDepth: 1,
        timestamp: 2000,
    });
    assert.equal(cache.size(), 50);
    assert.equal(cache.has('Doc1.md'), true, 'Doc1 was refreshed by get() and must remain');
    assert.equal(cache.has('Doc2.md'), false, 'Doc2 was LRU and should be evicted');
    assert.equal(cache.has('Doc51.md'), true);

    // 3. Clear operation
    cache.clear();
    assert.equal(cache.size(), 0);
    assert.equal(cache.has('Doc1.md'), false);
});
});

describe("Dirty File Manager Tests", () => {
test('DirtyFileManager manages TSV dirty_files.tsv and in-flight re-dirty correctly', async () => {
    const memory = new Map<string, string>();
    const mockAdapter: any = {
        exists: async (p: string) => memory.has(p),
        mkdir: async () => {},
        read: async (p: string) => memory.get(p) || '',
        write: async (p: string, data: string) => { memory.set(p, data); },
        append: async (p: string, data: string) => {
            const existing = memory.get(p) || '';
            memory.set(p, existing + data);
        },
    };

    const storage = new LocalDataStorage(mockAdapter, 'test-plugin');
    const dirtyManager = new DirtyFileManager(storage);
    await dirtyManager.load();

    assert.equal(dirtyManager.getDirtyPaths().length, 0);

    await dirtyManager.markDirty('SAVE', 'A.md');
    await dirtyManager.markDirty('B.md');
    await dirtyManager.markDirty('RENAME', 'New.md', 'Old.md');
    assert.equal(dirtyManager.isDirty('A.md'), true);
    assert.equal(dirtyManager.isDirty('C.md'), false);
    assert.equal(dirtyManager.isDirty('New.md'), true);

    const tsvRaw = memory.get('test-plugin/local_data/dirty_files.tsv');
    assert.ok(tsvRaw);
    assert.equal(tsvRaw, 'SAVE\tA.md\nSAVE\tB.md\nRENAME\tNew.md\tOld.md\n');

    // Test in-flight re-dirty protection
    dirtyManager.setInFlight('B.md', true);
    await dirtyManager.markDirty('SAVE', 'B.md'); // Edit during flight
    dirtyManager.setInFlight('B.md', false);
    await dirtyManager.markClean('B.md'); // Upload completed, but was re-dirtied
    assert.equal(dirtyManager.isDirty('B.md'), true, 'Re-dirtied file must remain dirty');

    // Clean A.md normally
    await dirtyManager.markClean('A.md');
    assert.equal(dirtyManager.isDirty('A.md'), false);

    // Reload from file
    const secondDirty = new DirtyFileManager(storage);
    const loaded = await secondDirty.load();
    assert.equal(loaded.some((e) => e.path === 'B.md'), true);
    assert.equal(loaded.some((e) => e.path === 'New.md'), true);
    assert.equal(secondDirty.isDirty('A.md'), false);
});
});

describe("Batch Failure Report Manager Tests", () => {
test('BatchFailureReportManager removes prior session reports at startup', async () => {
    const memory = new Map<string, string>([
        ['test-plugin/local_data/batch_failures/backup-old.json', '{}'],
        ['test-plugin/local_data/batch_failures/sync-old.json', '{}'],
    ]);
    const mockAdapter: any = {
        exists: async (p: string) => memory.has(p) || p === 'test-plugin/local_data/batch_failures',
        mkdir: async () => {},
        read: async (p: string) => memory.get(p) || '',
        write: async (p: string, data: string) => { memory.set(p, data); },
        remove: async (p: string) => { memory.delete(p); },
        list: async () => ({ files: Array.from(memory.keys()).filter((key) => key.includes('/batch_failures/')), folders: [] }),
    };
    const manager = new BatchFailureReportManager(new LocalDataStorage(mockAdapter, 'test-plugin'));

    await manager.clearPreviousSessionReports();

    assert.equal(memory.size, 0);
});

test('BatchFailureReportManager.write returns null when failed count is 0 and writes JSON file on failure', async () => {
    const memory = new Map<string, string>();
    const mockAdapter: any = {
        exists: async (p: string) => memory.has(p),
        mkdir: async () => {},
        read: async (p: string) => memory.get(p) || '',
        write: async (p: string, data: string) => { memory.set(p, data); },
    };

    const storage = new LocalDataStorage(mockAdapter, 'test-plugin');
    const manager = new BatchFailureReportManager(storage);

    // 1. Zero failures -> returns null and writes nothing
    const zeroReport: BatchFailureReport = {
        batchId: 'batch-zero',
        kind: 'vault-backup',
        startedAt: 1000,
        completedAt: 2000,
        total: 5,
        succeeded: 5,
        failed: 0,
        notAttempted: 0,
        failures: [],
    };
    const zeroResult = await manager.write(zeroReport);
    assert.equal(zeroResult, null);
    assert.equal(memory.size, 0);

    // 2. Non-zero failures -> writes report and returns path
    const failReport: BatchFailureReport = {
        batchId: 'batch-fail-1',
        kind: 'vault-sync',
        startedAt: 1000,
        completedAt: 2000,
        total: 5,
        succeeded: 4,
        failed: 1,
        notAttempted: 0,
        failures: [
            {
                path: 'Faulty.md',
                operation: 'save',
                reason: 'network_timeout',
                error: 'ETIMEDOUT',
                timestamp: 1500,
            },
        ],
    };
    const failResult = await manager.write(failReport);
    assert.ok(failResult, 'Path should be returned');
    assert.ok(failResult!.includes('vault-sync'));
    assert.ok(failResult!.includes('batch-fail-1.json'));

    const storedContent = memory.get(failResult!);
    assert.ok(storedContent, 'Report file must be saved in storage');
    const parsedReport = JSON.parse(storedContent!);
    assert.equal(parsedReport.batchId, 'batch-fail-1');
    assert.equal(parsedReport.failed, 1);
    assert.equal(parsedReport.failures[0].path, 'Faulty.md');
});
});
