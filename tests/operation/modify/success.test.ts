import { describe, mock, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { TFolder } from 'obsidian';
import { DiffEngine } from '../../../src/diff/diff-engine';
import { Hasher } from '../../../src/hashing/hasher';
import { SAVE_EXECUTION_POLICIES, type SaveIntent } from '../../../src/operations/types';
import { SnapshotPolicy } from '../../../src/policies/snapshot-policy';
import { RecentNotesCache } from '../../../src/state/recent-notes-cache';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';
import { createFile, createModifyHarness, createSavePreparationHarness } from './helpers';

async function settlePromises(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

function modifyIntent(path: string, file?: ReturnType<typeof createFile>): SaveIntent {
    return {
        id: `modify-${path}`,
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path,
        file,
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
    };
}

describe('Modify event and debounce success flows', () => {
    test('the modify event schedules only TFiles with monitored, non-ignored paths', async () => {
        const note = createFile('Notes/Tracked.md');
        const harness = await createModifyHarness();
        try {
            const modify = harness.listeners.get('modify');
            assert.ok(modify, 'modify event handler should be registered');

            const folder = new TFolder();
            folder.path = 'Notes/Folder';
            await modify!(folder);
            await modify!(createFile('Notes/Attachment.pdf'));
            await modify!(createFile('Notes/.private.md'));

            assert.equal(harness.debounceController.isPending(note.path), false);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);

            await modify!(note);
            assert.equal(harness.debounceController.isPending(note.path), true);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), [
                { operation: 'SAVE', path: note.path },
            ]);
            assert.equal(harness.queueStore.count(), 0, 'a modify event waits for debounce before queueing');
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('repeated modifies reset one file timer and produce one latest-content save intent', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const file = createFile('Notes/Debounced.md');
        const harness = await createModifyHarness({ debounceIntervalMs: 100, maxWaitMs: 500 });
        try {
            const modify = harness.listeners.get('modify')!;
            await modify(file);
            mock.timers.tick(40);
            await modify(file);

            assert.equal(harness.dirtyFileManager.getEntries().length, 1, 'repeat edits share the same dirty SAVE entry');
            mock.timers.tick(99);
            await Promise.resolve();
            assert.equal(harness.executions.length, 0, 'the second edit reset the timer');

            mock.timers.tick(1);
            await harness.queueManager.process();

            assert.equal(harness.executions.length, 1);
            assert.equal(harness.executions[0].operation, 'save');
            assert.equal(harness.executions[0].event, 'modify');
            assert.equal(harness.executions[0].path, file.path);
            assert.equal(harness.executions[0].trigger, 'auto');
            assert.equal(harness.queueStore.count(), 0);
            assert.deepEqual(harness.dirtyFileManager.getEntries(), []);
        } finally {
            harness.queueManager.destroy();
            mock.timers.reset();
        }
    });

    test('different files keep independent timers and an explicit path flush leaves other paths pending', async () => {
        const first = createFile('Notes/First.md');
        const second = createFile('Notes/Second.md');
        const harness = await createModifyHarness();
        try {
            harness.queueManager.pause('inspect');
            await harness.listeners.get('modify')!(first);
            await harness.listeners.get('modify')!(second);

            await harness.operationsManager.flushDebouncedFiles(first.path);

            assert.equal(harness.debounceController.isPending(first.path), false);
            assert.equal(harness.debounceController.isPending(second.path), true);
            assert.equal(harness.queueStore.count(), 1);
            assert.equal(harness.queueStore.peek()?.intent.path, first.path);

            await harness.operationsManager.flushDebouncedFiles();
            assert.equal(harness.debounceController.isPending(second.path), false);
            assert.deepEqual(harness.queueStore.getTasks().map(({ intent }) => intent.path), [first.path, second.path]);
            harness.queueManager.resume('inspect');
            await harness.queueManager.process();
            assert.equal(harness.queueStore.count(), 0);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('a delete arriving before debounce cancels the pending save and queues only the delete', async () => {
        const file = createFile('Notes/DeletedBeforeFlush.md');
        const harness = await createModifyHarness();
        try {
            harness.queueManager.pause('inspect');
            await harness.listeners.get('modify')!(file);
            await harness.listeners.get('delete')!(file);

            assert.equal(harness.debounceController.isPending(file.path), false);
            assert.deepEqual(harness.queueStore.getTasks().map(({ intent }) => ({
                operation: intent.operation,
                path: intent.path,
            })), [{ operation: 'delete', path: file.path }]);
            harness.queueManager.resume('inspect');
            await harness.queueManager.process();
            assert.deepEqual(harness.executions.map(({ operation }) => operation), ['delete']);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('a rename arriving before debounce cancels the old-path save and queues only the rename', async () => {
        const oldFile = createFile('Notes/BeforeRename.md');
        const newPath = 'Notes/AfterRename.md';
        const harness = await createModifyHarness();
        try {
            harness.queueManager.pause('inspect');
            await harness.listeners.get('modify')!(oldFile);
            oldFile.path = newPath;
            oldFile.name = 'AfterRename.md';
            oldFile.basename = 'AfterRename';
            oldFile.extension = 'md';
            await harness.listeners.get('rename')!(oldFile, 'Notes/BeforeRename.md');

            assert.equal(harness.debounceController.isPending('Notes/BeforeRename.md'), false);
            assert.deepEqual(harness.queueStore.getTasks().map(({ intent }) => ({
                operation: intent.operation,
                path: intent.path,
                oldPath: intent.operation === 'rename' ? intent.oldPath : undefined,
            })), [{ operation: 'rename', path: newPath, oldPath: 'Notes/BeforeRename.md' }]);
            harness.queueManager.resume('inspect');
            await harness.queueManager.process();
            assert.deepEqual(harness.executions.map(({ operation }) => operation), ['rename']);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('active leaf change flushes every pending modify immediately', async () => {
        const first = createFile('Notes/LeafA.md');
        const second = createFile('Notes/LeafB.md');
        const harness = await createModifyHarness();
        try {
            await harness.listeners.get('modify')!(first);
            await harness.listeners.get('modify')!(second);

            harness.workspaceListeners.get('active-leaf-change')!();
            await settlePromises();
            await harness.queueManager.process();

            assert.deepEqual(harness.executions.map(({ path }) => path), [first.path, second.path]);
            assert.equal(harness.debounceController.isPending(first.path), false);
            assert.equal(harness.debounceController.isPending(second.path), false);
        } finally {
            harness.queueManager.destroy();
        }
    });

    test('beforeunload flushes all pending modifies', async () => {
        // const priorWindow = (globalThis as any).window;
        // (globalThis as any).window = {};
        let harness: Awaited<ReturnType<typeof createModifyHarness>> | undefined;
        try {
            const file = createFile('Notes/Unload.md');
            harness = await createModifyHarness();
            await harness.listeners.get('modify')!(file);

            const beforeUnload = harness.domListeners.get('beforeunload');
            assert.ok(beforeUnload, 'beforeunload handler should be registered');
            beforeUnload!();
            await settlePromises();
            await harness.queueManager.process();

            assert.equal(harness.executions.length, 1);
            assert.equal(harness.executions[0].path, file.path);
            assert.equal(harness.debounceController.isPending(file.path), false);
        } finally {
            harness?.queueManager.destroy();
            // if (priorWindow === undefined) delete (globalThis as any).window;
            // else (globalThis as any).window = priorWindow;
        }
    });

    test('a modify arriving at max wait triggers the pending save immediately', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const file = createFile('Notes/MaxWaitEvent.md');
        const harness = await createModifyHarness({ debounceIntervalMs: 100, maxWaitMs: 200 });
        try {
            const modify = harness.listeners.get('modify')!;
            await modify(file);
            mock.timers.tick(90);
            await modify(file);
            mock.timers.tick(90);
            await modify(file);
            mock.timers.tick(20);
            assert.equal(harness.executions.length, 0, 'the controller checks max wait when a modify arrives');

            await modify(file);
            await harness.queueManager.process();

            assert.equal(harness.executions.length, 1);
            assert.equal(harness.debounceController.isPending(file.path), false);
        } finally {
            harness.queueManager.destroy();
            mock.timers.reset();
        }
    });

    test('max wait has no separate timer, so a quiet debounce can fire after its configured limit', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const file = createFile('Notes/QuietAfterEdit.md');
        const harness = await createModifyHarness({ debounceIntervalMs: 100, maxWaitMs: 200 });
        try {
            const modify = harness.listeners.get('modify')!;
            await modify(file);
            mock.timers.tick(90);
            await modify(file);
            mock.timers.tick(90);
            await modify(file);
            mock.timers.tick(20);
            assert.equal(harness.executions.length, 0);

            mock.timers.tick(79);
            assert.equal(harness.executions.length, 0);
            mock.timers.tick(1);
            await harness.queueManager.process();

            assert.equal(harness.executions.length, 1);
        } finally {
            harness.queueManager.destroy();
            mock.timers.reset();
        }
    });

    test('an edit during an in-flight save remains dirty and starts a second debounce cycle', async () => {
        const file = createFile('Notes/Redirtied.md');
        let harness!: Awaited<ReturnType<typeof createModifyHarness>>;
        let firstRun = true;
        harness = await createModifyHarness({
            debounceIntervalMs: 5_000,
            execute: async () => {
                if (firstRun) {
                    firstRun = false;
                    await harness.listeners.get('modify')!(file);
                }
                return { status: 'uploaded' };
            },
        });

        try {
            await harness.listeners.get('modify')!(file);
            await harness.debounceController.flushFile(file.path);

            assert.equal(harness.executions.length, 1);
            assert.equal(harness.debounceController.isPending(file.path), true);
            assert.equal(harness.dirtyFileManager.isDirty(file.path), true);

            await harness.debounceController.flushFile(file.path);
            assert.equal(harness.executions.length, 2);
            assert.equal(harness.dirtyFileManager.isDirty(file.path), false);
        } finally {
            harness.queueManager.destroy();
        }
    });
});

describe('Modify save preparation', () => {
    test('a file without a usable base prepares an initial snapshot', async () => {
        const path = 'Notes/Initial.md';
        const file = createFile(path);
        const harness = createSavePreparationHarness({
            files: new Map([[path, file]]),
            contents: new Map([[path, 'first version']]),
        });

        const result = await harness.preparer.prepare(modifyIntent(path, file));

        assert.equal(result.kind, 'ready');
        if (result.kind !== 'ready') return;
        assert.equal(result.upload.operation, 'save');
        if (result.upload.operation !== 'save') return;
        assert.equal(result.upload.objectPayload.type, 'snapshot');
        assert.equal(result.upload.objectPayload.parentHash, null);
        assert.equal(result.content, 'first version');
    });

    test('an unchanged automatic modify prepares no upload', async () => {
        const path = 'Notes/Unchanged.md';
        const file = createFile(path);
        const content = 'same content';
        const hash = await Hasher.computeHash(content);
        const harness = createSavePreparationHarness({
            files: new Map([[path, file]]),
            contents: new Map([[path, content]]),
        });
        harness.cache.set(path, { path, hash, baseText: content, diffDepth: 0, timestamp: 1234 });

        const result = await harness.preparer.prepare(modifyIntent(path, file));

        assert.deepEqual(result, { kind: 'unchanged', path });
    });

    test('a changed file with a valid cached base prepares a verified diff', async () => {
        const path = 'Notes/Changed.md';
        const file = createFile(path);
        const baseText = 'first\nold\nlast';
        const content = 'first\nnew\nlast';
        const parentHash = await Hasher.computeHash(baseText);
        const harness = createSavePreparationHarness({
            files: new Map([[path, file]]),
            contents: new Map([[path, content]]),
            diffComputer: { computeDiff: async (oldText, newText) => DiffEngine.createForwardDiff(oldText, newText) },
        });
        harness.cache.set(path, { path, hash: parentHash, baseText, diffDepth: 0, timestamp: 1000 });

        const result = await harness.preparer.prepare(modifyIntent(path, file));

        assert.equal(result.kind, 'ready');
        if (result.kind !== 'ready') return;
        assert.equal(result.upload.operation, 'save');
        if (result.upload.operation !== 'save') return;
        assert.equal(result.upload.objectPayload.type, 'diff');
        assert.equal(result.upload.objectPayload.parentHash, parentHash);
        assert.equal(result.newDiffDepth, 1);
    });

    test('a failed diff verification falls back to a snapshot', async (t: TestContext) => {
        const path = 'Notes/DiffFallback.md';
        const file = createFile(path);
        const baseText = 'before';
        const parentHash = await Hasher.computeHash(baseText);
        const harness = createSavePreparationHarness({
            files: new Map([[path, file]]),
            contents: new Map([[path, 'after']]),
            diffComputer: { computeDiff: async () => 'not a valid patch' },
        });
        harness.cache.set(path, { path, hash: parentHash, baseText, diffDepth: 0, timestamp: 1000 });

        t.mock.method(console, 'log', () => {});
        t.mock.method(console, 'warn', () => {});
        const result = await harness.preparer.prepare(modifyIntent(path, file));
        t.mock.reset();

        assert.equal(result.kind, 'ready');
        if (result.kind !== 'ready') return;
        assert.equal(result.upload.operation, 'save');
        if (result.upload.operation !== 'save') return;
        assert.equal(result.upload.objectPayload.type, 'snapshot');
    });

    test('a depth limit or configured snapshot-only size threshold forces a snapshot', async () => {
        const path = 'Notes/ForceSnapshot.md';
        const file = createFile(path);
        const baseText = 'old';
        const parentHash = await Hasher.computeHash(baseText);
        const content = 'new content';
        const cache = new RecentNotesCache();
        cache.set(path, {
            path,
            hash: parentHash,
            baseText,
            diffDepth: DEFAULT_SETTINGS.maxDiffsBetweenSnapshots,
            timestamp: 1000,
        });
        const harness = createSavePreparationHarness({
            files: new Map([[path, file]]),
            contents: new Map([[path, content]]),
            cache,
        });

        const depthResult = await harness.preparer.prepare(modifyIntent(path, file));
        assert.equal(depthResult.kind, 'ready');
        if (depthResult.kind === 'ready' && depthResult.upload.operation === 'save') {
            assert.equal(depthResult.upload.objectPayload.type, 'snapshot');
        }

        const smallPath = 'Notes/ConfiguredThreshold.md';
        const smallFile = createFile(smallPath);
        const smallCache = new RecentNotesCache();
        smallCache.set(smallPath, {
            path: smallPath,
            hash: parentHash,
            baseText,
            diffDepth: 0,
            timestamp: 1000,
        });
        const thresholdHarness = createSavePreparationHarness({
            files: new Map([[smallPath, smallFile]]),
            contents: new Map([[smallPath, content]]),
            cache: smallCache,
            settings: { maxFileSizeMb: 0.000001 },
        });
        const thresholdResult = await thresholdHarness.preparer.prepare(modifyIntent(smallPath, smallFile));
        assert.equal(thresholdResult.kind, 'ready');
        if (thresholdResult.kind === 'ready' && thresholdResult.upload.operation === 'save') {
            assert.equal(thresholdResult.upload.objectPayload.type, 'snapshot');
        }
    });

    test('remote base lookup failure still prepares a snapshot fallback', async () => {
        const path = 'Notes/RemoteUnavailable.md';
        const file = createFile(path);
        const harness = createSavePreparationHarness({
            files: new Map([[path, file]]),
            contents: new Map([[path, 'local version']]),
            getEntriesWithObjects: async () => { throw new Error('Remote unavailable'); },
        });

        const result = await harness.preparer.prepare(modifyIntent(path, file));

        assert.equal(result.kind, 'ready');
        if (result.kind !== 'ready' || result.upload.operation !== 'save') return;
        assert.equal(result.upload.objectPayload.type, 'snapshot');
    });

    test('missing files, newly unmonitored paths, and files above the size cap are skipped', async () => {
        const pdfPath = 'Notes/Attachment.pdf';
        const pdfFile = createFile(pdfPath);
        const tooLargePath = 'Notes/TooLarge.md';
        const tooLargeFile = createFile(tooLargePath);
        const harness = createSavePreparationHarness({
            files: new Map([[pdfPath, pdfFile], [tooLargePath, tooLargeFile]]),
            contents: new Map([
                [pdfPath, 'attachment'],
                [tooLargePath, 'x'.repeat(SnapshotPolicy.MAX_FILE_SIZE_BYTES + 1)],
            ]),
        });

        const missing = await harness.preparer.prepare(modifyIntent('Notes/Gone.md'));
        const unmonitored = await harness.preparer.prepare(modifyIntent(pdfPath, pdfFile));
        const tooLarge = await harness.preparer.prepare(modifyIntent(tooLargePath, tooLargeFile));

        assert.deepEqual(missing, { kind: 'skipped', path: 'Notes/Gone.md', reason: 'missing_file' });
        assert.deepEqual(unmonitored, { kind: 'skipped', path: pdfPath, reason: 'unmonitored_extension' });
        assert.deepEqual(tooLarge, { kind: 'skipped', path: tooLargePath, reason: 'size_limit_exceeded' });
    });
});
