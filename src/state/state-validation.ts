import type {
    ActivityHistoryState,
    ActivityRecord,
    DeviceState,
    DirtyFileEntry,
    FailedTaskLikelyReason,
    FailedTaskRecord,
} from '../types/state';
import {
    ACTIVITY_STAGE_STATUSES,
    FAILED_TASK_LIKELY_REASONS,
    LOGGED_ACTIVITY_STATUSES,
} from '../types/state';
import {
    INTENT_EVENTS,
    INTENT_TRIGGERS,
    serializeTaskIntent,
    type IntentEvent,
    type SaveExecutionPolicy,
    type TaskExecutionPolicy,
    type TaskIntent,
} from '../operations/types';

import { BACKUP_EVENTS, BACKUP_MODES, BACKUP_OPERATIONS } from '../types/domain';
import type { BackupOperationUpper } from '../types/domain';
import { LOCAL_STATE_VERSION } from './constants';
import { isRecord } from '../utils/guards';
import { truncatePayloadPreview } from '../utils/failed-task-payload-preview';

export function isString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

export function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
// Type guard to safely validate the operation string
const isBackupOperationUpper = (value: unknown): value is BackupOperationUpper => {
    if (typeof value !== 'string') return false;
    const normalized = value.toUpperCase();
    return (BACKUP_OPERATIONS as readonly string[]).some((operation) => operation.toUpperCase() === normalized);
};

export function parseDirtyFileTsv(content: string): DirtyFileEntry[] {
    const lines = content.replace(/^\uFEFF/, '').split('\n');
    const entries: DirtyFileEntry[] = [];

    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (!line.trim()) continue;

        const parts = line.split('\t');
        const op = parts[0]?.trim().toUpperCase();
        if (!isBackupOperationUpper(op)) continue;

        const operation: BackupOperationUpper = op;
        const path = parts[1]?.trim();
        if (!path || parts.length < 2 || parts.length > 3) continue;

        if (operation === 'RENAME') {
            const oldPath = parts[2]?.trim();
            if (parts.length !== 3 || !oldPath) continue;
            entries.push({ operation, path, oldPath });
            continue;
        }

        if (parts.length !== 2) continue;
        entries.push({ operation, path });
    }

    return entries;
}

export function formatDirtyFileTsv(entries: DirtyFileEntry[]): string {
    return entries
        .map((entry) => entry.operation === 'RENAME'
            ? `RENAME\t${entry.path}\t${entry.oldPath}`
            : `${entry.operation}\t${entry.path}`)
        .join('\n') + (entries.length > 0 ? '\n' : '');
}

export function parseDeviceState(raw: string): DeviceState {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isString(value.device) || !isString(value.vault)) {
        throw new Error('Invalid device state.');
    }
    return { device: value.device, vault: value.vault };
}

function isActivityStageInfo(value: unknown): boolean {
    if (!isRecord(value)) return false;
    // const validStatuses = ['pending', 'active', 'waiting', 'completed', 'bypassed', 'cancelled', 'failed'];
    return (ACTIVITY_STAGE_STATUSES as readonly string[]).includes(String(value.status))
        && isFiniteNumber(value.timestamp)
        && (value.note === undefined || typeof value.note === 'string');
}

function isActivityRecord(value: unknown): value is ActivityRecord {
    if (!isRecord(value)) return false;
    return isString(value.id)
        && isString(value.path)
        && (BACKUP_EVENTS as readonly string[]).includes(String(value.event))
        && isFiniteNumber(value.timestamp)
        && (LOGGED_ACTIVITY_STATUSES as readonly string[]).includes(String(value.status))
        && (value.oldPath === undefined || isString(value.oldPath))
        && (value.debounce === undefined || isActivityStageInfo(value.debounce))
        && (value.queue === undefined || isActivityStageInfo(value.queue))
        && (value.upload === undefined || isActivityStageInfo(value.upload));
}

function isActivityRecordArray(value: unknown): value is ActivityRecord[] {
    return Array.isArray(value) && value.every(isActivityRecord);
}

export function parseActivityHistoryState(raw: string): ActivityHistoryState {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== LOCAL_STATE_VERSION || !isActivityRecordArray(value.records)) {
        throw new Error('Unsupported or invalid activity history state.');
    }
    return {
        version: LOCAL_STATE_VERSION,
        records: value.records,
    };
}

function isTaskExecutionPolicy(value: unknown): value is TaskExecutionPolicy {
    if (!isRecord(value)) return false;
    return typeof value.logActivity === 'boolean'
        && typeof value.trackDirty === 'boolean'
        && typeof value.updateCache === 'boolean';
}

function isSaveExecutionPolicy(value: unknown): value is SaveExecutionPolicy {
    return isTaskExecutionPolicy(value)
        && 'skipIfUnchanged' in value
        && typeof value.skipIfUnchanged === 'boolean';
}

const validEvents: ReadonlySet<string> = new Set(INTENT_EVENTS);

function isIntentEvent(value: unknown): value is IntentEvent {
    return typeof value === 'string' && validEvents.has(value);
}

function isTaskIntent(value: unknown): value is TaskIntent {
    if (!isRecord(value)) return false;
    if (!isString(value.id) || !isString(value.path)) return false;
    if (value.createdAt !== undefined && !isFiniteNumber(value.createdAt)) return false;
    if (!(INTENT_TRIGGERS as readonly string[]).includes(String(value.trigger))) return false;
    if (!isIntentEvent(value.event)) return false;

    switch (value.operation) {
        case 'save':
            if (!isSaveExecutionPolicy(value.policy)) return false;
            return value.mode === undefined || (BACKUP_MODES as readonly string[]).includes(String(value.mode));
        case 'rename':
            if (!isTaskExecutionPolicy(value.policy)) return false;
            return isString(value.oldPath);
        case 'delete':
            return isTaskExecutionPolicy(value.policy);
        default:
            return false;
    }
}

function parseTaskIntent(value: unknown): TaskIntent | undefined {
    return isTaskIntent(value) ? value : undefined;
}

// Helper type guard
const isFailedTaskLikelyReason = (reason: unknown): reason is FailedTaskLikelyReason =>
    FAILED_TASK_LIKELY_REASONS.some((candidate) => candidate === reason);

export function parseFailedTaskRecord(raw: string): FailedTaskRecord {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)
        || !isString(value.id)
        || !isFiniteNumber(value.timestamp)
        || !isFiniteNumber(value.attempts)
        || typeof value.error !== 'string') {
        throw new Error('Invalid failed task record.');
    }

    const parsedIntent = parseTaskIntent(value.intent);
    const intent = parsedIntent ? serializeTaskIntent(parsedIntent) : undefined;
    if (!intent) {
        throw new Error('Invalid failed task record.');
    }

    const causeValue = isRecord(value.cause) ? value.cause : undefined;
    const cause = causeValue && isString(causeValue.name) && typeof causeValue.message === 'string'
        ? {
            name: causeValue.name,
            message: causeValue.message,
            status: isFiniteNumber(causeValue.status) ? causeValue.status : undefined,
        }
        : { name: 'Error', message: value.error };

    const likelyReason = isFailedTaskLikelyReason(value.likelyReason)
        ? value.likelyReason
        : undefined;

    return {
        id: value.id,
        intent,
        timestamp: value.timestamp,
        attempts: value.attempts,
        stage: value.stage === 'preparation' ? 'preparation' : 'upload',
        error: value.error,
        cause,
        targetHash: isString(value.targetHash) ? value.targetHash : undefined,
        noteSizeBytes: isFiniteNumber(value.noteSizeBytes) ? value.noteSizeBytes : undefined,
        likelyReason,
        payloadPreview: isString(value.payloadPreview) ? truncatePayloadPreview(value.payloadPreview) : undefined,
    };
}
