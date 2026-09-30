import type {
    BackupObjectRecord,
    CreateBackupObject,
    CreateHistoryEntry,
    EntriesWithObjectsViewRecord,
    LatestVaultFilesViewRecord,
    PocketBaseBackupObjectDto,
    PocketBaseEntriesWithObjectsDto,
    PocketBaseHistoryEntryDto,
    PocketBaseLatestVaultFilesDto,
} from '../types/database';

const optionalText = (value: string | null | undefined): string | null => value || null;

// Map from DTO to PB
export function toPocketBaseObject(object: CreateBackupObject): Omit<PocketBaseBackupObjectDto, 'user' | 'created' | 'updated'> {
    const { parentHash, dataHash, diffFormat, ...rest } = object;
    return { ...rest, parent_hash: parentHash, data_hash: dataHash, diff_format: diffFormat };
}

// Map from DTO to PB
export function fromPocketBaseObject(object: PocketBaseBackupObjectDto): BackupObjectRecord {
    const { parent_hash, data_hash, diff_format, ...rest } = object;
    return {
        ...rest,
        parentHash: optionalText(parent_hash),
        dataHash: data_hash,
        diffFormat: optionalText(diff_format),
    };
}

// Map from DTO to PB
export function toPocketBaseEntry(entry: CreateHistoryEntry): Omit<PocketBaseHistoryEntryDto, 'user' | 'created' | 'updated'> {
    const { oldPath, objectId, ...rest } = entry;
    return { ...rest, old_path: oldPath, object_id: objectId };
}

// Map from PB to DTO
export function fromPocketBaseEntriesWithObjects(record: PocketBaseEntriesWithObjectsDto): EntriesWithObjectsViewRecord {
    const { old_path, parent_hash, data_hash, diff_format, ...rest } = record;
    return {
        ...rest,
        oldPath: optionalText(old_path),
        parentHash: optionalText(parent_hash),
        dataHash: data_hash,
        diffFormat: optionalText(diff_format),
    };
}

// Map from PB to DTO
export function fromPocketBaseLatestFile(record: PocketBaseLatestVaultFilesDto): LatestVaultFilesViewRecord {
    const { object_id, ...rest } = record;
    return { ...rest, objectId: object_id };
}
