import type { BatchUploadCoordinator } from './types';

/**
 * Serializes the complete prepare-through-publish transaction for every upload
 * source. Keeping preparation inside this lock prevents two operations from
 * deriving payloads from the same stale remote parent.
 * 
 * Used to serialize both automatic and manual/batch upload executions to prevent
 * parentHash divergence across concurrent actions.
 */
export class UploadCoordinator implements BatchUploadCoordinator {
    private activeCount = 0;
    private maxConcurrency = 1;
    private batchActive = false;
    private readonly waitingQueue: Array<() => void> = [];
    private readonly idleWaiters: Array<() => void> = [];

    public isBatchActive(): boolean {
        return this.batchActive;
    }

    public async run<T>(operation: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await operation();
        } finally {
            this.release();
        }
    }

    private acquire(): Promise<void> {
        if (this.activeCount < this.maxConcurrency) {
            this.activeCount++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => this.waitingQueue.push(resolve));
    }

    private release(): void {
        this.activeCount--;
        this.pumpQueue();
    }

    /**
     * Executes an exclusive batch session with bounded concurrency.
     * While the batch session is active, coordinator allows up to the specified concurrency limit.
     */
    public async runBatchSession<T>(
        concurrency: number,
        sessionFn: () => Promise<T>
    ): Promise<T> {
        if (this.batchActive) {
            throw new Error('A batch session is already active');
        }

        this.batchActive = true;
        await this.waitForIdle();
        this.maxConcurrency = Math.max(1, concurrency);
        this.pumpQueue();

        try {
            return await sessionFn();
        } finally {
            await this.waitForIdle();
            this.maxConcurrency = 1;
            this.batchActive = false;
            this.pumpQueue();
        }
    }

    /** Resolves after all active transactions have completed. */
    public async waitForIdle(): Promise<void> {
        if (this.activeCount === 0) {
            return;
        }
        await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }

    private pumpQueue(): void {
        while (this.activeCount < this.maxConcurrency && this.waitingQueue.length > 0) {
            this.activeCount++;
            const next = this.waitingQueue.shift();
            if (next) {
                next();
            }
        }
        if (this.activeCount === 0 && this.idleWaiters.length > 0) {
            const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
            for (const waiter of waiters) {
                waiter();
            }
        }
    }
}
