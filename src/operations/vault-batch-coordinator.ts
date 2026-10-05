import { Notice } from 'obsidian';
import type {
    VaultOperationProgressCallback,
    BatchResult,
    VaultBatchOperationPort,
    BatchFailureReportWriter,
    QueuePauseResume
} from './types';
import type { BatchUploadCoordinator } from '../upload/types';
import { generateUUID } from '../utils/uuid';
import { type PBBackupSettings, DEFAULT_SETTINGS } from '../types/settings';
import { type BatchBackupEventType } from '../types/domain';

export interface VaultBatchCoordinatorDependencies {
    automaticQueueManager: QueuePauseResume;
    uploadCoordinator: BatchUploadCoordinator;
    batchFailureReportManager: BatchFailureReportWriter;
    backupVaultOp: VaultBatchOperationPort;
    syncVaultOp: VaultBatchOperationPort;
    getSettings: () => Partial<Pick<PBBackupSettings, 'batchConcurrency'>>;
}

/**
 * Coordinates mutual exclusion, queue pausing ('manual-batch'), abort signaling,
 * and failure reporting for multi-file vault operations (backupVault and syncVault).
 */
export class VaultBatchCoordinator {
    // To stop the backup/sync vault operations when the user clicks stop
    private abortVaultOp = false;
    private isVaultOpRunning = false;
    // When tearDown is requested on app unload
    private isShuttingDown = false;
    private currentVaultOpPromise: Promise<BatchResult> | null = null;

    constructor(private readonly dependencies: VaultBatchCoordinatorDependencies) {}

    public isOperationRunning(): boolean {
        return this.isVaultOpRunning;
    }

    /**
     * Signals running vault operations to stop and waits until they have fully exited.
     * Called by user clicking stop btn
     */
    public async stopVaultOperation(): Promise<void> {
        this.abortVaultOp = true;
        if (this.currentVaultOpPromise) {
            try {
                await this.currentVaultOpPromise;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                new Notice(`Vault operation aborted or failed: ${msg}`);
            }
        }
        this.currentVaultOpPromise = null;
    }

    /** 
     * Signals a running batch to stop without waiting for its current operation.
     * Called during app unload by tearDown through operation manager requestShutdown
     */
    public requestShutdown(): void {
        this.isShuttingDown = true;
        this.abortVaultOp = true;
    }

    /**
     * Performs a blind snapshot of all monitored files in the vault.
     */
     public async backupVault(onProgress?: VaultOperationProgressCallback): Promise<BatchResult> {
        return this.runGuardedVaultOp('vault-backup', (isAborted) =>
            this.dependencies.backupVaultOp.execute(onProgress, isAborted)
        );
    }

    /**
     * Reconciles all monitored files against remote latest_vault_files.
     */
    public async syncVault(onProgress?: VaultOperationProgressCallback): Promise<BatchResult> {
        return this.runGuardedVaultOp('vault-sync', (isAborted) =>
            this.dependencies.syncVaultOp.execute(onProgress, isAborted)
        );
    }

    /**
     * Helper to guard vault operations with mutual exclusion, queue pausing, and abort signaling.
     */
    private async runGuardedVaultOp(
        kind:  BatchBackupEventType,
        operation: (isAborted: () => boolean) => Promise<BatchResult>
    ): Promise<BatchResult> {
        if (this.isShuttingDown) return this.createStoppedResult();
        if (this.isVaultOpRunning) {
            throw new Error('A vault backup or sync operation is already running.');
        }

        this.isVaultOpRunning = true;
        this.abortVaultOp = false;
        const startedAt = Date.now();
        const concurrency = this.dependencies.getSettings().batchConcurrency ?? DEFAULT_SETTINGS.batchConcurrency;

        try {
            // Automatic events continue to persist while a manual batch is active,
            // but their dispatch waits until the batch releases this pause.
            this.dependencies.automaticQueueManager.pause('manual-batch');

            const executeSession = async () => {
                if (this.isShuttingDown) return this.createStoppedResult();

                const opPromise = operation(() => this.abortVaultOp);
                this.currentVaultOpPromise = opPromise;
                const result = await opPromise;
                if (!this.isShuttingDown) {
                    await this.writeBatchFailureReport(kind, startedAt, result);
                }
                return result;
            };

            const uploadCoordinator = this.dependencies.uploadCoordinator;
            return await uploadCoordinator.runBatchSession(
                concurrency,
                executeSession
            );
            // } else {
            //     await uploadCoordinator?.waitForIdle();
            //     return await executeSession();
            // }
        } finally {
            this.isVaultOpRunning = false;
            if (!this.isShuttingDown) this.abortVaultOp = false;
            this.currentVaultOpPromise = null;
            if (!this.isShuttingDown) {
                this.dependencies.automaticQueueManager.resume('manual-batch');
            }
        }
    }

    private createStoppedResult(): BatchResult {
        return {
            totalFiles: 0,
            processed: 0,
            uploaded: 0,
            unchanged: 0,
            skipped: 0,
            deleted: 0,
            stopped: true,
            failed: 0,
            notAttempted: 0,
            failures: [],
        };
    }

    private async writeBatchFailureReport(
        kind:  BatchBackupEventType,
        startedAt: number,
        result: BatchResult
    ): Promise<void> {
        if (!this.dependencies.batchFailureReportManager || !result.failed) return;
        await this.dependencies.batchFailureReportManager.write({
            batchId: generateUUID(),
            kind,
            startedAt,
            completedAt: Date.now(),
            total: result.totalFiles,
            succeeded: Math.max(0, result.processed - result.failed),
            failed: result.failed,
            notAttempted: result.notAttempted || 0,
            stopReason: result.stopped ? 'user_stopped' : undefined,
            failures: result.failures || [],
        });
    }
}
