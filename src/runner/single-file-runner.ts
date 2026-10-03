import type { TaskIntent } from '../operations/types';
import type { PreparationContext, PreparationResult } from '../preparation/types';
import type { PayloadPreparerPort } from '../preparation/payload-preparer';
import type { ActivityLogger } from '../types/state';
import { truncatePayloadPreview } from '../utils/failed-task-payload-preview';
import {
    DirtyFileMarker,
    NoteStateCache,
    RunCoordinator,
    TaskUploadService,
    ExecutionResult,
    RunnerExecutionError,
} from './types';

export class SingleFileRunner {
    constructor(
        private readonly preparer: PayloadPreparerPort,
        private readonly coordinator: RunCoordinator,
        private readonly uploader: TaskUploadService,
        private readonly dirtyFileMarker: DirtyFileMarker,
        private readonly cache: NoteStateCache,
        private readonly logger?: ActivityLogger
    ) {}

    public async execute(intent: TaskIntent, context?: PreparationContext): Promise<ExecutionResult> {
        // Manual and batch runs do not mark dirty-journal entries. Only automatic
        // runs claim and release dirty-journal entries.
        const ownsDirtyJournal = intent.policy.trackDirty;
        if (ownsDirtyJournal) {
            // Mark before waiting for the coordinator
            // Renames claim both the target path and oldPath
            this.dirtyFileMarker.beginFlight(intent.path);
            if (intent.operation === 'rename') {
                this.dirtyFileMarker.beginFlight(intent.oldPath);
            }
        }
        try {
            // Preparation, upload, and reconciliation share one lock so each task
            // resolves its base only after all prior state mutations are complete.
            return await this.coordinator.run(async () => {
                const prep = await this.prepare(intent, context);
                if (prep.kind !== 'ready') { // skipped or unchanged
                    return (prep.kind === 'unchanged')
                    ? this.handleUnchanged(intent, prep, ownsDirtyJournal)
                    : this.handleSkip(intent, prep, ownsDirtyJournal);
                }
                return this.upload(intent, prep, ownsDirtyJournal);
            });
        } finally {
            if (ownsDirtyJournal) {
                this.dirtyFileMarker.endFlight(intent.path);
                if (intent.operation === 'rename') {
                    this.dirtyFileMarker.endFlight(intent.oldPath);
                }
            }
        }
    }

    private async prepare(intent: TaskIntent, context?: PreparationContext): Promise<PreparationResult> {
        // Preparation stage
        try {
            return await this.preparer.prepare(intent, context);
        } catch (err) {
            if (err instanceof RunnerExecutionError) {
                throw err;
            }
            throw new RunnerExecutionError(
                `Preparation failed: ${err instanceof Error ? err.message : String(err)}`,
                'preparation',
                err
            );
        }
    }

    private async handleSkip(
        intent: TaskIntent,
        prep: Extract<PreparationResult, { kind: 'skipped' }>,
        ownsDirtyJournal: boolean
    ): Promise<Extract<ExecutionResult, {status: 'skipped'}>> {
        // process prepared

        // skipped and so ignore
        // An automatic skipped item resolves its journal record; direct
        // work leaves any separately pending automatic work untouched.
        if (ownsDirtyJournal) {
            await this.dirtyFileMarker.markClean(intent.path);
        }
        // automatic runs should log activity
        // Record completion to ActivityTracker so automatic tasks do not remain stuck in 'ongoing'
        if (intent.policy.logActivity) {
            this.logger?.record({
                taskId: intent.id,
                path: intent.path,
                event: intent.operation !== 'save' ? intent.operation : 'modify',
                stage: 'debounce',
                status: 'completed',
                note: prep.reason === 'size_limit_exceeded'
                    ? 'ignored: file size'
                    : prep.reason === 'object_data_limit_exceeded'
                    ? 'ignored: PocketBase object data limit'
                    : prep.reason === 'unmonitored_extension'
                    ? 'ignored: extension'
                    : prep.reason,
            });
        }
        return { status: 'skipped', intent, reason: prep.reason };
    }

    private async handleUnchanged(
        intent: TaskIntent,
        prep: Extract<PreparationResult, { kind: 'unchanged' }>,
        ownsDirtyJournal: boolean
    ): Promise<Extract<ExecutionResult, {status: 'unchanged'}>> {
        if (ownsDirtyJournal) {
            await this.dirtyFileMarker.markClean(intent.path);
        }
        // automatic runs should log activity
        if (intent.policy.logActivity) {
            this.logger?.record({
                taskId: intent.id,
                path: intent.path,
                stage: 'debounce',
                status: 'completed',
                note: 'Unchanged',
            });
        }
        return { status: 'unchanged', intent };
    }

    private async upload(
        intent: TaskIntent,
        prep: Extract<PreparationResult, { kind: 'ready' }>,
        ownsDirtyJournal: boolean
    ): Promise<Extract<ExecutionResult, {status: 'uploaded'}>> {
        // Upload do
        // Upload stage. Activity logging is enabled only for automatic runs (suppressed for batch & direct manual).
        const shouldLogActivity = intent.policy.logActivity;
        try {
            await this.uploader.upload(prep.upload, shouldLogActivity);
        } catch (err) {
            if (err instanceof RunnerExecutionError) {
                throw err;
            }
            const noteSizeBytes = prep.upload.operation === 'save'
                ? prep.upload.objectPayload.size
                : undefined;
            const rawPreview = prep.upload.operation === 'save'
                ? (typeof prep.upload.objectPayload.data === 'string'
                    ? prep.upload.objectPayload.data
                    : JSON.stringify(prep.upload.objectPayload))
                : prep.upload.operation === 'rename'
                ? `Rename ${prep.upload.oldPath} -> ${prep.upload.path}`
                : `Delete ${prep.upload.path}`;
            const payloadPreview = truncatePayloadPreview(rawPreview);
            throw new RunnerExecutionError(
                `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
                'upload',
                err,
                prep.upload,
                noteSizeBytes,
                payloadPreview
            );
        }
        // clean dirty, update cache
        await this.postSuccessfulUpload(intent, prep, ownsDirtyJournal);
        return { status: 'uploaded', intent };
    }

    private async postSuccessfulUpload(
        intent: TaskIntent,
        prep: Extract<PreparationResult, { kind: 'ready' }>,
        ownsDirtyJournal: boolean
    ): Promise<void> {

        // Post-upload dirty file entry clean. This happens only after a
        // successful upload and before the next task can prepare.
        if (ownsDirtyJournal) {
            await this.dirtyFileMarker.markClean(intent.path);
        }
        // For renames, the old path was also marked dirty
        if (intent.operation === 'rename' && ownsDirtyJournal) {
            await this.dirtyFileMarker.markClean(intent.oldPath);
        }

        // A vault batch resolves state from remote context and
        // must leave the cache untouched, including deletions.
        // For non-batch, update cache
        if (intent.policy.updateCache) {
            this.updateCachePostUpload(intent, prep);
        }
    }

    private updateCachePostUpload(
        intent: TaskIntent,
        prep: Extract<PreparationResult, { kind: 'ready' }>
    ): void {
        switch (intent.operation) {
            case 'rename':
                this.cache.delete(intent.oldPath);
                if (prep.content !== undefined) {
                    this.cache.set(intent.path, {
                        path: intent.path,
                        hash: prep.upload.targetHash,
                        baseText: prep.content,
                        diffDepth: prep.newDiffDepth ?? 0,
                        timestamp: prep.upload.timestamp,
                    });
                }
                break;
            case 'delete':
                this.cache.delete(intent.path);
                break;
            case 'save':
                if (prep.content !== undefined) {
                    this.cache.set(intent.path, {
                        path: intent.path,
                        hash: prep.upload.targetHash,
                        baseText: prep.content,
                        diffDepth: prep.newDiffDepth ?? 0,
                        timestamp: prep.upload.timestamp,
                    });
                }
                break;
        }
    }
}
