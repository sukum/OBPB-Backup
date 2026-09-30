import { TFile } from 'obsidian';
import type { DebouncedSaveTask } from '../types/state';
import {
    SAVE_EXECUTION_POLICIES,
    type AutoSaveIntent,
    type BackupFileOperationContext,
    type INTENT_DEFAULT_SPEC_PROPERTIES,
} from './types';

const AUTO_MODIFY_SAVE_INTENT_DEFAULTS = {
    trigger: 'auto',
    event: 'modify',
    operation: 'save',
    policy: SAVE_EXECUTION_POLICIES.AUTO_MODIFY,
} as const satisfies Pick<AutoSaveIntent, INTENT_DEFAULT_SPEC_PROPERTIES>;

/**
 * Converts a debounced vault modification into a lean automatic intent.
 * File reading, hashing, base resolution, and upload preparation belong to
 * PayloadPreparer and SingleFileRunner.
 */
export class BackupFileOperation {
    constructor(private readonly context: BackupFileOperationContext) {}

    public async execute(task: DebouncedSaveTask): Promise<void> {
        const candidate = task.file ?? this.context.vault.getAbstractFileByPath(task.path);
        const intent: AutoSaveIntent = {
            ...AUTO_MODIFY_SAVE_INTENT_DEFAULTS,
            id: task.id,
            path: task.path,
            file: candidate instanceof TFile ? candidate : undefined,
            createdAt: task.timestamp || Date.now(),
        };

        await this.context.queue.enqueue(intent);
    }
}
