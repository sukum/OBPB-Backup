import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hasher } from '../src/hashing/hasher';
import { DiffEngine } from '../src/diff/diff-engine';

describe("Reconstruction Engine Tests", () => {
test('ReconstructionEngine reconstructs version chain and verifies Invariant 5', async () => {
    const { ReconstructionEngine } = await import('../src/reconstruct/reconstruction-engine');

    const v1Content = '# Note Header\nFirst draft of content.\n';
    const v1Hash = await Hasher.computeHash(v1Content);

    const v2Content = '# Note Header\nFirst draft with edits.\nSecond paragraph.\n';
    const v2Hash = await Hasher.computeHash(v2Content);
    const v2Patch = DiffEngine.createForwardDiff(v1Content, v2Content);

    const v3Content = '# Note Header\nFirst draft with edits.\nSecond paragraph.\nFinal conclusion.\n';
    const v3Hash = await Hasher.computeHash(v3Content);
    const v3Patch = DiffEngine.createForwardDiff(v2Content, v3Content);

    const mockVault = 'vault-test';
    const mockPath = 'Document.md';

    // Mock BackupStore
    const objectsMap = new Map<string, any>();
    objectsMap.set(v1Hash, {
        id: 'obj1',
        vault: mockVault,
        hash: v1Hash,
        parentHash: null,
        type: 'snapshot',
        data: v1Content,
        dataHash: await Hasher.computeDataHash(v1Content),
        diffFormat: null,
        size: v1Content.length,
    });
    objectsMap.set(v2Hash, {
        id: 'obj2',
        vault: mockVault,
        hash: v2Hash,
        parentHash: v1Hash,
        type: 'diff',
        data: v2Patch,
        dataHash: await Hasher.computeDataHash(v2Patch),
        diffFormat: 'jsdiff@5-unified',
        size: v2Patch.length,
    });
    objectsMap.set(v3Hash, {
        id: 'obj3',
        vault: mockVault,
        hash: v3Hash,
        parentHash: v2Hash,
        type: 'diff',
        data: v3Patch,
        dataHash: await Hasher.computeDataHash(v3Patch),
        diffFormat: 'jsdiff@5-unified',
        size: v3Patch.length,
    });

    const entriesWithObjects: any[] = [
        {
            id: 'e1',
            vault: mockVault,
            path: mockPath,
            operation: 'save',
            device: 'dev1',
            timestamp: 1000,
            hash: v1Hash,
            parentHash: null,
            type: 'snapshot',
            data: v1Content,
            dataHash: '',
            diffFormat: null,
            size: v1Content.length,
        },
        {
            id: 'e2',
            vault: mockVault,
            path: mockPath,
            operation: 'save',
            device: 'dev1',
            timestamp: 2000,
            hash: v2Hash,
            parentHash: v1Hash,
            type: 'diff',
            data: v2Patch,
            dataHash: '',
            diffFormat: 'jsdiff@5-unified',
            size: v2Patch.length,
        },
        {
            id: 'e3',
            vault: mockVault,
            path: mockPath,
            operation: 'save',
            device: 'dev1',
            timestamp: 3000,
            hash: v3Hash,
            parentHash: v2Hash,
            type: 'diff',
            data: v3Patch,
            dataHash: '',
            diffFormat: 'jsdiff@5-unified',
            size: v3Patch.length,
        },
    ];

    const mockStore: any = {
        async getEntriesWithObjects(vault: string, path: string, perPage?: number) {
            return entriesWithObjects;
        },
        async getObject(vault: string, hash: string) {
            return objectsMap.get(hash) || null;
        },
        async getHistory(vault: string, path: string) {
            return entriesWithObjects.map(e => ({
                id: e.id,
                vault: e.vault,
                path: e.path,
                operation: e.operation,
                device: e.device,
                timestamp: e.timestamp,
                hash: e.hash,
                type: e.type,
                size: e.size,
            }));
        },
    };

    const engine = new ReconstructionEngine(mockStore);

    // Test pure DAG reconstruction for hashes v1, v2, and v3
    const reconstructedV1 = await engine.reconstructVersion(mockVault, mockPath, v1Hash);
    assert.equal(reconstructedV1, v1Content);

    const reconstructedV2 = await engine.reconstructVersion(mockVault, mockPath, v2Hash);
    assert.equal(reconstructedV2, v2Content);

    const reconstructedV3 = await engine.reconstructVersion(mockVault, mockPath, v3Hash);
    assert.equal(reconstructedV3, v3Content);

    // Verify cryptographic integrity check (Invariant 5)
    assert.equal(await Hasher.computeHash(reconstructedV3), v3Hash);

    // Test fallback when getEntriesWithObjects does NOT have older entries (e.g. beyond 100 entries)
    // and older object must be retrieved via store.getObject
    const partialStore: any = {
        async getEntriesWithObjects(vault: string, path: string) {
            // Only returns latest entry (v3), missing v2 and v1
            return [entriesWithObjects[2]];
        },
        async getObject(vault: string, hash: string) {
            return objectsMap.get(hash) || null;
        },
    };

    const engineWithFallback = new ReconstructionEngine(partialStore);
    const fallbackResult = await engineWithFallback.reconstructVersion(mockVault, mockPath, v3Hash);
    assert.equal(fallbackResult, v3Content);
});
});
