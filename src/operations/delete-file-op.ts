import { TFile } from 'obsidian';
import { PathUtils } from '../utils/path-utils';
import { generateUUID } from '../utils/uuid';
import {
    BASE_EXECUTION_POLICIES,
    type AutoDeleteIntent,
    type DeleteFileOperationContext,
    type INTENT_DEFAULT_SPEC_PROPERTIES,
} from './types';

const AUTO_DELETE_INTENT_DEFAULTS = {
    trigger: 'auto',
    event: 'delete',
    operation: 'delete',
    policy: BASE_EXECUTION_POLICIES.AUTO,
} as const satisfies Pick<AutoDeleteIntent, INTENT_DEFAULT_SPEC_PROPERTIES>;

/** Records an automatic deletion before queuing the corresponding lean intent. */
export class DeleteFileOperation {
    constructor(private readonly context: DeleteFileOperationContext) {}

    public async execute(input: string | TFile): Promise<void> {
        const path = PathUtils.normalize(typeof input === 'string' ? input : input.path);
        const id = generateUUID();

        this.context.debounceController.cancel(path);
        await this.context.dirtyFileManager.markDirty('DELETE', path);

        const intent: AutoDeleteIntent = {
            ...AUTO_DELETE_INTENT_DEFAULTS,
            id,
            path,
            createdAt: Date.now(),
        };
        await this.context.queue.enqueue(intent);
    }
}
