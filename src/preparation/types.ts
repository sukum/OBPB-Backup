import type { PreparedUpload } from '../upload/types';
import type { LatestVaultFilesViewRecord } from '../types/database';
import type { VaultReader } from '../types/obsidian';
import type { DeviceIdentity } from '../operations/types';
import type { DiffComputer } from '../operations/types';
import type { VersionReconstructor } from '../reconstruct/types';
import type { PBBackupSettings } from '../types/settings';
import type { BackupStore } from '../remote/backup-store';
import type { NoteStateCache } from '../runner/types';

export interface PreparationContext {
    bulkRemoteMap?: Map<string, LatestVaultFilesViewRecord>;
    disableRecentNotesCache?: boolean;
}

export type PreparationSkippedReason =
    | 'unmonitored_extension'
    | 'size_limit_exceeded'
    | 'object_data_limit_exceeded'
    | 'missing_file'
    | 'untracked_deletion';

export type PreparationReadyResult = {
    kind: 'ready';
    upload: PreparedUpload;
    content?: string;
    newDiffDepth?: number;
}

export type PreparationUnchangedResult = {
    kind: 'unchanged';
    path: string;
}

export type PreparationSkippedResult = {
    kind: 'skipped';
    path: string;
    reason: PreparationSkippedReason;
}

export type PreparationResult =
    | PreparationReadyResult
    | PreparationUnchangedResult
    | PreparationSkippedResult;

export interface PayloadPreparerDependencies {
    vault: VaultReader;
    deviceManager: DeviceIdentity;
    cache: NoteStateCache;
    store: BackupStore;
    diffComputer: DiffComputer;
    reconstructionEngine: VersionReconstructor;
    getSettings: () => PBBackupSettings;
}
