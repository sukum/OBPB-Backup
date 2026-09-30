import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hasher } from '../../src/hashing/hasher';
import { BackupOperation } from '../../src/types/domain';

describe("Hasher Tests", () => {
test('Hasher.deriveEntryId generates deterministic 15-character PocketBase IDs', async () => {
    const device = 'device-laptop-01';
    const vault = 'vault-work-notes';
    const path = 'Projects/Alpha/Spec.md';
    const oldPath = null;
    const operation = 'save';
    const objectId = 'obj-1234567890';
    const timestamp = 1700000000000;

    const id1 = await Hasher.deriveEntryId(device, vault, path, oldPath, operation, objectId, timestamp);
    const id2 = await Hasher.deriveEntryId(device, vault, path, oldPath, operation, objectId, timestamp);

    // Deterministic
    assert.equal(id1, id2);

    // Format: 15 lowercase alphanumeric characters
    assert.equal(id1.length, 15);
    assert.match(id1, /^[a-z0-9]{15}$/);
});

test('Hasher.deriveEntryId handles null and non-null values for oldPath and objectId', async () => {
    const device = 'dev-main';
    const vault = 'v-100';
    const path = 'Daily/2026-09-18.md';
    const timestamp = 1700000000000;

    // 1. With null oldPath and non-null objectId (regular snapshot / diff)
    const idNullOldPath = await Hasher.deriveEntryId(device, vault, path, null, 'save', 'obj-abc', timestamp);
    assert.equal(idNullOldPath.length, 15);
    assert.match(idNullOldPath, /^[a-z0-9]{15}$/);

    // 2. With string oldPath (file rename)
    const idRename = await Hasher.deriveEntryId(device, vault, path, 'Daily/2026-09-17.md', 'rename', 'obj-abc', timestamp);
    assert.notEqual(idNullOldPath, idRename, 'Renamed entry ID must differ from non-renamed entry ID');

    // 3. With null objectId (file deletion entry)
    const idDelete = await Hasher.deriveEntryId(device, vault, path, null, 'delete', null, timestamp);
    assert.equal(idDelete.length, 15);
    assert.match(idDelete, /^[a-z0-9]{15}$/);
    assert.notEqual(idDelete, idNullOldPath, 'Deletion ID with null objectId must differ from snapshot ID');
});

test('Hasher.deriveEntryId matches the exact expected derivation formula', async () => {
    const device = 'd1';
    const vault = 'v1';
    const path = 'Folder/file.md';
    const oldPath = null;
    const operation = 'save';
    const objectId = 'obj-xyz';
    const timestamp = 1700000000000;

    const expectedSeed = `${device}:${vault}:${path}:${oldPath ?? 'null'}:${operation}:${objectId}:${timestamp}`;
    const expectedHex = await Hasher.sha256Hex(expectedSeed);
    const expectedId = Hasher.hexToPocketBaseId(expectedHex);

    const actualId = await Hasher.deriveEntryId(device, vault, path, oldPath, operation, objectId, timestamp);
    assert.equal(actualId, expectedId);
});

test('Hasher.deriveEntryId is sensitive to every parameter to prevent collisions', async () => {
    const base = {
        device: 'device-1',
        vault: 'vault-1',
        path: 'note.md',
        oldPath: null as string | null,
        operation: 'save' as BackupOperation,
        objectId: 'obj-1',
        timestamp: 1700000000000,
    };

    const baseId = await Hasher.deriveEntryId(base.device, base.vault, base.path, base.oldPath, base.operation, base.objectId, base.timestamp);

    const diffDevice = await Hasher.deriveEntryId('device-2', base.vault, base.path, base.oldPath, base.operation, base.objectId, base.timestamp);
    const diffVault = await Hasher.deriveEntryId(base.device, 'vault-2', base.path, base.oldPath, base.operation, base.objectId, base.timestamp);
    const diffPath = await Hasher.deriveEntryId(base.device, base.vault, 'other.md', base.oldPath, base.operation, base.objectId, base.timestamp);
    const diffOldPath = await Hasher.deriveEntryId(base.device, base.vault, base.path, 'prior.md', base.operation, base.objectId, base.timestamp);
    const diffOp = await Hasher.deriveEntryId(base.device, base.vault, base.path, base.oldPath, 'rename', base.objectId, base.timestamp);
    const diffObj = await Hasher.deriveEntryId(base.device, base.vault, base.path, base.oldPath, base.operation, 'obj-2', base.timestamp);
    const diffTimestamp = await Hasher.deriveEntryId(base.device, base.vault, base.path, base.oldPath, base.operation, base.objectId, 1700000000001);

    assert.notEqual(diffDevice, baseId, "diffDevice");
    assert.notEqual(diffVault, baseId,"diffVault");
    assert.notEqual(diffPath, baseId, "diffPath");
    assert.notEqual(diffOldPath, baseId, "diffOldPath");
    assert.notEqual(diffOp, baseId, "diffOp");
    assert.notEqual(diffObj, baseId, "diffObj");
    assert.notEqual(diffTimestamp, baseId, "diffTimestamp");
});

test('Hasher.deriveDiffObjectId generates deterministic 15-character PocketBase IDs', async () => {
    const vault = 'vault-alpha';
    const parentHash = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    const contentHash = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';
    const diffFormat = 'jsdiff@5-unified';

    const id1 = await Hasher.deriveDiffObjectId(vault, parentHash, contentHash, diffFormat);
    const id2 = await Hasher.deriveDiffObjectId(vault, parentHash, contentHash, diffFormat);

    // Deterministic
    assert.equal(id1, id2);

    // Format: 15 lowercase alphanumeric characters
    assert.equal(id1.length, 15);
    assert.match(id1, /^[a-z0-9]{15}$/);
});

test('Hasher.deriveDiffObjectId handles null parentHash and null diffFormat', async () => {
    const vault = 'vault-beta';
    const contentHash = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';

    // 1. null parentHash
    const idNullParent = await Hasher.deriveDiffObjectId(vault, null, contentHash, 'jsdiff@5-unified');
    assert.equal(idNullParent.length, 15);
    assert.match(idNullParent, /^[a-z0-9]{15}$/);

    // 2. null diffFormat
    const idNullFormat = await Hasher.deriveDiffObjectId(vault, 'sha256:parent', contentHash, null);
    assert.equal(idNullFormat.length, 15);
    assert.match(idNullFormat, /^[a-z0-9]{15}$/);

    // 3. both null
    const idBothNull = await Hasher.deriveDiffObjectId(vault, null, contentHash, null);
    assert.equal(idBothNull.length, 15);
    assert.match(idBothNull, /^[a-z0-9]{15}$/);

    assert.notEqual(idNullParent, idBothNull);
    assert.notEqual(idNullFormat, idBothNull);
});

test('Hasher.deriveDiffObjectId matches the exact expected derivation formula', async () => {
    const vault = 'v-test';
    const parentHash = 'sha256:parent123';
    const contentHash = 'sha256:child456';
    const diffFormat = 'jsdiff@5-unified';

    const expectedSeed = `${vault}:${parentHash ?? 'null'}:${contentHash}:${diffFormat ?? 'null'}`;
    const expectedHex = await Hasher.sha256Hex(expectedSeed);
    const expectedId = Hasher.hexToPocketBaseId(expectedHex);

    const actualId = await Hasher.deriveDiffObjectId(vault, parentHash, contentHash, diffFormat);
    assert.equal(actualId, expectedId);
});

test('Hasher.deriveDiffObjectId is sensitive to every parameter to prevent collisions', async () => {
    const base = {
        vault: 'vault-base',
        parentHash: 'sha256:parent',
        contentHash: 'sha256:content',
        diffFormat: 'jsdiff@5-unified',
    };

    const baseId = await Hasher.deriveDiffObjectId(base.vault, base.parentHash, base.contentHash, base.diffFormat);

    const diffVault = await Hasher.deriveDiffObjectId('vault-other', base.parentHash, base.contentHash, base.diffFormat);
    const diffParent = await Hasher.deriveDiffObjectId(base.vault, 'sha256:parent2', base.contentHash, base.diffFormat);
    const diffContent = await Hasher.deriveDiffObjectId(base.vault, base.parentHash, 'sha256:content2', base.diffFormat);
    const diffFormat = await Hasher.deriveDiffObjectId(base.vault, base.parentHash, base.contentHash, 'custom-format');

    assert.notEqual(diffVault, baseId);
    assert.notEqual(diffParent, baseId);
    assert.notEqual(diffContent, baseId);
    assert.notEqual(diffFormat, baseId);
});
});
