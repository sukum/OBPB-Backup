import { TFile, Notice, type Vault } from 'obsidian';
import type { BatchUploadCoordinator } from '../upload/types';
import {
    SAVE_EXECUTION_POLICIES,
    type ManualSaveIntent,
    type TaskCreator,
    type DebounceScheduler,
    type TaskRunner,
    type INTENT_DEFAULT_SPEC_PROPERTIES,
} from './types';
import type { ExecutionResult } from '../runner/types';
import { generateUUID } from '../utils/uuid';

// type INTENT_SPEC_PROPERTIES = Exclude<INTENT_DEFAULT_SPEC_PROPERTIES, 'policy'>;
const MANUAL_MODIFY_SAVE_INTENT_DEFAULTS = {
    trigger: 'manual',
    event: 'modify',
    operation: 'save',
} as const satisfies Pick<ManualSaveIntent, Exclude<INTENT_DEFAULT_SPEC_PROPERTIES, 'policy'>>;

export interface ManualFileOperationDependencies {
    vault: Vault;
    runner: TaskRunner;
    taskFactory: TaskCreator;
    debounceController: DebounceScheduler;
    uploadCoordinator?: Pick<BatchUploadCoordinator, 'isBatchActive'>;
}

/**
 * Handles immediate single-file manual backups with per-file concurrency mutexing
 * and re-dirtied tracking, delegating execution directly to SingleFileRunner.
 */
export class ManualFileOperation {
    private inFlightProcessing = new Map<string, Promise<ExecutionResult | null>>();
    private reDirtiedDuringFlight = new Set<string>();

    constructor(private readonly dependencies: ManualFileOperationDependencies) {}

    public async backupFileNow(file: TFile): Promise<ExecutionResult | null> {
        return this.executeFile(file, 'auto');
    }

    public async snapshotFileNow(file: TFile): Promise<ExecutionResult | null> {
        return this.executeFile(file, 'snapshot');
    }

    private async executeFile(file: TFile, mode: 'auto' | 'snapshot'): Promise<ExecutionResult | null> {
        if (this.dependencies.uploadCoordinator?.isBatchActive?.()) {
            new Notice('[PB Backup] Vault backup or sync is in progress. Please wait for it to complete.');
            return null;
        }

        const path = file.path;

        // A duplicate call may reflect an edit made during the active run.
        if (this.inFlightProcessing.has(path)) {
            this.reDirtiedDuringFlight.add(path);
            return null;
        }

        // Build lean manual intent
        const intent: ManualSaveIntent = {
            ...MANUAL_MODIFY_SAVE_INTENT_DEFAULTS,
            id: generateUUID(),
            path: file.path,
            policy: mode === 'snapshot'
                ? SAVE_EXECUTION_POLICIES.MANUAL_SNAPSHOT
                : SAVE_EXECUTION_POLICIES.MANUAL_SYNC,
            file,
            mode,
            createdAt: Date.now(),
        };

        // 3. Register execution in flight
        const flightPromise = this.dependencies.runner.execute(intent);
        this.inFlightProcessing.set(path, flightPromise);

        let result: ExecutionResult | null;
        try {
            result = await flightPromise;
        } finally {
            this.inFlightProcessing.delete(path);
        }

        // 4. Post-execution reconciliation: if edits occurred during flight, reschedule to debounce
        if (this.reDirtiedDuringFlight.has(path)) {
            this.reDirtiedDuringFlight.delete(path);
            const candidate = file || this.dependencies.vault.getAbstractFileByPath(path);
            if (candidate instanceof TFile) {
                const redirtyTask = this.dependencies.taskFactory.createSaveTask(candidate);
                await this.dependencies.debounceController.schedule(redirtyTask);
            }
        }

        return result ?? null;
    }
}
