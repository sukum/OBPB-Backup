import { PrepareSave } from './prepare-save';
import { PrepareDelete } from './prepare-delete';
import type {
    TaskIntent,
} from '../operations/types';

import type { PreparationResult, PreparationContext } from './types';
import type { PayloadPreparerDependencies } from './types';
import { PrepareRename } from './prepare-rename';

/**
 * Consolidates file reading, extension/size checks,
 * remote PocketBase queries, version reconstruction, and diff calculations.
 */
export interface PayloadPreparerPort {
    prepare(intent: TaskIntent, context?: PreparationContext): Promise<PreparationResult>;
}

export class PayloadPreparer implements PayloadPreparerPort {
    constructor(private readonly deps: PayloadPreparerDependencies) {}

    /**
     * Prepares an un-prepared TaskIntent for transport upload.
     */
    public async prepare(intent: TaskIntent, context?: PreparationContext): Promise<PreparationResult> {
        const operation = intent.operation;
        switch (operation) {
            case 'save':
                return (new PrepareSave(this.deps)).prepare(intent, context);
            case 'rename':
                return (new PrepareRename(this.deps)).prepare(intent, context);
            case 'delete':
                return (new PrepareDelete(this.deps)).prepare(intent, context);
            default:
                throw new Error(`Unsupported intent operation: ${operation}`);
        }
    }
}
