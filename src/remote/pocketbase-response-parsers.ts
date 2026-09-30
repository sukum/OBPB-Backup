
import { BACKUP_OPERATIONS, BACKUP_OBJECT_TYPES } from '../types/domain';
import type {
    FileHistorySummary,
    PocketBaseBackupObjectDto,
    PocketBaseEntriesWithObjectsDto,
    PocketBaseLatestVaultFilesDto,
    VaultStatsViewRecord,
} from '../types/database';
import { isRecord, type UnknownRecord } from '../utils/guards';

export interface PocketBaseListResult<T> {
    page: number;
    perPage: number;
    totalItems: number;
    totalPages: number;
    items: T[];
}

export interface PocketBaseHealthDto {
    code: number;
}

function readRecord(value: unknown, description: string): UnknownRecord {
    if (!isRecord(value)) {
        throw new Error(`Invalid PocketBase response: expected ${description} object.`);
    }
    return value;
}

function readString(record: UnknownRecord, field: string): string {
    const value = record[field];
    if (typeof value !== 'string') {
        throw new Error(`Invalid PocketBase response: expected string field '${field}'.`);
    }
    return value;
}

function readOptionalString(record: UnknownRecord, field: string): string | undefined {
    const value = record[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
        throw new Error(`Invalid PocketBase response: expected optional string field '${field}'.`);
    }
    return value;
}

function readOptionalNullableString(record: UnknownRecord, field: string): string | null | undefined {
    const value = record[field];
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string') {
        throw new Error(`Invalid PocketBase response: expected optional string or null field '${field}'.`);
    }
    return value;
}

function readFiniteNumber(record: UnknownRecord, field: string): number {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Invalid PocketBase response: expected finite number field '${field}'.`);
    }
    return value;
}

function readEnum<T extends string>(record: UnknownRecord, field: string, values: readonly T[]): T {
    const value = readString(record, field);
    const match = values.find((candidate) => candidate === value);
    if (match === undefined) {
        throw new Error(`Invalid PocketBase response: unexpected value for field '${field}'.`);
    }
    return match;
}

// const BACKUP_OBJECT_TYPES = ['snapshot', 'diff'] as const satisfies readonly BackupObjectType[];
// const BACKUP_OPERATIONS = ['save', 'rename', 'delete'] as const satisfies readonly BackupOperation[];

export function parsePocketBaseListResult<T>(
    value: unknown,
    parseItem: (item: unknown) => T
): PocketBaseListResult<T> {
    const record = readRecord(value, 'list');
    if (!Array.isArray(record.items)) {
        throw new Error("Invalid PocketBase response: expected 'items' array.");
    }

    return {
        page: readFiniteNumber(record, 'page'),
        perPage: readFiniteNumber(record, 'perPage'),
        totalItems: readFiniteNumber(record, 'totalItems'),
        totalPages: readFiniteNumber(record, 'totalPages'),
        items: record.items.map(parseItem),
    };
}

export function parsePocketBaseBackupObject(value: unknown): PocketBaseBackupObjectDto {
    const record = readRecord(value, 'backup object');
    return {
        id: readString(record, 'id'),
        user: readString(record, 'user'),
        vault: readString(record, 'vault'),
        hash: readString(record, 'hash'),
        parent_hash: readOptionalNullableString(record, 'parent_hash'),
        type: readEnum(record, 'type', BACKUP_OBJECT_TYPES),
        data: readString(record, 'data'),
        data_hash: readString(record, 'data_hash'),
        diff_format: readOptionalNullableString(record, 'diff_format'),
        encoding: readString(record, 'encoding'),
        size: readFiniteNumber(record, 'size'),
        created: readString(record, 'created'),
        updated: readString(record, 'updated'),
    };
}

export function parsePocketBaseFileHistorySummary(value: unknown): FileHistorySummary {
    const record = readRecord(value, 'file history summary');
    return {
        id: readString(record, 'id'),
        user: readOptionalString(record, 'user'),
        vault: readString(record, 'vault'),
        path: readString(record, 'path'),
        operation: readEnum(record, 'operation', BACKUP_OPERATIONS),
        device: readString(record, 'device'),
        timestamp: readFiniteNumber(record, 'timestamp'),
        hash: readString(record, 'hash'),
        type: readEnum(record, 'type', BACKUP_OBJECT_TYPES),
        size: readFiniteNumber(record, 'size'),
    };
}

export function parsePocketBaseEntriesWithObjects(value: unknown): PocketBaseEntriesWithObjectsDto {
    const record = readRecord(value, 'entry with object');
    return {
        id: readString(record, 'id'),
        user: readOptionalString(record, 'user'),
        vault: readString(record, 'vault'),
        path: readString(record, 'path'),
        old_path: readOptionalNullableString(record, 'old_path'),
        operation: readEnum(record, 'operation', BACKUP_OPERATIONS),
        device: readString(record, 'device'),
        timestamp: readFiniteNumber(record, 'timestamp'),
        hash: readString(record, 'hash'),
        parent_hash: readOptionalNullableString(record, 'parent_hash'),
        type: readEnum(record, 'type', BACKUP_OBJECT_TYPES),
        data: readString(record, 'data'),
        data_hash: readString(record, 'data_hash'),
        diff_format: readOptionalNullableString(record, 'diff_format'),
        size: readFiniteNumber(record, 'size'),
    };
}

export function parsePocketBaseLatestVaultFile(value: unknown): PocketBaseLatestVaultFilesDto {
    const record = readRecord(value, 'latest vault file');
    return {
        id: readString(record, 'id'),
        user: readOptionalString(record, 'user'),
        vault: readString(record, 'vault'),
        path: readString(record, 'path'),
        operation: readEnum(record, 'operation', BACKUP_OPERATIONS),
        timestamp: readFiniteNumber(record, 'timestamp'),
        hash: readString(record, 'hash'),
        object_id: readString(record, 'object_id'),
    };
}

export function parsePocketBaseVaultStats(value: unknown): VaultStatsViewRecord {
    const record = readRecord(value, 'vault stats');
    return {
        id: readString(record, 'id'),
        user: readOptionalString(record, 'user'),
        vault: readString(record, 'vault'),
        total_objects: readFiniteNumber(record, 'total_objects'),
        snapshot_count: readFiniteNumber(record, 'snapshot_count'),
        diff_count: readFiniteNumber(record, 'diff_count'),
        total_bytes: readFiniteNumber(record, 'total_bytes'),
        snapshot_bytes: readFiniteNumber(record, 'snapshot_bytes'),
        diff_bytes: readFiniteNumber(record, 'diff_bytes'),
        total_entries: readFiniteNumber(record, 'total_entries'),
    };
}

export function parsePocketBaseHealth(value: unknown): PocketBaseHealthDto {
    const record = readRecord(value, 'health');
    return { code: readFiniteNumber(record, 'code') };
}
