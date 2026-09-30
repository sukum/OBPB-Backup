import type { TaskIntent } from '../operations/types';

/**
 * Pure synchronous decision rules deriving whether an unchanged file should be skipped.
 * Free of side-effects, I/O, or remote queries.
 */
export class SkipUnchangedPolicy {
    public static shouldSkipIfUnchanged(intent: TaskIntent): boolean {
        // Renames and deletes represent topology changes, never skip
        if (intent.operation !== 'save') {
            return false;
        }

        // Blind vault snapshot forces all files to snapshot regardless of state
        if (intent.event === 'vault-backup') {
            return false;
        }

        // Explicit user command "Backup Current Note Now" forces a fresh snapshot
        if (intent.trigger === 'manual' && intent.mode === 'snapshot') {
            return false;
        }

        // "Sync Current Note Now" (manual + auto/diff), debounces, vault-sync, and recovery skip unchanged files
        return true;
    }
}
