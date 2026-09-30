import type { SaveIntent } from '../../src/operations/types';

/** Test-side contract mirroring the planned API until production types are added. */
export interface ExecutionPolicyContract {
    readonly logActivity: boolean;
    readonly trackDirty: boolean;
    readonly updateCache: boolean;
}

export interface SaveExecutionPolicyContract extends ExecutionPolicyContract {
    readonly skipIfUnchanged: boolean;
}

export type PlannedSaveIntent = SaveIntent & {
    policy: SaveExecutionPolicyContract;
};

export function executionPolicy(
    overrides: Partial<ExecutionPolicyContract> = {}
): ExecutionPolicyContract {
    return {
        logActivity: overrides.logActivity ?? true,
        trackDirty: overrides.trackDirty ?? true,
        updateCache: overrides.updateCache ?? true,
    };
}

export function saveExecutionPolicy(
    overrides: Partial<SaveExecutionPolicyContract> = {}
): SaveExecutionPolicyContract {
    return {
        ...executionPolicy(overrides),
        skipIfUnchanged: overrides.skipIfUnchanged ?? true,
    };
}
