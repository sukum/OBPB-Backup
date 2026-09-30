import { TFile } from 'obsidian';
import type { DebouncedSaveTask, FailedTaskRecord } from '../types/state';
import type { EntriesWithObjectsViewRecord } from '../types/database';
import type { ExecutionResult } from '../runner/types';
import type { RestoreResult, RestoreVersionOptions } from '../reconstruct/types';
import type {
    BatchResult,
    FileRenameInput,
    OperationsManagerDependencies,
    VaultOperationProgressCallback,
} from './types';

/**
 * Public operations facade. It owns no backup domain logic: every action is
 * delegated to a dedicated operation handler or infrastructure service.
 */
export class OperationsManager {
    constructor(private readonly dependencies: OperationsManagerDependencies) {}

    public async processDebouncedFile(task: DebouncedSaveTask): Promise<void> {
        await this.dependencies.backupFileOp.execute(task);
    }

    public async backupFileNow(file: TFile): Promise<ExecutionResult | null> {
        return this.dependencies.manualFileOp.backupFileNow(file);
    }

    public async snapshotFileNow(file: TFile): Promise<ExecutionResult | null> {
        return this.dependencies.manualFileOp.snapshotFileNow(file);
    }

    public async handleFileRename(input: FileRenameInput, oldPath: string): Promise<void> {
        await this.dependencies.renameFileOp.execute(input, oldPath);
    }

    public async handleFileDelete(input: string | TFile): Promise<void> {
        await this.dependencies.deleteFileOp.execute(input);
    }

    public async retryFailedTask(record: FailedTaskRecord): Promise<void> {
        await this.dependencies.retryFailedTaskOp.execute(record);
    }

    public async backupVault(onProgress?: VaultOperationProgressCallback): Promise<BatchResult> {
        return this.dependencies.vaultBatchCoordinator.backupVault(onProgress);
    }

    public async syncVault(onProgress?: VaultOperationProgressCallback): Promise<BatchResult> {
        return this.dependencies.vaultBatchCoordinator.syncVault(onProgress);
    }

    public async stopVaultOperation(): Promise<void> {
        await this.dependencies.vaultBatchCoordinator.stopVaultOperation();
    }

    public requestShutdown(): void {
        this.dependencies.vaultBatchCoordinator.requestShutdown?.();
    }

    public isOperationRunning(): boolean {
        return this.dependencies.vaultBatchCoordinator.isOperationRunning();
    }

    public async runStartupRecovery(): Promise<void> {
        await this.dependencies.startupRecoveryOp.execute();
    }

    public async reconstructVersion(
        vaultId: string,
        relativePath: string,
        targetHash: string,
        preloadedEntries?: EntriesWithObjectsViewRecord[]
    ): Promise<string> {
        return this.dependencies.reconstructionEngine.reconstructVersion(vaultId, relativePath, targetHash, preloadedEntries);
    }

    public async restoreVersion(
        vaultId: string,
        relativePath: string,
        targetHash: string,
        options?: RestoreVersionOptions
    ): Promise<RestoreResult> {
        const res = await this.dependencies.restoreManager.restoreVersion(
            vaultId,
            relativePath,
            targetHash,
            options
        );
        return res;
    }

    public pauseQueue(): void {
        this.dependencies.automaticQueueManager.pause?.('user');
    }

    public resumeQueue(): void {
        this.dependencies.automaticQueueManager.resume?.('user');
    }

    public isQueuePaused(): boolean {
        return this.dependencies.automaticQueueManager.isPaused?.() ?? false;
    }

    public async retryUploadQueue(): Promise<void> {
        await this.dependencies.automaticQueueManager.retryNow?.();
    }

    public async flushDebouncedFiles(path?: string): Promise<void> {
        if (path) {
            await this.dependencies.debounceController.flushFile(path);
            return;
        }
        await this.dependencies.debounceController.flushAll();
    }

    public async flushAndProcessQueue(): Promise<void> {
        await this.dependencies.debounceController.flushAll();
        await this.dependencies.automaticQueueManager.process?.();
    }
}

export type { FileRenameInput };
