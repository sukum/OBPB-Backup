import type { DeleteIntent } from '../operations/types';
import type { PreparationContext, PreparationReadyResult, PreparationSkippedResult, PayloadPreparerDependencies } from './types';
import type { PreparedDeleteUpload } from '../upload/types';
import { TaskFactory } from '../tasks/task-factory';

export class PrepareDelete {
    constructor(private readonly deps: PayloadPreparerDependencies) {}

    public async prepare(intent: DeleteIntent, context?: PreparationContext): Promise<PreparationReadyResult | PreparationSkippedResult> {
        const vaultId = this.deps.deviceManager.getVaultId();
        let oldHash: string | undefined;
        let oldTimestamp: number | undefined;

        // Resolve prior metadata from cache or remote
        if (!context?.disableRecentNotesCache && this.deps.cache.has(intent.path)) {
            const cached = this.deps.cache.get(intent.path)!;
            oldHash = cached.hash;
            oldTimestamp = cached.timestamp;
        } else {
            try {
                const remoteLatest = await this.deps.store.getLatestEntry(vaultId, intent.path);
                if (remoteLatest && remoteLatest.operation !== 'delete') {
                    oldHash = remoteLatest.hash;
                    oldTimestamp = remoteLatest.timestamp;
                }
            } catch (err) {
                console.warn(`[OBPB Backup] Failed querying latest entry for delete ${intent.path}:`, err);
            }
        }

        // Untracked or already deleted file -> skip
        if (!oldHash) {
            return { kind: 'skipped', path: intent.path, reason: 'untracked_deletion' };
        }

        // Return PreparedDeleteUpload with monotonic timestamp
        const timestamp = TaskFactory.nextMonotonicTimestamp(oldTimestamp);
        const upload: PreparedDeleteUpload = {
            id: intent.id,
            device: this.deps.deviceManager.getDevice(),
            vault: vaultId,
            path: intent.path,
            timestamp,
            targetHash: oldHash,
            operation: 'delete',
        };

        return {
            kind: 'ready',
            upload,
        };
    }
}