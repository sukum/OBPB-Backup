import type { ActivityRecord, FailedTaskRecord } from '../types/state';
import type { TaskIntent } from '../operations/types';

/** Input contract for recording a terminal task failure with its diagnostics. */
export type RecordTerminalFailureInput = Omit<FailedTaskRecord, 'timestamp' | 'intent'> & {
    intent: TaskIntent;
};

/** Persistence operations required by ActivityTracker. */
export interface ActivityHistoryPersistence {
    load(limit: number): Promise<ActivityRecord[]>;
    scheduleSave(records: ActivityRecord[], limit: number): void;
    flush(records?: ActivityRecord[], limit?: number): Promise<void>;
}

/** The SAVE journal operation needed by DebounceController. */
export interface DirtyPathWriter {
    markDirty(operation: 'SAVE', path: string): Promise<void>;
}

/** Minimal storage capabilities used by local state managers. */
export interface StateFileReader {
    read(fileName: string): Promise<string | null>;
}

export interface StateFileWriter {
    write(fileName: string, data: string): Promise<void>;
}

export interface StateFileAppender {
    append(fileName: string, data: string): Promise<void>;
}

export interface StateFilePathResolver {
    getPath(fileName: string): string;
}

export interface StateFileReaderWriter extends StateFileReader, StateFileWriter {}

export interface DirtyFileStorage extends StateFileReaderWriter, StateFileAppender {}

export interface FailedTasksStorage extends StateFileReaderWriter, StateFilePathResolver {}
