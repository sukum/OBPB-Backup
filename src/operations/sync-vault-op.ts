import { FileFilterPolicy } from '../policies/file-filter-policy';
import {
    BASE_EXECUTION_POLICIES,
    SAVE_EXECUTION_POLICIES,
    type ManualSaveIntent,
    type ManualDeleteIntent,
    type VaultOperationProgressCallback,
    type BatchResult,
    type SyncVaultContext,
    type TaskRunner,
    type INTENT_DEFAULT_SPEC_PROPERTIES,
} from './types';
import { WorkerPoolRunner } from './worker-pool-runner';
import type { LatestVaultFilesViewRecord } from '../types/database';
import { generateUUID } from '../utils/uuid';

const VAULT_SYNC_SAVE_INTENT_DEFAULTS = {
    trigger: 'manual',
    event: 'vault-sync',
    operation: 'save',
    policy: SAVE_EXECUTION_POLICIES.BATCH_SYNC,
} as const satisfies Pick<ManualSaveIntent, INTENT_DEFAULT_SPEC_PROPERTIES>;

const VAULT_SYNC_DELETE_INTENT_DEFAULTS = {
    trigger: 'manual',
    event: 'vault-sync',
    operation: 'delete',
    policy: BASE_EXECUTION_POLICIES.BATCH,
} as const satisfies Pick<ManualDeleteIntent, INTENT_DEFAULT_SPEC_PROPERTIES>;

/**
 * Reconciles all monitored files against the remote latest_vault_files view:
 * - Files missing from remote get a snapshot.
 * - Files modified relative to remote get a forward diff (or snapshot fallback).
 * - Unchanged files matching remote hash are skipped.
 * - Remote files that have been deleted from disk trigger a delete event.
 * 
 * Bypasses RecentNotesCache completely for both read and update. Should delete from cache though. Need to check.
 * Reconciles monitored disk files and missing remote deletions via streaming bounded worker pools.
 */
export class SyncVaultOperation {
    constructor(private ctx: SyncVaultContext) {}

    public async execute(
        onProgress?: VaultOperationProgressCallback,
        isAborted: () => boolean = () => false
    ): Promise<BatchResult> {
        const settings = this.ctx.getSettings();

        const allDiskFiles = this.ctx.vault.getFiles().filter((f) =>
            FileFilterPolicy.isMonitored(f.path, settings.monitoredExtensions)
        );

        const vaultId = this.ctx.deviceManager.getVaultId();
        const diskPathSet = new Set(allDiskFiles.map((f) => f.path));

        // Fetch complete remote ground truth before changing remote state.
        const remoteFiles = await this.ctx.store.getLatestFiles(vaultId);

        const remoteFileMap = new Map<string, LatestVaultFilesViewRecord>();
        for (const rf of remoteFiles) {
            remoteFileMap.set(rf.path, rf);
        }
        const remoteDeletionPaths = this.findRemoteDeletionCandidates(remoteFileMap, diskPathSet);
        const totalOperations = allDiskFiles.length + remoteDeletionPaths.length;
        const concurrency = settings.batchConcurrency || 3;

        // Process all monitored files on disk in bounded worker pool
        const result = await WorkerPoolRunner.run({
            items: allDiskFiles,
            concurrency,
            getItemPath: (file) => file.path,
            onProgress,
            isAborted,
            processItem: async (file, overallIndex) => {
                const remote = remoteFileMap.get(file.path);
                const hasActiveBackup = Boolean(remote && remote.operation !== 'delete');
                const actionLabel = hasActiveBackup ? 'Checking diff...' : 'New file (snapshot)...';
                // [Target: UI: Settings View] Report active sync action to settings UI
                onProgress?.(overallIndex, totalOperations, file.path, actionLabel);

                const intent: ManualSaveIntent = {
                    ...VAULT_SYNC_SAVE_INTENT_DEFAULTS,
                    id: generateUUID(),
                    path: file.path,
                    file,
                    createdAt: Date.now(),
                };
                const result = await this.ctx.runner.execute(intent, {
                    bulkRemoteMap: remoteFileMap,
                    disableRecentNotesCache: true,
                });

                return {
                    status: result.status,
                    actionLabel,
                };
            },
        });

        result.totalFiles = totalOperations;

        // Detect missing / deleted files that exist in remote but not on disk
        if (result.stopped || isAborted()) {
            result.stopped = true;
            result.notAttempted = (result.notAttempted ?? 0) + remoteDeletionPaths.length;
        } else {
            await this.reconcileDeletions(remoteDeletionPaths, result, isAborted, this.ctx.runner, concurrency, onProgress);
        }

        return result;
    }

    private findRemoteDeletionCandidates(
        remoteFileMap: Map<string, LatestVaultFilesViewRecord>,
        diskPathSet: Set<string>
    ): string[] {
        return Array.from(remoteFileMap.values())
            .filter((record) =>
                record.operation !== 'delete'
                && !diskPathSet.has(record.path)
            )
            .map((record) => record.path);
    }

    private async reconcileDeletions(
        remoteDeletionPaths: string[],
        result: BatchResult,
        isAborted: () => boolean,
        runner: TaskRunner,
        concurrency: number,
        onProgress?: VaultOperationProgressCallback
    ): Promise<void> {
        const deletesResult = await WorkerPoolRunner.run({
            items: remoteDeletionPaths,
            concurrency,
            getItemPath: (remotePath) => remotePath,
            operation: 'delete',
            isAborted,
            processItem: async (remotePath) => {
                if (this.ctx.vault.getAbstractFileByPath(remotePath)) {
                    return { status: 'skipped' };
                }

                onProgress?.(result.processed + 1, result.totalFiles, remotePath, 'Recording deletion...');
                const deleteIntent: ManualDeleteIntent = {
                    ...VAULT_SYNC_DELETE_INTENT_DEFAULTS,
                    id: generateUUID(),
                    path: remotePath,
                    createdAt: Date.now(),
                };
                const deleteResult = await runner.execute(deleteIntent);
                // if (deleteResult.status === 'uploaded')
                //     result.deleted = (result.deleted ?? 0) + 1;
                return {
                    status: deleteResult.status === 'uploaded' ? 'deleted' : deleteResult.status,
                };
            },
        });
        result.processed += deletesResult.processed ?? 0;
        result.deleted += deletesResult.deleted ?? 0;
        result.skipped += deletesResult.skipped ?? 0;
        result.unchanged += deletesResult.unchanged ?? 0;
        result.uploaded += deletesResult.uploaded ?? 0;
        result.notAttempted = (result.notAttempted ?? 0) + (deletesResult.notAttempted ?? 0);
        result.failed  = (result.failed ?? 0) + (deletesResult.failed ?? 0);
        result.failures = (result.failures ?? []).concat(deletesResult.failures ?? []);
    }
}
