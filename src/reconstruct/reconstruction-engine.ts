import { BackupStore } from '../remote/backup-store';
import { DiffEngine } from '../diff/diff-engine';
import { Hasher } from '../hashing/hasher';
import { EntriesWithObjectsViewRecord } from '../types/database';
import type { VersionReconstructor } from './types';

type ReconstructionStep = Pick<EntriesWithObjectsViewRecord, 'hash' | 'type' | 'parentHash' | 'data'>;

/**
 * Historical version reconstruction engine.
 * Fetches recent entries in bulk via entries_with_objects and traverses backward along the parent_hash DAG.
 * Applies diffs in a chain
 */
export class ReconstructionEngine implements VersionReconstructor {
    constructor(private store: BackupStore) {}

    /**
     * Reconstructs content of a document at a specific historical content hash.
     * Fetches recent entries in bulk via entries_with_objects and walks backward using parent_hash.
     */
    public async reconstructVersion(vault: string, path: string, targetHash: string, entries?: EntriesWithObjectsViewRecord[]): Promise<string> {
        // Bulk fetch recent entries with joined object payloads (single HTTP call)
        if (!entries) {
            entries = await this.store.getEntriesWithObjects(vault, path, 100);
        }
        // initial downloaded unordered entries
        const recordMap = new Map<string, ReconstructionStep>();

        for (const entry of entries) {
            recordMap.set(entry.hash, {
                hash: entry.hash,
                type: entry.type,
                parentHash: entry.parentHash,
                data: entry.data,
            });
        }

        // final chain of ordered notes
        const chain: ReconstructionStep[] = [];
        let currHash: string | null = targetHash;
        // set of visisted notes to detect duplicate entries which implies a cycle
        const visited = new Set<string>();

        while (currHash) {
            if (visited.has(currHash)) {
                throw new Error(`Cycle detected in parent_hash DAG at ${currHash}`);
            }
            visited.add(currHash);

            let record = recordMap.get(currHash);
            if (!record) {
                // If not in the bulk pre-fetch (e.g. >100 entries back), fetch single object
                const obj = await this.store.getObject(vault, currHash);
                if (!obj) {
                    throw new Error(`Historical object missing from remote storage for hash ${currHash}`);
                }
                record = {
                    hash: obj.hash,
                    type: obj.type,
                    parentHash: obj.parentHash,
                    data: obj.data,
                };
                recordMap.set(currHash, record);
            }

            chain.push(record);

            // when a snapshot is reached, a complete base note version has been reached to rebuild the other versions
            if (record.type === 'snapshot') {
                break;
            }

            currHash = record.parentHash;
        }

        // No entries or no snapshot in fully traversed entries - incomplete and invalid chain
        if (chain.length === 0 || chain[chain.length - 1].type !== 'snapshot') {
            throw new Error(`Failed to locate base snapshot in DAG walk for ${path} at hash ${targetHash}`);
        }

        // The chain constructed order is from the targetHash note version to the snapshot
        // Reverse to walk forward from base snapshot to target
        chain.reverse();

        // Snapshot content normalized
        let currentContent = DiffEngine.normalizeNewlines(chain[0].data);

        for (let i = 1; i < chain.length; i++) {
            const step = chain[i];
            if (step.type === 'snapshot') {
                currentContent = DiffEngine.normalizeNewlines(step.data);
            } else {
                currentContent = DiffEngine.applyForwardDiff(currentContent, step.data);
            }
        }

        // Cryptographic integrity check
        const computedHash = await Hasher.computeHash(currentContent);
        // Checks reconstructed note version's hash with the targetHash
        if (computedHash !== targetHash) {
            throw new Error(`Integrity check failed for ${path}: computed ${computedHash} != expected ${targetHash}`);
        }

        return currentContent;
    }
}
