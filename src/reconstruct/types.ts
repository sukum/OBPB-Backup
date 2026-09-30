import type { TFile } from 'obsidian';
import type { EntriesWithObjectsViewRecord } from '../types/database';
import type { ExecutionResult } from '../runner/types';

/** Reconstructs a historical version, optionally using already loaded entries. */
export interface VersionReconstructor {
    reconstructVersion(
        vault: string,
        path: string,
        targetHash: string,
        entries?: EntriesWithObjectsViewRecord[]
    ): Promise<string>;
}

/** Per-call options for restoring a historical version. */
export interface RestoreVersionOptions {
    /** Explicit override for the safetyBackupBeforeRestore setting. */
    takeSafetyBackup?: boolean;
    /** Optional pre-fetched entry records to avoid fetching from store again. */
    entries?: EntriesWithObjectsViewRecord[];
    /**
     * Optional pre-rendered content (e.g. from HistoryModal).
     * If provided, RestoreManager cryptographically verifies its SHA-256 against targetHash.
     * If valid, it skips re-traversing the DAG and re-applying diffs.
     */
    knownContent?: string;
    /** Optional notification callback for user feedback. */
    notify?: (message: string) => void;
}

export type RestoreStatus = 'modified' | 'created' | 'unchanged';

export interface RestoreResult {
    status: RestoreStatus;
    path: string;
}

/** Backs up the current local file before a restore overwrites it. */
export type SafetyBackupPerformer = (file: TFile) => Promise<ExecutionResult | null>;
