import type { VaultOperationProgressCallback, BatchResult } from './types';
import type { ExecutionResult } from '../runner/types';

export const DEFAULT_BATCH_SIZE = 100;

export interface TaskItemProcessResult {
    status: ExecutionResult['status'] | 'deleted';
    actionLabel?: string;
}

export interface TaskItemHandler<T> {
    (item: T, overallIndex: number, total: number, batchPrefix?: string): Promise<TaskItemProcessResult | null | void>;
}

export interface RunWorkerPoolOptions<T> {
    items: T[];
    concurrency?: number;
    getItemPath: (item: T) => string;
    operation?: 'save' | 'delete';
    onProgress?: VaultOperationProgressCallback;
    isAborted?: () => boolean;
    processItem: TaskItemHandler<T>;
}

/**
 * Shared streaming bounded worker pool for multi-file vault operations.
 * Bounded by concurrency across items
 * Yields event loop periodically to keep the UI responsive.
 */
export class WorkerPoolRunner {
    public static async run<T>(options: RunWorkerPoolOptions<T>): Promise<BatchResult> {
        const {
            items,
            concurrency = 1,
            getItemPath,
            operation = 'save',
            isAborted = () => false,
            processItem,
        } = options;

        const result: BatchResult = {
            totalFiles: items.length,
            processed: 0,
            uploaded: 0,
            unchanged: 0,
            skipped: 0,
            deleted: 0,
            stopped: false,
            failed: 0,
            notAttempted: 0,
            failures: [],
        };

        if (items.length === 0) {
            return result;
        }

        if (isAborted()) {
            result.stopped = true;
            result.notAttempted = (result.notAttempted ?? 0) + items.length;
            return result;
        }

        const safeConcurrency = Math.max(1, concurrency);
        const workerCount = Math.min(safeConcurrency, items.length);
        let nextIndex = 0;
        let processedInThisRun = 0;

        const workers = Array.from({ length: workerCount }, async () => {
            while (nextIndex < items.length) {
                if (isAborted()) {
                    result.stopped = true;
                    break;
                }

                const i = nextIndex++;
                const item = items[i];
                const overallIndex = i + 1;

                try {
                    const outcome = await processItem(item, overallIndex, items.length, '');
                    switch (outcome?.status) {
                        case 'uploaded':
                            result.uploaded++;
                            break;
                        case 'deleted':
                            result.deleted++;
                            break;
                        case 'unchanged':
                            result.unchanged++;
                            break;
                        case 'skipped':
                        default:
                            result.skipped++;
                            break;
                    }
                } catch (err) {
                    console.error(
                        `[PB Backup] ${
                            operation === 'delete'
                                ? 'Failed recording deletion for missing file'
                                : 'Batch process failed for'
                        } ${getItemPath(item)}:`,
                        err
                    );
                    result.failed = (result.failed ?? 0) + 1;
                    result.failures ??= [];
                    result.failures.push({
                        path: getItemPath(item),
                        operation,
                        reason:  operation === 'delete' ? 'delete_error' : 'upload_error',
                        error: err instanceof Error ? err.message : String(err),
                        timestamp: Date.now(),
                    });
                }

                result.processed++;
                processedInThisRun++;

                // Hand over control to the event loop every 5 items to keep the UI responsive
                if (result.processed % 5 === 0) {
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
            }
        });

        await Promise.all(workers);

        if (isAborted() || result.stopped) {
            result.stopped = true;
            result.notAttempted = (result.notAttempted ?? 0) + Math.max(0, items.length - processedInThisRun);
        }

        return result;
    }
}
