import type { CachedNoteState } from '../types/state';
import type { EntriesWithObjectsViewRecord } from '../types/database';

export type BaseResolutionAction =
    | { action: 'skip_unchanged'; parentHash: string; prevTimestamp: number }
    | { action: 'use_cached_base'; baseText: string; parentHash: string; diffDepth: number; prevTimestamp: number }
    | { action: 'reconstruct_remote_base'; parentHash: string; diffDepth: number; prevTimestamp: number }
    | { action: 'snapshot_fallback'; parentHash: string | null; prevTimestamp?: number; reason: string }
    | { action: 'initial_snapshot'; parentHash: null; prevTimestamp?: number };

/**
 * Pure, synchronous decision rules evaluating remote / cache entries against local content hash.
 * Free of side-effects, I/O, or network calls.
 */
export class BaseResolutionPolicy {
    public static evaluate(
        contentHash: string,
        skipIfUnchanged: boolean,
        cached?: CachedNoteState,
        remoteEntries?: EntriesWithObjectsViewRecord[]
    ): BaseResolutionAction {
        // Fast path: in-memory cache
        if (cached) {
            if (skipIfUnchanged && cached.hash === contentHash) {
                return {
                    action: 'skip_unchanged',
                    parentHash: cached.hash,
                    prevTimestamp: cached.timestamp,
                };
            }
            return {
                action: 'use_cached_base',
                baseText: cached.baseText,
                parentHash: cached.hash,
                diffDepth: cached.diffDepth,
                prevTimestamp: cached.timestamp,
            };
        }

        // Remote entries path
        if (remoteEntries && remoteEntries.length > 0) {
            const latestEntry = remoteEntries[0];
            // If last operation was DEL, create a new chain with a snapshot
            if (latestEntry.operation === 'delete') {
                return {
                    action: 'initial_snapshot',
                    parentHash: null,
                    // A replacement snapshot must still sort after a remote tombstone.
                    prevTimestamp: latestEntry.timestamp,
                };
            }
            // If sync and no change, skip
            if (skipIfUnchanged && latestEntry.hash === contentHash) {
                return {
                    action: 'skip_unchanged',
                    parentHash: latestEntry.hash,
                    prevTimestamp: latestEntry.timestamp,
                };
            }

            const parentHash = latestEntry.hash;
            const prevTimestamp = latestEntry.timestamp;

            // Follow the actual parent-hash chain
            const entriesByHash = new Map<string, EntriesWithObjectsViewRecord>();
            for (const entry of remoteEntries) {
                // Keep the newest entry for a hash because the input is sorted newest first.
                if (!entriesByHash.has(entry.hash)) {
                    entriesByHash.set(entry.hash, entry);
                }
            }

            // Find base snapshot by traversing, calculate diffDepth
            let current: EntriesWithObjectsViewRecord | undefined = latestEntry;
            let diffDepth = 0;
            const visitedHashes = new Set<string>();
            while (current && current.type !== 'snapshot') {
                if (visitedHashes.has(current.hash) || !current.parentHash) {
                    current = undefined;
                    break;
                }
                visitedHashes.add(current.hash);
                diffDepth++;
                current = entriesByHash.get(current.parentHash);
            }
            // No base snapshot found, so create
            if (!current || current.type !== 'snapshot') {
                return {
                    action: 'snapshot_fallback',
                    parentHash,
                    prevTimestamp,
                    reason: 'broken_chain',
                };
            }

            // All is well, reconstruct the remote base from chain
            return {
                action: 'reconstruct_remote_base',
                parentHash,
                diffDepth,
                prevTimestamp,
            };
        }

        return {
            action: 'initial_snapshot',
            parentHash: null,
        };
    }
}
