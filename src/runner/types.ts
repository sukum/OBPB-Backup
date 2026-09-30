import type { TaskIntent } from '../operations/types';
import type { CachedNoteState, FailedTaskStage } from '../types/state';
import type { PreparedUpload } from '../upload/types';

export interface DirtyFileMarker {
    beginFlight(path: string): void;
    endFlight(path: string): void;
    markClean(path: string): Promise<void>;
}

export interface NoteStateCache {
    has(path: string): boolean;
    get(path: string): CachedNoteState | undefined;
    set(path: string, state: CachedNoteState): void;
    delete(path: string): boolean;
}

export interface RunCoordinator {
    run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface TaskUploadService {
    upload(task: PreparedUpload, logActivity?: boolean): Promise<void>;
}

// export interface ExecutionResult {
//     status: 'uploaded' | 'unchanged' | 'skipped';
//     intent: TaskIntent;
//     reason?: string;
// }
export type ExecutionResult =
  | { status: 'uploaded'; intent: TaskIntent }
  | { status: 'unchanged'; intent: TaskIntent }
  | { status: 'skipped'; intent: TaskIntent; reason?: string };

export class RunnerExecutionError extends Error {
    constructor(
        message: string,
        public readonly phase: FailedTaskStage,
        public readonly cause: unknown,
        public readonly preparedUpload?: PreparedUpload,
        public readonly noteSizeBytes?: number,
        public readonly payloadPreview?: string
    ) {
        super(message);
        this.name = 'RunnerExecutionError';
    }
}
