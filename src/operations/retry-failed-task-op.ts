import { TFile, Notice, type Vault } from 'obsidian';
import type { FailedTaskRecord } from '../types/state';
import type { ExecutionResult } from '../runner/types';
import {
    BASE_EXECUTION_POLICIES,
    type TaskIntent,
    type TaskRunner,
    type ManualFileOperationPort,
    type FailedTaskOperations,
} from './types';
import { DiffEngine } from '../diff/diff-engine';
import { Hasher } from '../hashing/hasher';

const MANUAL_RETRY_INTENT_DEFAULTS = {
    trigger: 'manual',
} as const satisfies Pick<TaskIntent, 'trigger'>;

export interface RetryFailedTaskOperationDependencies {
    vault: Vault;
    runner: TaskRunner;
    manualFileOp: ManualFileOperationPort;
    failedTasksManager: FailedTaskOperations;
    uploadCoordinator?: { isBatchActive(): boolean };
}

/**
 * Decoupled operation for retrying failed tasks recorded in FailedTasksManager.
 * Clones intents with trigger: 'manual' and executes hash-verified backup or snapshot.
 * Safe removal removes the record strictly upon retry success.
 */
export class RetryFailedTaskOperation {
    constructor(private readonly dependencies: RetryFailedTaskOperationDependencies) {}

    public async execute(record: FailedTaskRecord): Promise<void> {
        if (this.dependencies.uploadCoordinator?.isBatchActive?.()) {
            new Notice('[OBPB Backup] Vault backup or sync is in progress. Please wait for it to complete.');
            return;
        }

        const clonedIntent: TaskIntent = record.intent.operation === 'save'
            ? {
                ...record.intent,
                ...MANUAL_RETRY_INTENT_DEFAULTS,
                policy: record.intent.policy,
            }
            : {
                ...record.intent,
                ...MANUAL_RETRY_INTENT_DEFAULTS,
                policy: BASE_EXECUTION_POLICIES.MANUAL,
            };

        try {
            if (clonedIntent.operation === 'save') {
                const abstract = this.dependencies.vault.getAbstractFileByPath(clonedIntent.path);
                if (!(abstract instanceof TFile)) {
                    throw new Error(`File ${clonedIntent.path} no longer exists in vault.`);
                }

                // Verify whether disk content changed since failure
                const raw = await this.dependencies.vault.cachedRead(abstract);
                const normalized = DiffEngine.normalizeNewlines(raw);
                const currentHash = await Hasher.computeHash(normalized);

                let retryResult: ExecutionResult | null;
                if (record.targetHash && currentHash === record.targetHash) {
                    // Unchanged: try auto diff/snapshot backup
                    retryResult = await this.dependencies.manualFileOp.backupFileNow(abstract);
                } else {
                    // Changed or targetHash was never produced: take fresh snapshot
                    retryResult = await this.dependencies.manualFileOp.snapshotFileNow(abstract);
                }
                if (retryResult === null) {
                    throw new Error(`Retry was not run for ${clonedIntent.path}; another backup or vault operation may be active.`);
                }
            } else {
                // Rename or Delete
                await this.dependencies.runner.execute(clonedIntent);
            }

            // Safe removal strictly on success
            await this.dependencies.failedTasksManager.remove(record.id);
        } catch (err) {
            // Update attempts and error on failure to prevent record loss
            record.attempts = (record.attempts || 0) + 1;
            record.error = err instanceof Error ? err.message : String(err);
            record.timestamp = Date.now();
            await this.dependencies.failedTasksManager.updateFailedTask(record);
            throw err;
        }
    }
}
