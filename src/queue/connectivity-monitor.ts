/** A dependency capable of checking whether the remote service is reachable. */
export interface ConnectivityChecker {
    healthCheck(): Promise<void>;
}

/**
 * Probes an unavailable remote service with bounded exponential backoff.
 * It owns no queue state: callers retain the failed FIFO head
 * until the supplied recovery callback starts processing again.
 */
export class ConnectivityMonitor {
    public static readonly INITIAL_DELAY_MS = 5_000;
    public static readonly MAX_DELAY_MS = 5 * 60_000;

    private probeTimeout: number | null = null;
    private delayMs: number;
    private isProbing = false;
    private generation = 0;

    constructor(
        private checker: ConnectivityChecker,
        private initialDelayMs = ConnectivityMonitor.INITIAL_DELAY_MS
    ) {
        this.delayMs = initialDelayMs;
    }

    public isProbeScheduled(): boolean {
        return this.probeTimeout !== null || this.isProbing;
    }

    /** Starts recovery probing, if it is not already underway. */
    public waitForRecovery(onRecovered: () => void): void {
        if (this.isProbeScheduled()) return;
        this.scheduleProbe(onRecovered);
    }

    public cancel(): void {
        this.generation++;
        if (this.probeTimeout) {
            window.clearTimeout(this.probeTimeout);
            this.probeTimeout = null;
        }
        this.isProbing = false;
        this.delayMs = this.initialDelayMs;
    }

    private scheduleProbe(onRecovered: () => void): void {
        const generation = this.generation;
        this.probeTimeout = window.setTimeout(async () => {
            this.probeTimeout = null;
            this.isProbing = true;
            try {
                await this.checker.healthCheck();
                // Cancelled ?
                if (generation !== this.generation) return;
                this.delayMs = this.initialDelayMs;
                // Clear this before recovery so QueueProcessor can proceed.
                this.isProbing = false;
                // connectivity recovered callback called
                // queue processor resume("offline")
                onRecovered();
            } catch {
                // Cancelled ?
                if (generation !== this.generation) return;
                this.delayMs = Math.min(this.delayMs * 2, ConnectivityMonitor.MAX_DELAY_MS);
                this.isProbing = false;
                this.scheduleProbe(onRecovered);
                return;
            }
            this.isProbing = false;
        }, this.delayMs);
    }
}
