import { DEFAULT_ACTIVITY_HISTORY_LIMIT } from '../state/constants';

/**
 * User configuration settings for OBPB Backup.
 */

export interface OBPBBackupSettings {
    serverUrl: string;                  // e.g. "https://backup.example.com"
    userEmail: string;                  // Account email
    vaultId: string;                    // Logical vault UUID // automated and readonly
    debounceIntervalMs: number;         // Default: 30000 ms (30 seconds)
    maxWaitMs: number;                  // Default: 300000 ms (5 mins, milestone timer)
    maxDiffsBetweenSnapshots: number;   // Default: 50
    monitoredExtensions: string[];      // Default: ["md", "canvas"]
    maxFileSizeMb: number;              // Default: 5 MB // DB data field legth 5M
                                        // Should leave it higher on db and lower in code. TODO.
    safetyBackupBeforeRestore: boolean; // Default: true
    activityHistoryLimit: number;       // Default: 100 (max completed records retained on disk)
    activityManagerRefreshSec: number;  // Default: 2 (refresh cadence in seconds)
    batchConcurrency: number;           // Default: 3 (max concurrent uploads in backup/sync)
}

// export const DEFAULT_SETTINGS: Readonly<OBPBBackupSettings> = {
export const DEFAULT_SETTINGS = {
    serverUrl: '',
    userEmail: '',
    vaultId: '',
    debounceIntervalMs: 30000,
    maxWaitMs: 300000,
    maxDiffsBetweenSnapshots: 50,
    monitoredExtensions: ['md', 'canvas'],
    maxFileSizeMb: 5,
    safetyBackupBeforeRestore: true,
    activityHistoryLimit: DEFAULT_ACTIVITY_HISTORY_LIMIT,
    activityManagerRefreshSec: 2,
    batchConcurrency: 3,
} as const satisfies Readonly<OBPBBackupSettings>;

export const SETTINGS_STRING_KEYS = ['serverUrl', 'userEmail', 'vaultId'] as const satisfies readonly (keyof OBPBBackupSettings)[];
export const SETTINGS_NUMBER_KEYS = [
    'debounceIntervalMs',
    'maxWaitMs',
    'maxDiffsBetweenSnapshots',
    'maxFileSizeMb',
    'activityHistoryLimit',
    'activityManagerRefreshSec',
    'batchConcurrency',
] as const satisfies readonly (keyof OBPBBackupSettings)[];
