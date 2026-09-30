import { BackupObjectType } from 'src/types/domain';

/** Read-only capability for waiting until the active upload transaction completes. */
export interface UploadIdleWaiter {
    waitForIdle(): Promise<void>;
}

export interface BatchUploadCoordinator extends UploadIdleWaiter {
    isBatchActive(): boolean;
    runBatchSession<T>(
        concurrency: number,
        sessionFn: () => Promise<T>
    ): Promise<T>;
}

interface PreparedUploadBase {
    /** Unique task UUID (strictly inherited from intent.id) */
    id: string;
    device: string;
    vault: string;
    path: string;
    timestamp: number;
    targetHash: string;
    targetObjectId?: string;
}

export interface PreparedSaveUpload extends PreparedUploadBase {
    operation: 'save';
    objectPayload: ObjectUploadPayload;
}

export interface PreparedRenameUpload extends PreparedUploadBase {
    operation: 'rename';
    oldPath: string;
    deleteTimestamp: number;
}

export interface PreparedDeleteUpload extends PreparedUploadBase {
    operation: 'delete';
}

export type PreparedUpload = PreparedSaveUpload | PreparedRenameUpload | PreparedDeleteUpload;


/**
 * Object payload ready for upload to objects collection.
 */
export interface ObjectUploadPayload {
    deterministicId: string;      // 15-char PocketBase ID derived from hash
    hash: string;
    parentHash: string | null;
    type: BackupObjectType;
    data: string;
    dataHash: string;
    diffFormat: string | null;
    size: number;
}
