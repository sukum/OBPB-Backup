import { PBBackupSettings } from '../types/settings';

/**
 * Decides whether restoring a version should first take a safety backup
 * of the current local file. Callers only invoke this when a local file
 * actually exists (there is nothing to back up for deleted-file recovery).
 *
 * Rules:
 * - An explicit per-call override wins over the persisted setting.
 * - Otherwise the user's safetyBackupBeforeRestore setting applies.
 */
export class RestoreSafetyPolicy {
    public static shouldTakeSafetyBackup(
        settings: PBBackupSettings,
        takeSafetyBackupOverride?: boolean
    ): boolean {
        return takeSafetyBackupOverride ?? settings.safetyBackupBeforeRestore;
    }
}
