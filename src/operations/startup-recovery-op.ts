import { TFile } from 'obsidian';
import { RecoveryCoalescePolicy } from '../policies/recovery-coalesce-policy';
import type { DirtyFileEntry } from '../types/state';
import { generateUUID } from '../utils/uuid';
import {
    BASE_EXECUTION_POLICIES,
    SAVE_EXECUTION_POLICIES,
    type AutoDeleteIntent,
    type AutoRenameIntent,
    type AutoSaveIntent,
    type StartupRecoveryContext,
    type INTENT_DEFAULT_SPEC_PROPERTIES,
} from './types';

const RECOVERY_AUTO_SAVE_INTENT_DEFAULTS = {
    trigger: 'auto',
    event: 'recovery',
    operation: 'save',
    policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
} as const satisfies Pick<AutoSaveIntent, INTENT_DEFAULT_SPEC_PROPERTIES>;

const RECOVERY_AUTO_RENAME_INTENT_DEFAULTS = {
    trigger: 'auto',
    event: 'recovery',
    operation: 'rename',
    policy: BASE_EXECUTION_POLICIES.AUTO,
} as const satisfies Pick<AutoRenameIntent, INTENT_DEFAULT_SPEC_PROPERTIES>;

const RECOVERY_AUTO_DELETE_INTENT_DEFAULTS = {
    trigger: 'auto',
    event: 'recovery',
    operation: 'delete',
    policy: BASE_EXECUTION_POLICIES.AUTO,
} as const satisfies Pick<AutoDeleteIntent, INTENT_DEFAULT_SPEC_PROPERTIES>;

/**
 * Replays the dirty journal exclusively as automatic intents.
 * The queue and runner retain ownership of journal cleanup after replay.
 */
export class StartupRecoveryOperation {
    constructor(private readonly context: StartupRecoveryContext) {}

    public async execute(): Promise<void> {
        // parseDirtyFileTsv would validate and clean the entries
        const rawEntries = await this.context.dirtyFileManager.load();
        if (rawEntries.length === 0) return;

        const expandedEntries = this.expandRenameEffects(rawEntries);
        const coalesced = RecoveryCoalescePolicy.coalesce(expandedEntries);
        // DELETES from RENAMES. To avoid duplicate DELETEs on same path from RENAME and DELETE
        // This builds a map of deleted from rename. DELETE ops on these paths are ignored.
        const validRenameOldPaths = new Set(
            coalesced
                .filter((entry): entry is Extract<DirtyFileEntry, { operation: 'RENAME' }> => entry.operation === 'RENAME'
                    && entry.oldPath.length > 0
                    && this.context.vault.getAbstractFileByPath(entry.path) instanceof TFile)
                .map((entry) => entry.oldPath)
        );
        const enqueuedDeletes = new Set<string>();
        // Saved as new dirty file
        const activeRemaining = new Map<string, DirtyFileEntry>();

        for (const entry of coalesced) {
            try {
                // SAVE
                if (entry.operation === 'SAVE') {
                    const file = this.context.vault.getAbstractFileByPath(entry.path);
                    if (file instanceof TFile) {
                        const intent: AutoSaveIntent = {
                            ...RECOVERY_AUTO_SAVE_INTENT_DEFAULTS,
                            id: generateUUID(),
                            path: file.path,
                            file,
                            createdAt: Date.now(),
                        };
                        await this.context.queue.enqueue(intent);
                        activeRemaining.set(entry.path, entry);
                    } else {
                        await this.enqueueDelete(entry.path, enqueuedDeletes);
                        activeRemaining.set(entry.path, { operation: 'DELETE', path: entry.path });
                    }
                    continue;
                }

                // DELETE
                if (entry.operation === 'DELETE') {
                    if (!validRenameOldPaths.has(entry.path)) {
                        await this.enqueueDelete(entry.path, enqueuedDeletes);
                    }
                    activeRemaining.set(entry.path, entry);
                    continue;
                }

                // RENAME
                if (entry.operation === 'RENAME') {
                    if (!entry.oldPath) continue;
                    const oldPath = entry.oldPath;
                    const file = this.context.vault.getAbstractFileByPath(entry.path);
                    if (file instanceof TFile) {
                        const intent: AutoRenameIntent = {
                            ...RECOVERY_AUTO_RENAME_INTENT_DEFAULTS,
                            id: generateUUID(),
                            path: file.path,
                            oldPath: oldPath,
                            file,
                            createdAt: Date.now(),
                        };
                        await this.context.queue.enqueue(intent);
                        activeRemaining.set(entry.path, entry);
                        continue;
                    }

                    // Missing target: remove the abandoned rename. Its expanded source DELETE is
                    // already replayed above and remains in activeRemaining unless a later source
                    // operation superseded it.
                    await this.context.dirtyFileManager.markClean(entry.path);
                    if (activeRemaining.get(oldPath)?.operation === 'DELETE') {
                        await this.context.dirtyFileManager.markDirty('DELETE', oldPath);
                    }
                }
            } catch (err) {
                console.error(`[PB Backup] Recovery failed for ${entry.path}:`, err);
                await this.context.dirtyFileManager.markClean(entry.path);
            }
        }

        if (this.context.dirtyFileManager.saveAll) {
            await this.context.dirtyFileManager.saveAll(Array.from(activeRemaining.values()));
        }
    }

    private async enqueueDelete(path: string, enqueuedDeletes: Set<string>): Promise<void> {
        if (enqueuedDeletes.has(path)) return;
        enqueuedDeletes.add(path);
        const intent: AutoDeleteIntent = {
            ...RECOVERY_AUTO_DELETE_INTENT_DEFAULTS,
            id: generateUUID(),
            path,
            createdAt: Date.now(),
        };
        await this.context.queue.enqueue(intent);
    }

    /**
     * A rename affects both paths: the destination carries the rename intent,
     * while the source must be deleted if a later destination operation
     * supersedes that rename during per-path coalescing.
     */
    private expandRenameEffects(entries: (DirtyFileEntry | string)[]): DirtyFileEntry[] {
        const expanded: DirtyFileEntry[] = [];

        for (const raw of entries) {
            const entry: DirtyFileEntry = typeof raw === 'string'
                ? { operation: 'SAVE', path: raw }
                : raw;

            if (entry.operation === 'RENAME' && entry.oldPath) {
                expanded.push({ operation: 'DELETE', path: entry.oldPath });
            }
            expanded.push(entry);
        }

        return expanded;
    }
}
