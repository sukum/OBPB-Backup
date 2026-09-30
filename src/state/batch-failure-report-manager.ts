import { LocalDataStorage } from './local-data-storage';
import type { BackupOperation, BatchBackupEventType } from '../types/domain';

export interface BatchFailure {
    path: string;
    operation: BackupOperation;
    reason: string;
    error: string;
    timestamp: number;
}

export interface BatchFailureReport {
    batchId: string;
    kind: BatchBackupEventType;
    startedAt: number;
    completedAt: number;
    total: number;
    succeeded: number;
    failed: number;
    notAttempted: number;
    stopReason?: 'offline' | 'auth_required' | 'user_stopped';
    failures: BatchFailure[];
}

/** Session-only batch reports. They are intentionally removed on the next startup. */
export class BatchFailureReportManager {
    public static readonly DIRECTORY = 'batch_failures';
    public constructor(private readonly storage: LocalDataStorage) {}

    /**
     * Each batch operation generates its own failure report file.
     * Need to check if the returned path is shown to user.
     * And if Vault.getResourcePath() can be used to display the file to the user
     */
    public async write(report: BatchFailureReport): Promise<string | null> {
        if (report.failed === 0) return null;
        const timestamp = new Date(report.completedAt).toISOString().replace(/[:.]/g, '-');
        const fileName = `${BatchFailureReportManager.DIRECTORY}/${report.kind}-${timestamp}-${report.batchId}.json`;
        await this.storage.write(fileName, JSON.stringify(report, null, 2));
        return this.storage.getPath(fileName);
    }

    /** Clear on startup */
    public async clearPreviousSessionReports(): Promise<void> {
        const adapter = this.storage.getAdapter();
        const directory = this.storage.getPath(BatchFailureReportManager.DIRECTORY);
        if (!(await adapter.exists(directory))) return;

        // Obsidian's DataAdapter exposes `list`; the guard keeps lightweight test
        // adapters from failing plugin startup.
        if (typeof adapter.list !== 'function') return;
        const contents = await adapter.list(directory);
        for (const file of contents.files) {
            await adapter.remove(file);
        }
    }
}
