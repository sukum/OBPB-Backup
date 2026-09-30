import { describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DebounceController } from '../../../src/vault/debounce-controller';
import { DirtyFileManager } from '../../../src/state/dirty-file-manager';
import { RenameFileOperation } from '../../../src/operations/rename-file-op';
import { StartupRecoveryOperation } from '../../../src/operations/startup-recovery-op';
import { BASE_EXECUTION_POLICIES, SAVE_EXECUTION_POLICIES, type AutoSaveIntent, type RenameIntent, type SaveIntent } from '../../../src/operations/types';
import { createFile, createFolder, createMemoryDirtyStorage, createQueueHarness, createUploadHarness } from './helpers';

describe('Rename success flows', () => {
    test('a tracked file rename publishes a delete for the old path followed by a rename entry for the new path', async () => {
        const oldPath = 'Notes/Before.md';
        const newPath = 'Notes/After.md';
        const file = createFile(newPath);
        const pipeline = await createUploadHarness({
            files: new Map([[newPath, file]]),
            history: [{
                id: 'old-entry',
                vault: 'vault-test',
                path: oldPath,
                oldPath: null,
                objectId: 'object-sha256:old-content',
                hash: 'sha256:old-content',
                operation: 'save',
                device: 'device-test',
                timestamp: 1000,
            }],
        });

        try {
            await pipeline.operationsManager.handleFileRename(file, oldPath);

            assert.deepEqual(
                pipeline.entries.slice(1).map(({ operation, path, oldPath: source }) => ({ operation, path, oldPath: source })),
                [
                    { operation: 'delete', path: oldPath, oldPath: null },
                    { operation: 'rename', path: newPath, oldPath },
                ]
            );
            assert.equal(pipeline.entries[1].hash, 'sha256:old-content');
            assert.equal(pipeline.entries[2].hash, 'sha256:old-content');
            assert.equal(pipeline.queueStore.count(), 0, 'successful rename is acknowledged');
            assert.deepEqual(pipeline.dirtyFileManager.getEntries(), []);
            assert.deepEqual(pipeline.latestLookups, [oldPath]);
        } finally {
            pipeline.queueManager.destroy();
        }
    });

    test('moving a tracked file to an unmonitored extension publishes a delete for the old path', async () => {
        const oldPath = 'Notes/Report.md';
        const newPath = 'Notes/Report.pdf';
        const file = createFile(newPath);
        const pipeline = await createUploadHarness({
            files: new Map([[newPath, file]]),
            history: [{
                id: 'report-save',
                vault: 'vault-test',
                path: oldPath,
                oldPath: null,
                objectId: 'object-sha256:report',
                hash: 'sha256:report',
                operation: 'save',
                device: 'device-test',
                timestamp: 1000,
            }],
        });

        try {
            await pipeline.operationsManager.handleFileRename(file, oldPath);

            assert.deepEqual(pipeline.entries.slice(1).map(({ operation, path }) => ({ operation, path })), [
                { operation: 'delete', path: oldPath },
            ]);
            assert.equal(pipeline.queueStore.count(), 0);
            assert.deepEqual(pipeline.dirtyFileManager.getEntries(), []);
        } finally {
            pipeline.queueManager.destroy();
        }
    });

    test('moving an untracked file to an unmonitored extension skips the delete cleanly', async () => {
        const oldPath = 'Archive/Untracked.md';
        const newPath = 'Archive/Untracked.pdf';
        const file = createFile(newPath);
        const pipeline = await createUploadHarness({ files: new Map([[newPath, file]]) });

        try {
            await pipeline.operationsManager.handleFileRename(file, oldPath);

            assert.equal(pipeline.entries.length, 0);
            assert.equal(pipeline.queueStore.count(), 0);
            assert.deepEqual(pipeline.dirtyFileManager.getEntries(), []);
        } finally {
            pipeline.queueManager.destroy();
        }
    });

    const snapshotFallbackScenarios: Array<{
        label: string;
        history: Array<Record<string, any>>;
        lookupFailure?: boolean;
    }> = [
        { label: 'source has never been tracked', history: [] },
        {
            label: 'the source has already been deleted remotely',
            history: [{
                id: 'source-delete',
                vault: 'vault-test',
                path: 'Archive/Untracked.txt',
                oldPath: null,
                objectId: 'object-sha256:old-content',
                hash: 'sha256:old-content',
                operation: 'delete',
                device: 'device-test',
                timestamp: 1000,
            }],
        },
        { label: 'source metadata lookup fails', history: [], lookupFailure: true },
    ];

    for (const scenario of snapshotFallbackScenarios) {
        test(`a monitored destination falls back to a snapshot save when ${scenario.label}`, async (t: TestContext) => {
            const oldPath = 'Archive/Untracked.txt';
            const newPath = 'Notes/Imported.md';
            const file = createFile(newPath);
            const pipeline = await createUploadHarness({
                files: new Map([[newPath, file]]),
                history: scenario.history,
            });
            const intent: RenameIntent = {
                id: 'untracked-rename',
                trigger: 'auto',
                event: 'rename',
                operation: 'rename',
                path: newPath,
                oldPath,
                file,
                policy: BASE_EXECUTION_POLICIES.AUTO,
            };
            t.mock.method(console, 'error', () => {});
            t.mock.method(console, 'warn', () => {});
            try {
                if (scenario.lookupFailure) {
                    pipeline.store.getLatestEntry = async () => { throw new Error('Remote lookup failed'); };
                }
                const prepared = await pipeline.preparer.prepare(intent);

                assert.equal(prepared.kind, 'ready');
                if (prepared.kind !== 'ready') return;
                assert.equal(prepared.upload.operation, 'save');
                assert.equal(prepared.upload.path, newPath);
            } finally {
                pipeline.queueManager.destroy();
            }
            t.mock.reset();
        });
    }

    test('a rename cancels a pending debounce at the old path without enqueueing its save', async () => {
        const oldPath = 'Notes/Before.md';
        const file = createFile('Notes/After.md');
        const dirtyFileManager = new DirtyFileManager(createMemoryDirtyStorage());
        await dirtyFileManager.load();
        const enqueued: Array<Record<string, any>> = [];
        const debounce = new DebounceController(
            dirtyFileManager,
            5_000,
            300_000,
            async (task) => { enqueued.push({ operation: 'save', path: task.path }); }
        );
        const rename = new RenameFileOperation({
            queue: { enqueue: async (intent) => { enqueued.push(intent); } },
            dirtyFileManager,
            debounceController: debounce,
            getSettings: () => ({ monitoredExtensions: ['md'] } as any),
        });
        await debounce.schedule({
            id: 'pending-save',
            path: oldPath,
            timestamp: Date.now(),
            file: createFile(oldPath),
        });

        await rename.execute(file, oldPath);

        assert.equal(debounce.isPending(oldPath), false);
        assert.deepEqual(enqueued.map(({ operation, path }) => ({ operation, path })), [
            { operation: 'rename', path: file.path },
        ]);
        assert.deepEqual(dirtyFileManager.getEntries(), [
            { operation: 'SAVE', path: oldPath },
            { operation: 'RENAME', path: file.path, oldPath },
        ]);
    });

    test('folder rename events expand nested files and apply the destination filter to each file', async () => {
        const note = createFile('NewArchive/Subfolder/Note.md');
        const attachment = createFile('NewArchive/Subfolder/Image.pdf');
        const subfolder = createFolder('NewArchive/Subfolder', [note, attachment]);
        const folder = createFolder('NewArchive', [subfolder]);
        const harness = await createQueueHarness({
            files: new Map([[note.path, note], [attachment.path, attachment]]),
        });

        try {
            harness.queueManager.pause('test');
            const renameHandler = harness.listeners.get('rename');
            assert.ok(renameHandler, 'rename event handler should be registered');
            await renameHandler!(folder, 'OldArchive');

            const intents = harness.queueStore.getTasks().map(({ intent }) => intent);
            assert.deepEqual(intents.map((intent) => ({ operation: intent.operation, path: intent.path })), [
                { operation: 'rename', path: note.path },
                { operation: 'delete', path: 'OldArchive/Subfolder/Image.pdf' },
            ]);
            assert.equal(intents[0].operation, 'rename');
            if (intents[0].operation === 'rename') {
                assert.equal(intents[0].oldPath, 'OldArchive/Subfolder/Note.md');
            }
            assert.deepEqual(harness.cancelledPaths, [
                'OldArchive/Subfolder/Note.md',
                'OldArchive/Subfolder/Image.pdf',
            ]);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), [
                { operation: 'RENAME', path: note.path, oldPath: 'OldArchive/Subfolder/Note.md' },
                { operation: 'DELETE', path: 'OldArchive/Subfolder/Image.pdf' },
            ]);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('renaming an empty folder enqueues no file operations', async () => {
        const harness = await createQueueHarness();
        try {
            harness.queueManager.pause('test');
            await harness.listeners.get('rename')!(createFolder('NewEmpty'), 'OldEmpty');
            assert.equal(harness.queueStore.count(), 0);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('startup recovery replays a dirty rename when its destination still exists', async () => {
        const oldPath = 'Old/Recovered.md';
        const newPath = 'New/Recovered.md';
        const file = createFile(newPath);
        const harness = await createQueueHarness({
            initialJournal: `RENAME\t${newPath}\t${oldPath}\n`,
            files: new Map([[newPath, file]]),
        });

        try {
            harness.queueManager.pause('boot');
            const recovery = new StartupRecoveryOperation({
                vault: { getAbstractFileByPath: (path: string) => path === newPath ? file : null } as any,
                dirtyFileManager: harness.dirtyFileManager,
                queue: harness.queueManager,
            });
            await recovery.execute();

            const recovered = harness.queueStore.peek()?.intent;
            assert.ok(recovered);
            assert.equal(recovered!.operation, 'rename');
            if (recovered!.operation === 'rename') {
                assert.equal(recovered!.path, newPath);
                assert.equal(recovered!.oldPath, oldPath);
                assert.equal(recovered!.event, 'recovery');
            }
            assert.deepEqual(harness.dirtyFileManager.getEntries(), [
                { operation: 'DELETE', path: oldPath },
                { operation: 'RENAME', path: newPath, oldPath },
            ]);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('startup recovery turns a dirty rename into a delete when the destination is missing', async () => {
        const oldPath = 'Old/Missing.md';
        const newPath = 'New/Missing.md';
        const harness = await createQueueHarness({ initialJournal: `RENAME\t${newPath}\t${oldPath}\n` });

        try {
            harness.queueManager.pause('boot');
            const recovery = new StartupRecoveryOperation({
                vault: { getAbstractFileByPath: () => null } as any,
                dirtyFileManager: harness.dirtyFileManager,
                queue: harness.queueManager,
            });
            await recovery.execute();

            assert.deepEqual(harness.queueStore.getTasks().map(({ intent }) => ({
                operation: intent.operation,
                path: intent.path,
                event: intent.event,
            })), [{ operation: 'delete', path: oldPath, event: 'recovery' }]);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), [
                { operation: 'DELETE', path: oldPath },
            ]);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('a previous save already in the FIFO stays ahead of the rename and a destination save stays behind it', async () => {
        const oldPath = 'Notes/A.md';
        const newPath = 'Notes/B.md';
        const file = createFile(newPath);
        const harness = await createQueueHarness();

        try {
            harness.queueManager.pause('test');
            const oldSave: AutoSaveIntent = {
                id: 'old-save', trigger: 'auto', event: 'modify', operation: 'save', path: oldPath, policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
            };
            await harness.queueManager.enqueue(oldSave);
            await harness.operationsManager.handleFileRename(file, oldPath);
            const newSave: AutoSaveIntent = {
                id: 'new-save', trigger: 'auto', event: 'modify', operation: 'save', path: newPath, file, policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
            };
            await harness.queueManager.enqueue(newSave);

            const queued = harness.queueStore.getTasks().map(({ intent }) => intent);
            assert.equal(queued[0].id, 'old-save');
            assert.equal(queued[1].operation, 'rename');
            assert.equal(queued[2].id, 'new-save');
            assert.deepEqual(harness.cancelledPaths, [oldPath]);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('a rename chain is retained as separate FIFO transitions', async () => {
        const first = createFile('Notes/B.md');
        const second = createFile('Notes/C.md');
        const harness = await createQueueHarness();

        try {
            harness.queueManager.pause('test');
            await harness.operationsManager.handleFileRename(first, 'Notes/A.md');
            await harness.operationsManager.handleFileRename(second, 'Notes/B.md');

            assert.deepEqual(harness.queueStore.getTasks().map(({ intent }) => {
                if (intent.operation !== 'rename') return null;
                return { path: intent.path, oldPath: intent.oldPath };
            }), [
                { path: 'Notes/B.md', oldPath: 'Notes/A.md' },
                { path: 'Notes/C.md', oldPath: 'Notes/B.md' },
            ]);
        } finally {
            harness.queueManager.destroy();
        }
    });
});
