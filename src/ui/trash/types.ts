
import type { RestoreResult, RestoreVersionOptions } from '../../reconstruct/types';

export interface TrashRestoreAction {
    restoreVersion(
        vaultId: string,
        relativePath: string,
        targetHash: string,
        options?: RestoreVersionOptions
    ): Promise<RestoreResult>;
}

export interface TrashModalOperations extends TrashRestoreAction {
    reconstructVersion(vaultId: string, relativePath: string, targetHash: string): Promise<string>;
}
