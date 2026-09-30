import type { DirtyFileEntry } from '../types/state';

/**
 * Coalesces raw journal entries using the Last-Op-Per-Path rule.
 * Only last OP in dirty files for a given path is retained.
 * 
 * Rules:
 * - Scans journal sequentially.
 * - Accepts both DirtyFileEntry objects and raw path strings (defaulting to SAVE).
 * - Assigns/overwrites the latest operation for `entry.path`.
 * - A RENAME retains its `oldPath`; rename side effects are expanded by startup recovery.
 * - Returns the consolidated deduplicated operations.
 * Since the dirty file was written and the app is restarting, there could have been local changes
 * So no point in doing multiple SAVE operations on the same path in the same local state.
 * Just do the last operation for each path.
 */
export class RecoveryCoalescePolicy {
    public static coalesce(entries: (DirtyFileEntry | string)[]): DirtyFileEntry[] {
        const pathOps = new Map<string, DirtyFileEntry>();

        for (const raw of entries) {
            const entry: DirtyFileEntry = typeof raw === 'string'
                ? { operation: 'SAVE', path: raw }
                : raw;

            if (entry.operation === 'RENAME') {
                pathOps.set(entry.path, {
                    operation: 'RENAME',
                    path: entry.path,
                    oldPath: entry.oldPath,
                });
            } else {
                pathOps.set(entry.path, {
                    operation: entry.operation,
                    path: entry.path,
                });
            }
        }

        return Array.from(pathOps.values());
    }
}
