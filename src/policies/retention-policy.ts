import type { ActivityRecord } from '../types/state';

/**
 * Policy evaluating retention limits and log-trimming.
 * Enforces bounded history while keeping ongoing/active processes intact.
 * Trim activity logs to limit, while preserving records with status 'ongoing'.
 */
export class RetentionPolicy {
    /**
     * Trims activity records to a bounded limit.
     * Rules:
     * - If total records <= limit, returns all records unchanged.
     * - Preserves all active ('ongoing') records unconditionally.
     * - Trims the oldest finished ('completed' or 'cancelled' or 'failed') records first.
     * - Returns the resulting list sorted chronologically (oldest first).
     */
    public static trimActivityRecords(records: ActivityRecord[], limit: number): ActivityRecord[] {
        if (records.length <= limit) {
            return records;
        }

        const ongoing = records.filter(r => r.status === 'ongoing');
        const finished = records.filter(r => r.status !== 'ongoing');

        // Sort finished records ascending (oldest first)
        finished.sort((a, b) => a.timestamp - b.timestamp);

        const allowedFinishedCount = Math.max(0, limit - ongoing.length);
        const keptFinished = finished.slice(finished.length - allowedFinishedCount);

        // Re-combine and sort chronologically (oldest first, newest appended at end)
        const combined = [...ongoing, ...keptFinished];
        combined.sort((a, b) => a.timestamp - b.timestamp);
        return combined;
    }
}
