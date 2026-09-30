import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Notice, TFile } from 'obsidian';
import { PayloadPreparer } from '../src/preparation/payload-preparer';
import { RecentNotesCache } from '../src/state/recent-notes-cache';
import { DiffEngine } from '../src/diff/diff-engine';
import { Hasher } from '../src/hashing/hasher';
import { DEFAULT_SETTINGS } from '../src/types/settings';
import type { EntriesWithObjectsViewRecord, LatestVaultFilesViewRecord } from '../src/types/database';
import {
    BASE_EXECUTION_POLICIES,
    SAVE_EXECUTION_POLICIES,
    type SaveIntent,
    type RenameIntent,
    type DeleteIntent,
} from '../src/operations/types';
import { saveExecutionPolicy, type PlannedSaveIntent } from './helpers/execution-policy-contract';

function createMockFile(path: string): TFile {
    const file = new TFile();
    file.path = path;
    file.name = path.split('/').pop() || path;
    file.basename = file.name.replace(/\.[^/.]+$/, '');
    file.extension = path.split('.').pop() || '';
    return file;
}

function setupTestEnvironment() {
    const diskFiles = new Map<string, TFile>();
    const fileContents = new Map<string, string>();
    const entriesMap = new Map<string, EntriesWithObjectsViewRecord[]>();
    const latestEntriesMap = new Map<string, any>();
    const entriesWithObjectsCalls = new Map<string, number>();
    const cache = new RecentNotesCache();

    const mockApp: any = {
        vault: {
            getAbstractFileByPath: (path: string) => diskFiles.get(path) || null,
            cachedRead: async (file: TFile) => fileContents.get(file.path) ?? '',
        },
    };

    const mockDeviceManager = {
        getVaultId: () => 'vault-test-1',
        getDevice: () => 'dev-test-1',
    };

    const mockStore: any = {
        getEntriesWithObjects: async (_vault: string, path: string) => {
            entriesWithObjectsCalls.set(path, (entriesWithObjectsCalls.get(path) ?? 0) + 1);
            return entriesMap.get(path) || [];
        },
        getLatestEntry: async (_vault: string, path: string) => latestEntriesMap.get(path) || null,
    };

    const mockDiffComputer = {
        computeDiff: async (oldText: string, newText: string, _size: number) => {
            return DiffEngine.createForwardDiff(oldText, newText);
        },
    };

    const mockReconstructionEngine = {
        reconstructVersion: async (_vault: string, _path: string, targetHash: string) => {
            return `reconstructed:${targetHash}`;
        },
    };

    const getSettings = () => ({
        ...DEFAULT_SETTINGS,
        monitoredExtensions: ['md', 'canvas'],
        maxDiffsBetweenSnapshots: 10,
        maxFileSizeMb: 10,
    });

    const preparer = new PayloadPreparer({
        vault: mockApp.vault,
        deviceManager: mockDeviceManager,
        cache,
        store: mockStore,
        diffComputer: mockDiffComputer,
        reconstructionEngine: mockReconstructionEngine,
        getSettings,
    });

    return {
        preparer,
        cache,
        diskFiles,
        fileContents,
        entriesMap,
        latestEntriesMap,
        entriesWithObjectsCalls,
    };
}

describe('Payload Preparer - skipped', () => {
test('PayloadPreparer returns skipped for missing file on disk', async () => {
    const { preparer } = setupTestEnvironment();

    const intent: SaveIntent = {
        id: 'task-1',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'Missing.md',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
    };

    const result = await preparer.prepare(intent);
    assert.deepEqual(result, {
        kind: 'skipped',
        path: 'Missing.md',
        reason: 'missing_file',
    });
});

test('PayloadPreparer returns skipped for unmonitored extension', async () => {
    const { preparer, diskFiles, fileContents } = setupTestEnvironment();
    const file = createMockFile('Image.png');
    diskFiles.set('Image.png', file);
    fileContents.set('Image.png', 'binary data');

    const intent: SaveIntent = {
        id: 'task-2',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'Image.png',
        file,
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
    };

    const result = await preparer.prepare(intent);
    assert.deepEqual(result, {
        kind: 'skipped',
        path: 'Image.png',
        reason: 'unmonitored_extension',
    });
});

test('PayloadPreparer returns skipped when file exceeds 10 MB limit', async () => {
    const { preparer, diskFiles, fileContents } = setupTestEnvironment();
    const file = createMockFile('Large.md');
    diskFiles.set('Large.md', file);
    // 11 MB string
    fileContents.set('Large.md', 'a'.repeat(11 * 1024 * 1024));

    const intent: SaveIntent = {
        id: 'task-3',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'Large.md',
        file,
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
    };

    (Notice as unknown as { clear(): void }).clear();
    const result = await preparer.prepare(intent);
    assert.deepEqual(result, {
        kind: 'skipped',
        path: 'Large.md',
        reason: 'size_limit_exceeded',
    });
    assert.deepEqual(
        (Notice as unknown as { messages: string[] }).messages,
        ['[OBPB Backup] Skipped Large.md: file exceeds 10 MB limit.']
    );
});
});

describe('Payload Preparer - unchanged', () => {
test('PayloadPreparer fast path: skips unchanged file using RecentNotesCache', async () => {
    const { preparer, diskFiles, fileContents, cache, entriesWithObjectsCalls } = setupTestEnvironment();
    const file = createMockFile('Note.md');
    diskFiles.set('Note.md', file);
    const content = '# Hello World';
    fileContents.set('Note.md', content);
    const hash = await Hasher.computeHash(content);

    // Warm cache with identical hash
    cache.set('Note.md', {
        path: 'Note.md',
        hash,
        baseText: content,
        diffDepth: 1,
        timestamp: 1000,
    });

    const intent: SaveIntent = {
        id: 'task-4',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'Note.md',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
    };

    const result = await preparer.prepare(intent);
    assert.deepEqual(result, {
        kind: 'unchanged',
        path: 'Note.md',
    });
    assert.equal(entriesWithObjectsCalls.get('Note.md') ?? 0, 0, 'cache hit must avoid a remote query');
});

test('PrepareSave follows policy.skipIfUnchanged when a batch event would previously force an upload', async () => {
    const { preparer, diskFiles, fileContents, cache } = setupTestEnvironment();
    const file = createMockFile('PolicySkip.md');
    const content = '# Same content';
    const contentHash = await Hasher.computeHash(content);
    diskFiles.set(file.path, file);
    fileContents.set(file.path, content);
    cache.set(file.path, {
        path: file.path,
        hash: contentHash,
        baseText: content,
        diffDepth: 0,
        timestamp: 100,
    });

    const intent: PlannedSaveIntent = {
        id: 'policy-skip-1',
        trigger: 'manual',
        event: 'vault-backup',
        operation: 'save',
        path: file.path,
        policy: saveExecutionPolicy({ skipIfUnchanged: true }),
    };

    const result = await preparer.prepare(intent);

    assert.deepEqual(result, { kind: 'unchanged', path: file.path });
});
});

describe('Payload Preparer - ready', () => {

test('PrepareSave follows policy.skipIfUnchanged=false when ordinary auto-save heuristics would skip', async () => {
    const { preparer, diskFiles, fileContents, cache } = setupTestEnvironment();
    const file = createMockFile('PolicyUpload.md');
    const content = '# Same content';
    const contentHash = await Hasher.computeHash(content);
    diskFiles.set(file.path, file);
    fileContents.set(file.path, content);
    cache.set(file.path, {
        path: file.path,
        hash: contentHash,
        baseText: content,
        diffDepth: 0,
        timestamp: 100,
    });

    const intent: PlannedSaveIntent = {
        id: 'policy-skip-2',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: file.path,
        mode: 'snapshot',
        policy: saveExecutionPolicy({ skipIfUnchanged: false }),
    };

    const result = await preparer.prepare(intent);

    assert.equal(result.kind, 'ready');
});

test('PayloadPreparer fast path: generates diff payload using RecentNotesCache baseText', async () => {
    const { preparer, diskFiles, fileContents, cache } = setupTestEnvironment();
    const file = createMockFile('Note.md');
    diskFiles.set('Note.md', file);

    const oldContent = '# Version 1';
    const newContent = '# Version 2\nAdditional line';
    fileContents.set('Note.md', newContent);
    const oldHash = await Hasher.computeHash(oldContent);
    const newHash = await Hasher.computeHash(newContent);

    // Warm cache with old version
    cache.set('Note.md', {
        path: 'Note.md',
        hash: oldHash,
        baseText: oldContent,
        diffDepth: 2,
        timestamp: 2000,
    });

    const intent: SaveIntent = {
        id: 'task-5',
        trigger: 'auto',
        event: 'modify',
        operation: 'save',
        path: 'Note.md',
        policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
    };

    const result = await preparer.prepare(intent);
    assert.equal(result.kind, 'ready');
    if (result.kind === 'ready') {
        assert.equal(result.upload.operation, 'save');
        assert.equal(result.upload.targetHash, newHash);
        assert.equal(result.upload.objectPayload.type, 'diff');
        assert.equal(result.upload.objectPayload.parentHash, oldHash);
        assert.equal(result.newDiffDepth, 3);
        assert.equal(result.content, newContent);
    }
});

test('PayloadPreparer handles scoped bulkRemoteMap during vault sync and falls back on miss', async () => {
    const { preparer, diskFiles, fileContents, entriesMap, entriesWithObjectsCalls } = setupTestEnvironment();
    const fileA = createMockFile('DocA.md');
    const fileB = createMockFile('DocB.md');
    diskFiles.set('DocA.md', fileA);
    diskFiles.set('DocB.md', fileB);

    fileContents.set('DocA.md', 'Content A');
    fileContents.set('DocB.md', 'Content B');

    const hashA = await Hasher.computeHash('Content A');
    const hashB = await Hasher.computeHash('Content B');
    const remoteHashB = await Hasher.computeHash('Previous content');

    const bulkMap = new Map<string, LatestVaultFilesViewRecord>([
        ['DocA.md', {
            id: 'e1',
            vault: 'vault-test-1',
            path: 'DocA.md',
            operation: 'save',
            timestamp: 3000,
            hash: hashA,
            objectId: 'obj-1',
        }],
    ]);
    entriesMap.set('DocB.md', [{
        id: 'e2',
        vault: 'vault-test-1',
        path: 'DocB.md',
        oldPath: null,
        operation: 'save',
        device: 'dev-test-1',
        timestamp: 2000,
        hash: remoteHashB,
        parentHash: null,
        type: 'snapshot',
        data: 'Previous content',
        dataHash: 'unused-in-test',
        diffFormat: null,
        size: 16,
    }]);

    // 1. DocA is in bulkMap with identical hash -> unchanged
    const resultA = await preparer.prepare({
        id: 'sync-1',
        trigger: 'manual',
        event: 'vault-sync',
        operation: 'save',
        path: 'DocA.md',
        policy: SAVE_EXECUTION_POLICIES.BATCH_SYNC,
    }, { bulkRemoteMap: bulkMap });
    assert.deepEqual(resultA, { kind: 'unchanged', path: 'DocA.md' });
    assert.equal(entriesWithObjectsCalls.get('DocA.md') ?? 0, 0, 'bulk hit must avoid a cold-path query');

    // 2. DocB is absent from bulkMap -> falls back to cold-path query and uses its resolved base.
    const resultB = await preparer.prepare({
        id: 'sync-2',
        trigger: 'manual',
        event: 'vault-sync',
        operation: 'save',
        path: 'DocB.md',
        policy: SAVE_EXECUTION_POLICIES.BATCH_SYNC,
    }, { bulkRemoteMap: bulkMap });

    assert.equal(resultB.kind, 'ready');
    if (resultB.kind === 'ready' && resultB.upload.operation === 'save') {
        assert.equal(resultB.upload.targetHash, hashB);
        assert.equal(resultB.upload.objectPayload.type, 'diff');
        assert.equal(resultB.upload.objectPayload.parentHash, remoteHashB);
    }
    assert.equal(entriesWithObjectsCalls.get('DocB.md'), 1, 'bulk miss must query the individual cold path');
});

test('PayloadPreparer bypasses RecentNotesCache when the scoped context disables it', async () => {
    const { preparer, diskFiles, fileContents, cache, entriesMap, entriesWithObjectsCalls } = setupTestEnvironment();
    const file = createMockFile('ColdOnly.md');
    const content = '# Cached content';
    const cachedHash = await Hasher.computeHash(content);
    const remoteHash = await Hasher.computeHash('# Remote content');
    diskFiles.set(file.path, file);
    fileContents.set(file.path, content);
    cache.set(file.path, {
        path: file.path,
        hash: cachedHash,
        baseText: content,
        diffDepth: 0,
        timestamp: 1000,
    });
    entriesMap.set(file.path, [{
        id: 'remote-cold-only',
        vault: 'vault-test-1',
        path: file.path,
        oldPath: null,
        operation: 'save',
        device: 'dev-test-1',
        timestamp: 2000,
        hash: remoteHash,
        parentHash: null,
        type: 'snapshot',
        data: '# Remote content',
        dataHash: 'unused-in-test',
        diffFormat: null,
        size: 16,
    }]);

    const result = await preparer.prepare({
        id: 'cold-only-1',
        trigger: 'manual',
        event: 'vault-sync',
        operation: 'save',
        path: file.path,
        policy: SAVE_EXECUTION_POLICIES.BATCH_SYNC,
    }, { disableRecentNotesCache: true });

    assert.equal(result.kind, 'ready');
    assert.equal(entriesWithObjectsCalls.get(file.path), 1, 'disabled cache must use the cold path');
});

test('PayloadPreparer rename resolution: transfers cache continuity and builds PreparedRenameUpload', async () => {
    const { preparer, diskFiles, fileContents, cache } = setupTestEnvironment();
    const newFile = createMockFile('Renamed.md');
    diskFiles.set('Renamed.md', newFile);
    fileContents.set('Renamed.md', '# Same content');
    const contentHash = await Hasher.computeHash('# Same content');

    // oldPath was in cache
    cache.set('Original.md', {
        path: 'Original.md',
        hash: contentHash,
        baseText: '# Same content',
        diffDepth: 4,
        timestamp: 5000,
    });

    const intent: RenameIntent = {
        id: 'ren-task-1',
        trigger: 'auto',
        event: 'rename',
        operation: 'rename',
        path: 'Renamed.md',
        oldPath: 'Original.md',
        policy: BASE_EXECUTION_POLICIES.AUTO,
    };

    const result = await preparer.prepare(intent);
    assert.equal(result.kind, 'ready');
    if (result.kind === 'ready') {
        assert.equal(result.upload.operation, 'rename');
        assert.equal(result.upload.path, 'Renamed.md');
        assert.equal(result.upload.oldPath, 'Original.md');
        assert.equal(result.upload.targetHash, contentHash);
        assert.ok(result.upload.deleteTimestamp > 5000);
        assert.ok(result.upload.timestamp > result.upload.deleteTimestamp);
        assert.equal(result.content, '# Same content');
        assert.equal(result.newDiffDepth, 4);
    }
});

test('PayloadPreparer rename resolution: degrades cleanly to snapshot when source is untracked', async () => {
    const { preparer, diskFiles, fileContents } = setupTestEnvironment();
    const newFile = createMockFile('UntrackedNew.md');
    diskFiles.set('UntrackedNew.md', newFile);
    fileContents.set('UntrackedNew.md', '# Fresh');

    const intent: RenameIntent = {
        id: 'ren-task-2',
        trigger: 'auto',
        event: 'rename',
        operation: 'rename',
        path: 'UntrackedNew.md',
        oldPath: 'NeverTrackedOld.md',
        policy: BASE_EXECUTION_POLICIES.AUTO,
    };

    const result = await preparer.prepare(intent);
    assert.equal(result.kind, 'ready');
    if (result.kind === 'ready') {
        assert.equal(result.upload.operation, 'save');
        assert.equal(result.upload.path, 'UntrackedNew.md');
        assert.equal(result.upload.objectPayload.type, 'snapshot');
        assert.equal(result.upload.objectPayload.parentHash, null);
    }
});

test('PayloadPreparer delete resolution: skips untracked deletions and prepares tracked deletions', async () => {
    const { preparer, latestEntriesMap } = setupTestEnvironment();

    // 1. Untracked file -> skipped
    const untrackedIntent: DeleteIntent = {
        id: 'del-1',
        trigger: 'auto',
        event: 'delete',
        operation: 'delete',
        path: 'Untracked.md',
        policy: BASE_EXECUTION_POLICIES.AUTO,
    };
    const result1 = await preparer.prepare(untrackedIntent);
    assert.deepEqual(result1, {
        kind: 'skipped',
        path: 'Untracked.md',
        reason: 'untracked_deletion',
    });

    // 2. Tracked remote file -> ready PreparedDeleteUpload
    latestEntriesMap.set('Tracked.md', {
        id: 'e-track',
        vault: 'vault-test-1',
        path: 'Tracked.md',
        hash: 'sha256:trackedhash',
        operation: 'save',
        timestamp: 8000,
    });

    const trackedIntent: DeleteIntent = {
        id: 'del-2',
        trigger: 'auto',
        event: 'delete',
        operation: 'delete',
        path: 'Tracked.md',
        policy: BASE_EXECUTION_POLICIES.AUTO,
    };
    const result2 = await preparer.prepare(trackedIntent);
    assert.equal(result2.kind, 'ready');
    if (result2.kind === 'ready') {
        assert.equal(result2.upload.operation, 'delete');
        assert.equal(result2.upload.path, 'Tracked.md');
        assert.equal(result2.upload.targetHash, 'sha256:trackedhash');
        assert.ok(result2.upload.timestamp > 8000);
    }
});
});
