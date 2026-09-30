import { TFile } from 'obsidian';
import { FileFilterPolicy } from 'src/policies/file-filter-policy';
import { SAVE_EXECUTION_POLICIES, type RenameIntent } from '../operations/types';
import type { PreparationContext, PreparationResult, PayloadPreparerDependencies } from './types';
import { PrepareSave } from './prepare-save';
import type { PreparedRenameUpload } from '../upload/types';
import { TaskFactory } from '../tasks/task-factory';

export class PrepareRename {
    constructor(private readonly deps: PayloadPreparerDependencies) {}
    
    public async prepare(intent: RenameIntent, context?: PreparationContext): Promise<PreparationResult> {
        const settings = this.deps.getSettings();

        // 1. Check destination extension
        if (!FileFilterPolicy.isMonitored(intent.path, settings.monitoredExtensions)) {
            return { kind: 'skipped', path: intent.path, reason: 'unmonitored_extension' };
        }

        // 2. Check destination file presence
        const candidate = intent.file || this.deps.vault.getAbstractFileByPath(intent.path);
        if (!(candidate instanceof TFile)) {
            return { kind: 'skipped', path: intent.path, reason: 'missing_file' };
        }

        const vaultId = this.deps.deviceManager.getVaultId();
        let oldHash: string | undefined;
        let oldTimestamp: number | undefined;
        let baseText: string | undefined;
        let diffDepth: number | undefined;

        // 3. Resolve oldPath metadata (check cache)
        if (!context?.disableRecentNotesCache && this.deps.cache.has(intent.oldPath)) {
            const cached = this.deps.cache.get(intent.oldPath)!;
            oldHash = cached.hash;
            oldTimestamp = cached.timestamp;
            baseText = cached.baseText;
            diffDepth = cached.diffDepth;
        } else {
            try {
                const remoteLatest = await this.deps.store.getLatestEntry(vaultId, intent.oldPath);
                if (remoteLatest && remoteLatest.operation !== 'delete') {
                    oldHash = remoteLatest.hash;
                    oldTimestamp = remoteLatest.timestamp;
                }
            } catch (err) {
                console.warn(`[OBPB Backup] Failed querying latest entry for rename source ${intent.oldPath}:`, err);
            }
        }

        // 4. Untracked file -> cleanly degrade to initial Save (snapshot) of destination
        if (!oldHash) {
            return (new PrepareSave(this.deps)).prepare(
                {
                    ...intent,
                    operation: 'save',
                    file: candidate,
                    mode: 'snapshot',
                    policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
                },
                context
            );
        }

        // 5. Tracked file -> return PreparedRenameUpload with monotonic timestamps
        const deleteTimestamp = TaskFactory.nextMonotonicTimestamp(oldTimestamp);
        const renameTimestamp = TaskFactory.nextMonotonicTimestamp(deleteTimestamp);

        const upload: PreparedRenameUpload = {
            id: intent.id,
            device: this.deps.deviceManager.getDevice(),
            vault: vaultId,
            path: intent.path,
            oldPath: intent.oldPath,
            timestamp: renameTimestamp,
            deleteTimestamp,
            targetHash: oldHash,
            operation: 'rename',
        };

        return {
            kind: 'ready',
            upload,
            content: baseText,
            newDiffDepth: diffDepth,
        };
    }
}
