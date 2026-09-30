import { OBPBBackupSettings } from '../types/settings';

/**
 * Evaluates whether the next backup of a file should be a full snapshot or a diff.
 * 
 * Rules:
 * - Initial version (no parent hash or undefined diff depth) is always a snapshot.
 * - Files between 5 MB and 10 MB are snapshot-only (skips diffing to prevent app freeze).
 * - Files > 10 MB are skipped (exceeds text limits).
 * - Force snapshot if diffDepth >= maxDiffsBetweenSnapshots (default 50).
 */
export class SnapshotPolicy {
    public static readonly MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB hard cap

    /**
     * Checks if a file should be completely skipped from backup.
     */
    public static shouldSkipFile(fileSizeBytes: number): boolean {
        return fileSizeBytes > this.MAX_FILE_SIZE_BYTES;
    }

    /**
     * Checks if a file must be backed up as a snapshot only (skipping diff calculation).
     */
    public static isSnapshotOnly(fileSizeBytes: number, settings: OBPBBackupSettings): boolean {
        const thresholdBytes = settings.maxFileSizeMb * 1024 * 1024;
        return fileSizeBytes >= thresholdBytes;
    }

    /**
     * Evaluates snapshot requirement for a file backup based on file size and diff depth.
     */
    public static isSnapshotRequired(
        fileSizeBytes: number,
        diffDepth: number | undefined,
        settings: OBPBBackupSettings,
        hasParentHash: boolean = true
    ): boolean {
        // Initial version must always be a snapshot
        if (!hasParentHash || diffDepth === undefined) {
            return true;
        }

        // Large file rule (5MB - 10MB)
        if (this.isSnapshotOnly(fileSizeBytes, settings)) {
            return true;
        }

        // Bound on version chain depth (default 50)
        if (diffDepth >= settings.maxDiffsBetweenSnapshots) {
            return true;
        }

        return false;
    }
}
