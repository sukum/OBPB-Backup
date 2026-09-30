import type { RestoreResult, RestoreVersionOptions } from '../../reconstruct/types';

export interface NoteHistoryOperations {
    reconstructVersion(vaultId: string, path: string, hash: string): Promise<string>;
    restoreVersion(vaultId: string, path: string, hash: string, options?: RestoreVersionOptions): Promise<RestoreResult>;
}

export interface NoteHistoryBuildContext {
    getVaultId: () => string;
    operationsManager: NoteHistoryOperations;
}
