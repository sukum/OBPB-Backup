import { FileFilterPolicy } from '../policies/file-filter-policy';
import {
    SAVE_EXECUTION_POLICIES,
    type ManualSaveIntent,
    type VaultOperationProgressCallback,
    type BatchResult,
    type BackupVaultContext,
    type INTENT_DEFAULT_SPEC_PROPERTIES,
} from './types';
import { WorkerPoolRunner } from './worker-pool-runner';
import { generateUUID } from '../utils/uuid';

const VAULT_BACKUP_INTENT_DEFAULTS = {
    trigger: 'manual',
    event: 'vault-backup',
    operation: 'save',
    policy: SAVE_EXECUTION_POLICIES.BATCH_SNAPSHOT,
    mode: 'snapshot',
} as const satisfies Pick<ManualSaveIntent, INTENT_DEFAULT_SPEC_PROPERTIES | 'mode'>;

/**
 * Performs a blind snapshot of all monitored files in the vault.
 * Dispatches processing across a bounded worker pool up to settings.batchConcurrency.
 */
export class BackupVaultOperation {
    constructor(private ctx: BackupVaultContext) {}

    public async execute(
        onProgress?: VaultOperationProgressCallback,
        isAborted: () => boolean = () => false
    ): Promise<BatchResult> {
        const ctx = this.ctx;
        const settings = ctx.getSettings();

        const allFiles = ctx.vault.getFiles().filter((f) =>
            FileFilterPolicy.isMonitored(f.path, settings.monitoredExtensions)
        );

        const result = await WorkerPoolRunner.run({
            items: allFiles,
            concurrency: settings.batchConcurrency || 3,
            getItemPath: (file) => file.path,
            onProgress,
            isAborted,
            processItem: async (file, overallIndex, total) => {
                onProgress?.(overallIndex, total, file.path, 'Creating snapshot...');
                const intent: ManualSaveIntent = {
                    ...VAULT_BACKUP_INTENT_DEFAULTS,
                    id: generateUUID(),
                    path: file.path,
                    file,
                    createdAt: Date.now(),
                };
                const result = await ctx.runner.execute(intent);

                return {
                    status: result.status,
                    actionLabel: 'Creating snapshot...',
                };
            },
        });

        return result;
    }
}
