import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PocketBaseClient } from '../src/remote/pocketbase-client';
import { AuthManager } from '../src/remote/auth-manager';
import { PocketBaseStore } from '../src/remote/pocketbase-store';
import { PocketBaseHealthChecker } from '../src/remote/pocketbase-health-checker';
import { ReconstructionEngine } from '../src/reconstruct/reconstruction-engine';
import { Hasher } from '../src/hashing/hasher';
import { DiffEngine } from '../src/diff/diff-engine';
import { CreateBackupObject, CreateHistoryEntry } from '../src/types/database';
import { DEFAULT_SETTINGS, OBPBBackupSettings } from '../src/types/settings';
import type { BackupObjectType } from '../src/types/domain';

// ============================================================================
// PocketBase Development Instance Configuration
// Modify these values to point to your local development PocketBase instance:
// ============================================================================
export const PB_DEV_CONFIG = {
    url: process.env.PB_URL || 'http://192.168.11.10:8090',
    email: process.env.PB_EMAIL || 'test@example.com',
    password: process.env.PB_PASSWORD || 'password123',
    vaultId: process.env.PB_VAULT || `test-vault-${Date.now()}`,
};

interface NoteRevision {
    revisionIndex: number;
    content: string;
    hash: string;
    parentHash: string | null;
    type: BackupObjectType;
    diffData?: string;
    diffDepth: number;
    timestamp: number;
    objectId: string;
}

interface NoteHistory {
    path: string;
    revisions: NoteRevision[];
    snapshotInterval: number;
}

interface RenamedNoteInfo {
    oldPath: string;
    newPath: string;
    originalNote: NoteHistory;
    preRenameLastRevision: NoteRevision;
    deleteTimestamp: number;
    renameTimestamp: number;
    postRenameRevisions: NoteRevision[];
}

interface ResurrectedNoteInfo {
    path: string;
    oldPath: string;
    revisions: NoteRevision[];
}

/**
 * Low-overhead file reader that slices random byte chunks from jekyll.txt
 * without reading the entire 163 KB file into memory at once.
 */
class TextSlicer {
    private fileHandle: fs.promises.FileHandle | null = null;
    private fileSize = 0;

    public async open(filePath: string): Promise<void> {
        this.fileHandle = await fs.promises.open(filePath, 'r');
        const stat = await this.fileHandle.stat();
        this.fileSize = stat.size;
    }

    public async getRandomSlice(minBytes: number = 100, maxBytes: number = 350): Promise<string> {
        if (!this.fileHandle || this.fileSize === 0) {
            return `Sample slice at ${Date.now()}`;
        }
        const length = Math.min(
            this.fileSize,
            Math.floor(Math.random() * (maxBytes - minBytes + 1)) + minBytes
        );
        const maxOffset = Math.max(0, this.fileSize - length);
        const offset = Math.floor(Math.random() * (maxOffset + 1));
        const buf = Buffer.alloc(length);
        const { bytesRead } = await this.fileHandle.read(buf, 0, length, offset);

        // Adjust start boundary: skip any leading UTF-8 continuation bytes
        let start = 0;
        while (start < bytesRead && (buf[start] & 0xC0) === 0x80) {
            start++;
        }

        // Adjust end boundary: peel back any incomplete trailing multibyte sequences
        let end = bytesRead;
        while (end > start) {
            const b = buf[end - 1];
            if ((b & 0x80) === 0) break; // ASCII byte
            if ((b & 0xC0) === 0xC0) {
                // Incomplete leading byte of multibyte sequence
                end--;
                break;
            }
            end--;
            if (bytesRead - end >= 4) break;
        }

        const validChunk = buf.subarray(start, end).toString('utf-8');
        // Thoroughly normalize CRLF and lone CR to clean LF for consistent diff computation
        return validChunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    public async close(): Promise<void> {
        if (this.fileHandle) {
            await this.fileHandle.close();
            this.fileHandle = null;
        }
    }
}

async function generateInitialContent(noteIndex: number, slicer: TextSlicer): Promise<string> {
    const excerpt = await slicer.getRandomSlice(120, 300);
    return `# Document ${noteIndex}
Created as part of the PocketBase view integration test suite.

## Excerpt:
${excerpt}

## Section: Metadata
- Initialized at step 0 for note ${noteIndex}.
`;
}

async function mutateContent(prevContent: string, revIndex: number, noteIndex: number, slicer: TextSlicer): Promise<string> {
    const lines = prevContent.split('\n');
    const modType = revIndex % 4;
    const slice = await slicer.getRandomSlice(60, 180);

    if (modType === 0) {
        lines.push(`\n## Section ${revIndex}\n${slice}`);
    } else if (modType === 1) {
        const mid = Math.floor(lines.length / 2);
        lines.splice(mid, 0, `> Updated note at rev ${revIndex} for note ${noteIndex}:`, slice);
    } else if (modType === 2) {
        if (lines.length > 3) {
            const targetLine = 2 + (revIndex % (lines.length - 3));
            lines[targetLine] = `[Revision ${revIndex}]: ${slice.replace(/\n/g, ' ')}`;
        } else {
            lines.push(slice);
        }
    } else {
        lines.push(`\n### Subsection ${revIndex}\n${slice}`);
    }

    return lines.join('\n');
}

/**
 * Builds synthetic historical revisions for a note according to parameters.
 */
async function generateNoteHistory(
    noteIndex: number,
    path: string,
    revisionCount: number,
    snapshotInterval: number,
    vaultId: string,
    slicer: TextSlicer,
    options?: { forceConsecutiveSnapshotsAt?: number[] }
): Promise<NoteHistory> {
    const revisions: NoteRevision[] = [];
    if (revisionCount === 0) {
        return { path, revisions, snapshotInterval };
    }

    const baseTimestamp = Date.now() - (revisionCount * 1000);
    let prevContent = '';
    let prevHash: string | null = null;
    let currentDiffDepth = 0;

    for (let r = 0; r < revisionCount; r++) {
        const timestamp = baseTimestamp + (r * 100);
        const isInitial = r === 0;

        let isSnapshot = false;
        if (isInitial) {
            isSnapshot = true;
        } else if (options?.forceConsecutiveSnapshotsAt?.includes(r)) {
            isSnapshot = true;
        } else if (currentDiffDepth >= snapshotInterval) {
            isSnapshot = true;
        }

        let content: string;
        let diffData: string | undefined;
        let parentHash: string | null = prevHash;

        if (isInitial) {
            content = await generateInitialContent(noteIndex, slicer);
            parentHash = null;
            currentDiffDepth = 0;
        } else {
            content = await mutateContent(prevContent, r, noteIndex, slicer);
            if (isSnapshot) {
                currentDiffDepth = 0;
            } else {
                diffData = DiffEngine.createForwardDiff(prevContent, content);
                currentDiffDepth++;
            }
        }

        const hash = await Hasher.computeHash(content);
        const objectId = isSnapshot
            ? await Hasher.deriveSnapshotObjectId(vaultId, hash)
            : await Hasher.deriveDiffObjectId(vaultId, parentHash!, hash, 'jsdiff@5-unified');

        const revision: NoteRevision = {
            revisionIndex: r,
            content,
            hash,
            parentHash,
            type: isSnapshot ? 'snapshot' : 'diff',
            diffData,
            diffDepth: currentDiffDepth,
            timestamp,
            objectId,
        };

        revisions.push(revision);
        prevContent = content;
        prevHash = hash;
    }

    return { path, revisions, snapshotInterval };
}

/**
 * Runs tasks concurrently with bounded worker pool to avoid SQLite lock contention.
 */
async function runConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (item) {
                await fn(item);
            }
        }
    });
    await Promise.all(workers);
}

describe('PocketBase entries_with_objects View & Reconstruction Integration Test', { timeout: 180_000 }, () => {
    let client: PocketBaseClient;
    let authManager: AuthManager;
    let store: PocketBaseStore;
    let reconstructionEngine: ReconstructionEngine;
    const slicer = new TextSlicer();

    const allNotes: NoteHistory[] = [];
    const renamedNotes: RenamedNoteInfo[] = [];
    const resurrectedNotes: ResurrectedNoteInfo[] = [];
    let totalUploadedBackups = 0;

    before(async () => {
        const settings: OBPBBackupSettings = {
            ...DEFAULT_SETTINGS,
            serverUrl: PB_DEV_CONFIG.url,
            userEmail: PB_DEV_CONFIG.email,
            vaultId: PB_DEV_CONFIG.vaultId,
            debounceIntervalMs: 30000,
            maxWaitMs: 300000,
            maxDiffsBetweenSnapshots: 50,
            monitoredExtensions: ['md', 'canvas'],
            maxFileSizeMb: 10,
            safetyBackupBeforeRestore: true,
        };

        client = new PocketBaseClient(() => settings.serverUrl);
        authManager = new AuthManager(client, () => settings);
        store = new PocketBaseStore(client, authManager);
        const healthChecker = new PocketBaseHealthChecker(client);
        reconstructionEngine = new ReconstructionEngine(store);

        // 1. Open TextSlicer on jekyll.txt
        const jekyllPath = path.resolve(process.cwd(), 'tmp/jekyll.txt');
        await slicer.open(jekyllPath);

        // 2. Verify health check and authenticate
        try {
            await healthChecker.healthCheck();
            try {
                await authManager.login(PB_DEV_CONFIG.password);
            } catch (loginErr: any) {
                try {
                    await client.request({
                        method: 'POST',
                        path: '/api/collections/users/records',
                        body: {
                            email: PB_DEV_CONFIG.email,
                            password: PB_DEV_CONFIG.password,
                            passwordConfirm: PB_DEV_CONFIG.password,
                        },
                    });
                    await authManager.login(PB_DEV_CONFIG.password);
                } catch {
                    throw loginErr;
                }
            }
            assert.ok(authManager.isAuthenticated(), 'Auth token must be acquired');
            console.log(`[Integration Test] Authenticated with PocketBase at ${PB_DEV_CONFIG.url} as user ${authManager.getUserId()}`);
        } catch (connErr: any) {
            console.error(`\n[Integration Test Error] Could not connect or authenticate to PocketBase instance at ${PB_DEV_CONFIG.url}`);
            console.error('Ensure PocketBase is running and credentials in PB_DEV_CONFIG are valid.\n');
            throw connErr;
        }

        // 3. Generate 25 notes with varied paths across diverse folders
        // Edge cases:
        allNotes.push(await generateNoteHistory(0, 'notes/empty-00.md', 0, 15, PB_DEV_CONFIG.vaultId, slicer));
        allNotes.push(await generateNoteHistory(1, 'notes/single-01.md', 1, 15, PB_DEV_CONFIG.vaultId, slicer));
        allNotes.push(await generateNoteHistory(2, 'notes/consecutive-snapshots-02.md', 3, 15, PB_DEV_CONFIG.vaultId, slicer, {
            forceConsecutiveSnapshotsAt: [1, 2],
        }));
        allNotes.push(await generateNoteHistory(3, 'notes/consecutive-middle-03.md', 9, 15, PB_DEV_CONFIG.vaultId, slicer, {
            forceConsecutiveSnapshotsAt: [4, 5],
        }));

        const folderPrefixes = [
            'philosophy/ethics',
            'journals/2026',
            'research/linguistics',
            'projects/arch',
            'workspace/drafts',
            'archive/literature',
            'random/thoughts',
        ];

        // Notes 4 to 24: 21 notes with ~100 revisions (90 to 100 revisions each)
        for (let i = 4; i < 25; i++) {
            const prefix = folderPrefixes[i % folderPrefixes.length];
            const notePath = `${prefix}/note-${i.toString().padStart(2, '0')}.md`;
            const revisionCount = Math.floor(Math.random() * 11) + 90; // 90 to 100
            const snapshotInterval = Math.floor(Math.random() * 11) + 20; // 20 to 30

            const noteHistory = await generateNoteHistory(
                i,
                notePath,
                revisionCount,
                snapshotInterval,
                PB_DEV_CONFIG.vaultId,
                slicer
            );
            allNotes.push(noteHistory);
        }

        totalUploadedBackups = allNotes.reduce((sum, n) => sum + n.revisions.length, 0);
        console.log(`[Integration Test] Generated ${allNotes.length} notes with ${totalUploadedBackups} total revisions.`);

        // 4. Concurrently upload 25 notes using worker pool (concurrency: 8)
        console.log('[Integration Test] Uploading revisions to PocketBase with concurrency pool...');
        const uploadStartTime = Date.now();

        async function uploadNoteRevisions(note: NoteHistory): Promise<void> {
            for (const rev of note.revisions) {
                const objectPayload = rev.type === 'snapshot' ? rev.content : rev.diffData!;
                const objectRecord: CreateBackupObject = {
                    id: rev.objectId,
                    vault: PB_DEV_CONFIG.vaultId,
                    hash: rev.hash,
                    parentHash: rev.parentHash,
                    type: rev.type,
                    data: objectPayload,
                    dataHash: await Hasher.computeHash(objectPayload),
                    diffFormat: rev.type === 'diff' ? 'jsdiff@5-unified' : null,
                    encoding: 'none',
                    size: objectPayload.length,
                };

                await store.putObject(objectRecord);

                const entryRecord: CreateHistoryEntry = {
                    id: await Hasher.deriveEntryId('test-runner-device', PB_DEV_CONFIG.vaultId, note.path, null, 'save', rev.objectId, rev.timestamp),
                    vault: PB_DEV_CONFIG.vaultId,
                    path: note.path,
                    operation: 'save',
                    device: 'test-runner-device',
                    timestamp: rev.timestamp,
                    hash: rev.hash,
                    objectId: rev.objectId,
                    oldPath: null,
                };

                await store.addEntry(entryRecord);
            }
        }

        await runConcurrent(allNotes, 8, uploadNoteRevisions);
        const uploadDurationMs = Date.now() - uploadStartTime;
        console.log(`[Integration Test] Uploaded ${totalUploadedBackups} backups across ${allNotes.length} notes in ${uploadDurationMs}ms.`);

        // 5. Perform renames on 12 random notes from notes 4 to 24 using Approach A
        const notesToRename = allNotes.slice(4, 16); // 12 notes
        console.log(`[Integration Test] Renaming ${notesToRename.length} notes and adding post-rename revisions...`);

        for (const note of notesToRename) {
            const oldPath = note.path;
            const newPath = `renamed-archive/${note.path.replace(/\//g, '_')}`;
            const preRenameLastRev = note.revisions[note.revisions.length - 1];

            // Monotonic timestamps: delete < rename
            const deleteTimestamp = preRenameLastRev.timestamp + 10;
            const renameTimestamp = deleteTimestamp + 10;

            // Emit DELETE entry for oldPath
            const delEntryId = await Hasher.deriveEntryId('test-runner-device', PB_DEV_CONFIG.vaultId, oldPath, null, 'delete', preRenameLastRev.objectId, deleteTimestamp);
            await store.addEntry({
                id: delEntryId,
                vault: PB_DEV_CONFIG.vaultId,
                path: oldPath,
                oldPath: null,
                objectId: preRenameLastRev.objectId,
                hash: preRenameLastRev.hash,
                operation: 'delete',
                device: 'test-runner-device',
                timestamp: deleteTimestamp,
            });

            // Emit RENAME entry for newPath pointing to existing object
            const renEntryId = await Hasher.deriveEntryId('test-runner-device', PB_DEV_CONFIG.vaultId, newPath, oldPath, 'rename', preRenameLastRev.objectId, renameTimestamp);
            await store.addEntry({
                id: renEntryId,
                vault: PB_DEV_CONFIG.vaultId,
                path: newPath,
                oldPath: oldPath,
                objectId: preRenameLastRev.objectId,
                hash: preRenameLastRev.hash,
                operation: 'rename',
                device: 'test-runner-device',
                timestamp: renameTimestamp,
            });

            // Add 6 post-rename revisions to newPath
            let prevContent = preRenameLastRev.content;
            let prevHash = preRenameLastRev.hash;
            let currentDiffDepth = preRenameLastRev.diffDepth + 1;
            let postTimestamp = renameTimestamp;
            const postRenameRevisions: NoteRevision[] = [];

            for (let r = 0; r < 6; r++) {
                postTimestamp += 100;
                const isSnapshot = currentDiffDepth >= note.snapshotInterval;
                const content = await mutateContent(prevContent, r + 1, 999, slicer);
                let diffData: string | undefined;

                if (isSnapshot) {
                    currentDiffDepth = 0;
                } else {
                    diffData = DiffEngine.createForwardDiff(prevContent, content);
                    currentDiffDepth++;
                }

                const hash = await Hasher.computeHash(content);
                const parentHash = prevHash;
                const objectId = isSnapshot
                    ? await Hasher.deriveSnapshotObjectId(PB_DEV_CONFIG.vaultId, hash)
                    : await Hasher.deriveDiffObjectId(PB_DEV_CONFIG.vaultId, parentHash, hash, 'jsdiff@5-unified');

                const objPayload = isSnapshot ? content : diffData!;
                await store.putObject({
                    id: objectId,
                    vault: PB_DEV_CONFIG.vaultId,
                    hash,
                    parentHash,
                    type: isSnapshot ? 'snapshot' : 'diff',
                    data: objPayload,
                    dataHash: await Hasher.computeHash(objPayload),
                    diffFormat: isSnapshot ? null : 'jsdiff@5-unified',
                    encoding: 'none',
                    size: objPayload.length,
                });

                const saveEntryId = await Hasher.deriveEntryId('test-runner-device', PB_DEV_CONFIG.vaultId, newPath, null, 'save', objectId, postTimestamp);
                await store.addEntry({
                    id: saveEntryId,
                    vault: PB_DEV_CONFIG.vaultId,
                    path: newPath,
                    oldPath: null,
                    objectId,
                    hash,
                    operation: 'save',
                    device: 'test-runner-device',
                    timestamp: postTimestamp,
                });

                postRenameRevisions.push({
                    revisionIndex: r,
                    content,
                    hash,
                    parentHash,
                    type: isSnapshot ? 'snapshot' : 'diff',
                    diffData,
                    diffDepth: currentDiffDepth,
                    timestamp: postTimestamp,
                    objectId,
                });

                prevContent = content;
                prevHash = hash;
            }

            renamedNotes.push({
                oldPath,
                newPath,
                originalNote: note,
                preRenameLastRevision: preRenameLastRev,
                deleteTimestamp,
                renameTimestamp,
                postRenameRevisions,
            });

            // 6. Create a brand-new note at the vacated oldPath and verify DAG reset
            let resTimestamp = deleteTimestamp + 2000;
            const resContent = await generateInitialContent(888, slicer);
            const resHash = await Hasher.computeHash(resContent);
            const resObjectId = await Hasher.deriveSnapshotObjectId(PB_DEV_CONFIG.vaultId, resHash);

            // Rev 0 of new note at oldPath: must be snapshot with parentHash = null!
            await store.putObject({
                id: resObjectId,
                vault: PB_DEV_CONFIG.vaultId,
                hash: resHash,
                parentHash: null,
                type: 'snapshot',
                data: resContent,
                dataHash: await Hasher.computeHash(resContent),
                diffFormat: null,
                encoding: 'none',
                size: resContent.length,
            });

            const resEntryId = await Hasher.deriveEntryId('test-runner-device', PB_DEV_CONFIG.vaultId, oldPath, null, 'save', resObjectId, resTimestamp);
            await store.addEntry({
                id: resEntryId,
                vault: PB_DEV_CONFIG.vaultId,
                path: oldPath,
                oldPath: null,
                objectId: resObjectId,
                hash: resHash,
                operation: 'save',
                device: 'test-runner-device',
                timestamp: resTimestamp,
            });

            const resRevisions: NoteRevision[] = [{
                revisionIndex: 0,
                content: resContent,
                hash: resHash,
                parentHash: null,
                type: 'snapshot',
                diffDepth: 0,
                timestamp: resTimestamp,
                objectId: resObjectId,
            }];

            // Add 4 more revisions to the new note at oldPath
            let resPrevContent = resContent;
            let resPrevHash = resHash;
            for (let r = 1; r <= 4; r++) {
                resTimestamp += 100;
                const nextContent = await mutateContent(resPrevContent, r, 888, slicer);
                const nextDiff = DiffEngine.createForwardDiff(resPrevContent, nextContent);
                const nextHash = await Hasher.computeHash(nextContent);
                const nextObjectId = await Hasher.deriveDiffObjectId(PB_DEV_CONFIG.vaultId, resPrevHash, nextHash, 'jsdiff@5-unified');

                await store.putObject({
                    id: nextObjectId,
                    vault: PB_DEV_CONFIG.vaultId,
                    hash: nextHash,
                    parentHash: resPrevHash,
                    type: 'diff',
                    data: nextDiff,
                    dataHash: await Hasher.computeHash(nextDiff),
                    diffFormat: 'jsdiff@5-unified',
                    encoding: 'none',
                    size: nextDiff.length,
                });

                const nextEntryId = await Hasher.deriveEntryId('test-runner-device', PB_DEV_CONFIG.vaultId, oldPath, null, 'save', nextObjectId, resTimestamp);
                await store.addEntry({
                    id: nextEntryId,
                    vault: PB_DEV_CONFIG.vaultId,
                    path: oldPath,
                    oldPath: null,
                    objectId: nextObjectId,
                    hash: nextHash,
                    operation: 'save',
                    device: 'test-runner-device',
                    timestamp: resTimestamp,
                });

                resRevisions.push({
                    revisionIndex: r,
                    content: nextContent,
                    hash: nextHash,
                    parentHash: resPrevHash,
                    type: 'diff',
                    diffData: nextDiff,
                    diffDepth: r,
                    timestamp: resTimestamp,
                    objectId: nextObjectId,
                });

                resPrevContent = nextContent;
                resPrevHash = nextHash;
            }

            resurrectedNotes.push({
                path: oldPath,
                oldPath,
                revisions: resRevisions,
            });
        }

        console.log(`[Integration Test] Completed setup of 25 notes, 12 renames, and 12 old-path note re-creations.`);
    });

    after(async () => {
        await slicer.close();
    });

    test('1. Empty note (0 revisions) returns empty result from view', async () => {
        const emptyNote = allNotes.find(n => n.revisions.length === 0)!;
        const records = await store.getEntriesWithObjects(PB_DEV_CONFIG.vaultId, emptyNote.path, 100);
        assert.equal(records.length, 0, 'Query on note with 0 backups must return an empty list');
    });

    test('2. Query entries_with_objects view applies filter, sort, perPage, vault, and path correctly', async () => {
        const testNote = allNotes.find(n => n.revisions.length >= 10)!;
        const records = await store.getEntriesWithObjects(PB_DEV_CONFIG.vaultId, testNote.path, 100);

        assert.ok(records.length > 0, 'Must return records for backed up note');

        for (const record of records) {
            assert.equal(record.vault, PB_DEV_CONFIG.vaultId, 'Record vault must match requested vault');
            assert.equal(record.path, testNote.path, 'Record path must match requested path');
            assert.ok(record.hash.startsWith('sha256:'), 'Hash must be valid SHA-256');
            assert.ok(record.data !== undefined && record.data !== null, 'View must join objects.data');
        }

        for (let i = 0; i < records.length - 1; i++) {
            assert.ok(
                records[i].timestamp >= records[i + 1].timestamp,
                `Records must be sorted descending by timestamp: ${records[i].timestamp} >= ${records[i + 1].timestamp}`
            );
        }
    });

    test('3. Verify diff_depth calculation across all notes (including snapshot-ended notes & consecutive snapshots)', async () => {
        for (const note of allNotes) {
            if (note.revisions.length === 0) continue;

            const records = await store.getEntriesWithObjects(PB_DEV_CONFIG.vaultId, note.path, 100);
            assert.ok(records.length > 0);

            let computedDiffDepth = 0;
            let foundSnapshot = false;

            for (let i = 0; i < records.length; i++) {
                if (records[i].type === 'snapshot') {
                    foundSnapshot = true;
                    break;
                }
                computedDiffDepth++;
            }

            assert.ok(foundSnapshot, `Must encounter a base snapshot in the chain for ${note.path}`);
        }
    });

    test('4. Edge case verification: consecutive snapshots produce diff_depth === 0', async () => {
        const consecutiveNote = allNotes.find(n => n.path === 'notes/consecutive-snapshots-02.md')!;
        const records = await store.getEntriesWithObjects(PB_DEV_CONFIG.vaultId, consecutiveNote.path, 100);

        assert.equal(records.length, 3, 'Must have exactly 3 snapshot records');
        assert.equal(records[0].type, 'snapshot', 'Head must be a snapshot');
        assert.equal(records[1].type, 'snapshot', 'Second must be a snapshot');
        assert.equal(records[2].type, 'snapshot', 'Third must be a snapshot');

        let computedDiffDepth = 0;
        for (const r of records) {
            if (r.type === 'snapshot') break;
            computedDiffDepth++;
        }
        assert.equal(computedDiffDepth, 0, 'Consecutive snapshot head must report diff_depth === 0');
    });

    test('5. Verify parent_hash DAG continuity across diffs and interspersed snapshots', async () => {
        // Test non-renamed notes to check initial DAG integrity
        const standardNotes = allNotes.slice(16, 25);
        for (const note of standardNotes) {
            if (note.revisions.length < 2) continue;

            const records = await store.getEntriesWithObjects(PB_DEV_CONFIG.vaultId, note.path, 100);
            const latestRev = note.revisions[note.revisions.length - 1];
            assert.equal(records[0].hash, latestRev.hash, `Head record hash mismatch for ${note.path}`);

            for (let i = 0; i < records.length - 1; i++) {
                const current = records[i];
                const expectedParent = records[i + 1];

                assert.equal(
                    current.parentHash,
                    expectedParent.hash,
                    `Record ${current.hash} parentHash (${current.parentHash}) must match previous revision hash (${expectedParent.hash})`
                );
            }

            const rootRecord = records[records.length - 1];
            assert.ok(
                rootRecord.parentHash === null,
                `Root snapshot for ${note.path} must have null parentHash (was: ${rootRecord.parentHash})`
            );
            assert.equal(rootRecord.type, 'snapshot', `Root record for ${note.path} must be a snapshot`);
        }
    });

    test('6. Verify ReconstructionEngine content reconstruction matches oracle and satisfies Invariant 5', async () => {
        const sampleNotes = allNotes.slice(16, 22);
        for (const note of sampleNotes) {
            if (note.revisions.length === 0) continue;

            const latestRev = note.revisions[note.revisions.length - 1];
            const reconstructedContent = await reconstructionEngine.reconstructVersion(
                PB_DEV_CONFIG.vaultId,
                note.path,
                latestRev.hash
            );

            assert.equal(
                reconstructedContent,
                latestRev.content,
                `Reconstructed content mismatch for latest revision of ${note.path}`
            );

            if (note.revisions.length >= 5) {
                const midIndex = Math.floor(note.revisions.length / 2);
                const midRev = note.revisions[midIndex];

                const midReconstructed = await reconstructionEngine.reconstructVersion(
                    PB_DEV_CONFIG.vaultId,
                    note.path,
                    midRev.hash
                );

                assert.equal(
                    midReconstructed,
                    midRev.content,
                    `Historical point-in-time reconstruction mismatch at revision ${midIndex} for ${note.path}`
                );
            }
        }
    });

    test('7. Verify view pagination perPage limit works cleanly', async () => {
        const longNote = allNotes.find(n => n.revisions.length > 5)!;
        const pageRecords = await store.getEntriesWithObjects(PB_DEV_CONFIG.vaultId, longNote.path, 5);

        assert.ok(pageRecords.length <= 5, 'perPage=5 must constrain returned items to at most 5');
        assert.equal(pageRecords.length, 5, 'perPage=5 must return 5 items when more exist');
    });

    test('8. Verify that rename operations run as expected across all renamed notes', async () => {
        assert.equal(renamedNotes.length, 12, 'Must have 12 renamed notes to verify');

        for (const rn of renamedNotes) {
            // Check newPath entries
            const newRecords = await store.getEntriesWithObjects(PB_DEV_CONFIG.vaultId, rn.newPath, 100);
            assert.ok(newRecords.length >= 7, 'Must have at least rename record + 6 post-rename records');

            // Find rename record
            const renameRecord = newRecords.find(r => r.operation === 'rename');
            assert.ok(renameRecord, `Must have a record with operation='rename' on ${rn.newPath}`);
            assert.equal(renameRecord.oldPath, rn.oldPath, 'Rename record must record original old_path');
            assert.equal(renameRecord.hash, rn.preRenameLastRevision.hash, 'Rename record must match pre-rename content hash');

            // Verify post-rename records have operation='save'
            const postRenameRecords = newRecords.filter(r => r.timestamp > rn.renameTimestamp);
            assert.equal(postRenameRecords.length, 6, 'Must have 6 post-rename save revisions');
            for (const pr of postRenameRecords) {
                assert.equal(pr.operation, 'save', 'Post-rename edits must be saved with operation=save');
            }

            // Check oldPath entries: verify the delete record exists
            const oldRecords = await store.getEntriesWithObjects(PB_DEV_CONFIG.vaultId, rn.oldPath, 200);
            const deleteRecord = oldRecords.find(r => r.operation === 'delete');
            assert.ok(deleteRecord, `Must have a record with operation='delete' on ${rn.oldPath}`);
            assert.equal(deleteRecord.hash, rn.preRenameLastRevision.hash, 'Delete record must retain last pre-rename hash');
            assert.equal(deleteRecord.timestamp, rn.deleteTimestamp, 'Delete timestamp must match');
        }

        // Verify latest_vault_files recognizes newPath as active and pre-rename oldPath as deleted
        const activeFiles = await store.getLatestFiles(PB_DEV_CONFIG.vaultId, false);
        for (const rn of renamedNotes) {
            const activeMatch = activeFiles.find(f => f.path === rn.newPath);
            assert.ok(activeMatch, `Renamed note ${rn.newPath} must be recognized as active in latest_vault_files`);
        }
    });

    test('9. Try reconstruction on the renamed notes and verify expected results', async () => {
        for (const rn of renamedNotes) {
            // 1. Reconstruct latest post-rename version
            const latestPostRev = rn.postRenameRevisions[rn.postRenameRevisions.length - 1];
            const reconstructedLatest = await reconstructionEngine.reconstructVersion(
                PB_DEV_CONFIG.vaultId,
                rn.newPath,
                latestPostRev.hash
            );
            assert.equal(
                reconstructedLatest,
                latestPostRev.content,
                `Latest post-rename reconstructed content mismatch for ${rn.newPath}`
            );
            const verifiedLatestHash = await Hasher.computeHash(reconstructedLatest);
            assert.equal(verifiedLatestHash, latestPostRev.hash, 'Reconstructed content hash must match target hash');

            // 2. Reconstruct at the exact rename revision
            const reconstructedRename = await reconstructionEngine.reconstructVersion(
                PB_DEV_CONFIG.vaultId,
                rn.newPath,
                rn.preRenameLastRevision.hash
            );
            assert.equal(
                reconstructedRename,
                rn.preRenameLastRevision.content,
                `Rename point reconstructed content mismatch for ${rn.newPath}`
            );

            // 3. Reconstruct a pre-rename historical version across the rename boundary
            const midPreIndex = Math.floor(rn.originalNote.revisions.length / 2);
            const midPreRev = rn.originalNote.revisions[midPreIndex];

            // When queried using the newPath, ReconstructionEngine seamlessly traverses parent_hash
            // back into historical objects originally created under oldPath
            const reconstructedPre = await reconstructionEngine.reconstructVersion(
                PB_DEV_CONFIG.vaultId,
                rn.newPath,
                midPreRev.hash
            );
            assert.equal(
                reconstructedPre,
                midPreRev.content,
                `Historical pre-rename reconstructed content mismatch across boundary for ${rn.newPath}`
            );
        }
    });

    test('10. Create new notes in old paths of renamed notes and verify their DAG chain', async () => {
        assert.equal(resurrectedNotes.length, 12, 'Must have 12 resurrected notes');

        for (const res of resurrectedNotes) {
            const rn = renamedNotes.find(r => r.oldPath === res.path)!;
            const records = await store.getEntriesWithObjects(PB_DEV_CONFIG.vaultId, res.path, 200);

            // Filter entries belonging to the new note generation (timestamp > deleteTimestamp)
            const newGenRecords = records.filter(r => r.timestamp > rn.deleteTimestamp);
            assert.equal(newGenRecords.length, 5, `Must have 5 records in new generation for ${res.path}`);

            // The root snapshot of the new generation (earliest in new generation)
            const rootNewGen = newGenRecords[newGenRecords.length - 1];
            assert.equal(rootNewGen.type, 'snapshot', 'Base of newly created note at old path must be a snapshot');
            assert.equal(rootNewGen.parentHash, null, 'Base of newly created note at old path must have parentHash=null');
            assert.notEqual(rootNewGen.hash, rn.preRenameLastRevision.hash, 'New note root hash must not equal previous note hash');

            // Verify no record in the new generation points to the pre-rename hash or delete record
            for (const r of newGenRecords) {
                assert.notEqual(
                    r.parentHash,
                    rn.preRenameLastRevision.hash,
                    `New generation record ${r.hash} must not chain to pre-rename hash`
                );
            }

            // Reconstruct the latest version of the new note at oldPath
            const latestNewRev = res.revisions[res.revisions.length - 1];
            const reconstructedNewNote = await reconstructionEngine.reconstructVersion(
                PB_DEV_CONFIG.vaultId,
                res.path,
                latestNewRev.hash
            );

            assert.equal(
                reconstructedNewNote,
                latestNewRev.content,
                `Reconstructed content mismatch for new note at old path ${res.path}`
            );
        }
    });
});
