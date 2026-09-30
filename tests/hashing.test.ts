import test from 'node:test';
import assert from 'node:assert/strict';
import { Hasher } from '../src/hashing/hasher';


test('Hasher computes SHA-256 and deterministic PocketBase IDs', async () => {
    const content = '# Hello World\nTesting obsidian backup.';
    const hash = await Hasher.computeHash(content);

    assert.ok(hash.startsWith('sha256:'));
    assert.equal(hash.length, 7 + 64);

    // Test deterministic hexToPocketBaseId (15 alphanumeric characters)
    const pbId = Hasher.hexToPocketBaseId(hash);
    assert.equal(pbId.length, 15);
    assert.match(pbId, /^[a-z0-9]{15}$/);

    // Test deterministic snapshot ID derivation
    const vaultId = 'v-12345';
    const snapId1 = await Hasher.deriveSnapshotObjectId(vaultId, hash);
    const snapId2 = await Hasher.deriveSnapshotObjectId(vaultId, hash);
    assert.equal(snapId1, snapId2);
    assert.equal(snapId1.length, 15);

    // Test deterministic diff ID derivation
    const parentHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    const diffId1 = await Hasher.deriveDiffObjectId(vaultId, parentHash, hash, 'jsdiff@5-unified');
    const diffId2 = await Hasher.deriveDiffObjectId(vaultId, parentHash, hash, 'jsdiff@5-unified');
    assert.equal(diffId1, diffId2);
    assert.equal(diffId1.length, 15);
});

