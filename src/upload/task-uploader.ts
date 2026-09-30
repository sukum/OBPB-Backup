import type { BackupStore } from '../remote/backup-store';
import type { ActivityLogger } from '../types/state';
import type { PreparedUpload } from './types';
import type { CreateBackupObject, CreateHistoryEntry } from '../types/database';
import { Hasher } from '../hashing/hasher';

/**
 * Executes the 2-step idempotent upload pipeline
 * Object is uploaded and confirmed before Entry is added.
 * Fully decoupled from in-memory queue management and timers.
 */
export class TaskUploader {
    constructor(
        private store: BackupStore,
        private logger?: ActivityLogger
    ) {}

    /**
     * Executes the upload for a single task.
     * When logActivity is false, activity log events are suppressed (e.g. for batch or manual direct operations).
     */
    public async upload(task: PreparedUpload, logActivity: boolean = true): Promise<void> {
        const logger = logActivity ? this.logger : undefined;
        let objectId = task.targetObjectId;

        // Step 1: Upload object if payload exists (Save operations)
        if (task.operation === 'save' && task.objectPayload) {
            // [Target: State: ActivityTracker] Record object upload stage in activity log
            logger?.record({
                taskId: task.id,
                path: task.path,
                stage: 'upload',
                status: 'active',
                note: 'Uploading Object...',
            });
            const objRecord: CreateBackupObject = {
                id: task.objectPayload.deterministicId,
                vault: task.vault,
                hash: task.objectPayload.hash,
                parentHash: task.objectPayload.parentHash,
                type: task.objectPayload.type,
                data: task.objectPayload.data,
                dataHash: task.objectPayload.dataHash,
                diffFormat: task.objectPayload.diffFormat,
                encoding: 'none',
                size: task.objectPayload.size,
            };

            try {
                await this.store.putObject(objRecord);
            } catch (error: unknown) {
                logger?.record({
                    taskId: task.id,
                    path: task.path,
                    stage: 'upload',
                    status: 'failed',
                    note: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
            objectId = objRecord.id;
            // [Target: State: ActivityTracker] Record entry upload stage in activity log
            logger?.record({
                taskId: task.id,
                path: task.path,
                stage: 'upload',
                status: 'active',
                note: 'Uploaded Object',
            });
        }

        // If targetObjectId was not supplied (e.g. renames/deletes pointing to existing objects)
        if (!objectId) {
            const existingObj = await this.store.getObject(task.vault, task.targetHash);
            if (existingObj) {
                objectId = existingObj.id;
            } else {
                throw new Error(`Target object not found for hash ${task.targetHash}`);
            }
        }

        // Step 2: Upload History Entry
        // [Target: State: ActivityTracker] Record entry upload stage in activity log
        logger?.record({
            taskId: task.id,
            path: task.path,
            stage: 'upload',
            status: 'active',
            note: 'Uploading Entry...',
        });

        try {
            if (task.operation === 'rename') {
                // Idempotent Two-Step Rename Entry Publication
                // Upload a delete entry for oldPath at deleteTimestamp
                const deleteTimestamp = task.deleteTimestamp ?? (task.timestamp - 1);
                const deleteEntryId = await Hasher.deriveEntryId(
                    task.device,
                    task.vault,
                    task.oldPath,
                    null,
                    'delete',
                    objectId,
                    deleteTimestamp
                );
                const deleteEntryRecord: CreateHistoryEntry = {
                    id: deleteEntryId,
                    vault: task.vault,
                    path: task.oldPath,
                    oldPath: null,
                    objectId,
                    hash: task.targetHash,
                    operation: 'delete',
                    device: task.device,
                    timestamp: deleteTimestamp,
                };
                await this.store.addEntry(deleteEntryRecord);

                // Upload a rename entry for path (with oldPath) at timestamp
                const renameEntryId = await Hasher.deriveEntryId(
                    task.device,
                    task.vault,
                    task.path,
                    task.oldPath,
                    'rename',
                    objectId,
                    task.timestamp
                );
                const renameEntryRecord: CreateHistoryEntry = {
                    id: renameEntryId,
                    vault: task.vault,
                    path: task.path,
                    oldPath: task.oldPath,
                    objectId,
                    hash: task.targetHash,
                    operation: 'rename',
                    device: task.device,
                    timestamp: task.timestamp,
                };
                await this.store.addEntry(renameEntryRecord);
            } else {
                // Standard single entry publication for save or delete
                const entryId = await Hasher.deriveEntryId(
                    task.device,
                    task.vault,
                    task.path,
                    null,
                    task.operation,
                    objectId,
                    task.timestamp
                );

                const entryRecord: CreateHistoryEntry = {
                    id: entryId,
                    vault: task.vault,
                    path: task.path,
                    oldPath: null,
                    objectId,
                    hash: task.targetHash,
                    operation: task.operation,
                    device: task.device,
                    timestamp: task.timestamp,
                };
                await this.store.addEntry(entryRecord);
            }
        } catch (error: unknown) {
            logger?.record({
                taskId: task.id,
                path: task.path,
                stage: 'upload',
                status: 'failed',
                note: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }

        // [Target: State: ActivityTracker] Record entry upload stage in activity log
        logger?.record({
            taskId: task.id,
            path: task.path,
            stage: 'upload',
            status: 'completed',
            note: 'Uploaded',
        });
    }
}
