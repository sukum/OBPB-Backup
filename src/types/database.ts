/**
 * Remote PocketBase collection records and view records.
 */
import type { BackupObjectType, BackupOperation } from './domain';

/**
 * Collection: objects (Base Collection)
 * Immutable content objects (snapshots or diffs).
 */
export interface BackupObjectRecord {
    id: string;                 // Deterministic 15-char alphanumeric PocketBase ID
    user: string;               // Relation -> users.id (owner for multi-tenant isolation)
    vault: string;              // Logical Vault UUID
    hash: string;               // SHA-256 of resulting content: "sha256:<hex>"
    parentHash: string | null;  // Hash of predecessor (null only for initial snapshot)
    type: BackupObjectType;
    data: string;               // Full text content (snapshot) or unified diff (diff)
    dataHash: string;           // SHA-256 of the raw data payload string
    diffFormat: string | null;  // e.g. "jsdiff@9-unified" (null for snapshots)
    encoding: string;           // "none" (reserved for future compression/encryption)
    size: number;               // Byte length of data
    created: string;            // ISO-8601 timestamp
    updated: string;            // ISO-8601 timestamp
}

export type CreateBackupObject = Omit<BackupObjectRecord, 'user' | 'created' | 'updated'>;

/**
 * Collection: entries (Base Collection)
 * Append-only historical event journal.
 */
export interface HistoryEntryRecord {
    id: string;                 // 15-char PocketBase record ID
    user: string;               // Relation -> users.id (owner for multi-tenant isolation)
    vault: string;              // Logical Vault UUID
    path: string;               // Vault-relative path (e.g. "Projects/Note.md")
    oldPath: string | null;     // Previous path (populated only when operation = 'rename')
    objectId: string;           // Foreign key relation -> objects.id
    hash: string;               // SHA-256 of resulting content (indexed for queries)
    operation: BackupOperation;
    device: string;             // Persistent Device UUID
    timestamp: number;          // Linux epoch timestamp in milliseconds
    created: string;
    updated: string;
}

export type CreateHistoryEntry = Omit<HistoryEntryRecord, 'user' | 'created' | 'updated'>;

/**
 * View Collection: entries_with_objects (Section 22.1)
 * Flattens entries and objects for reconstruction.
 */
export interface EntriesWithObjectsViewRecord {
    id: string;                 // entries.id
    user?: string;              // entries.user / objects.user
    vault: string;
    path: string;
    oldPath: string | null;
    operation: BackupOperation;
    device: string;
    timestamp: number;
    hash: string;
    parentHash: string | null;
    type: BackupObjectType;
    data: string;
    dataHash: string;
    diffFormat: string | null;
    size: number;
}

/**
 * Lightweight domain summary projected from selected fields of the
 * entries_with_objects view. This is not a standalone PocketBase view record.
 * It omits payload data for history lists and latest-entry lookups.
 */
export interface FileHistorySummary {
    id: string;                 // entries.id
    user?: string;              // entries.user
    vault: string;
    path: string;
    operation: BackupOperation;
    device: string;
    timestamp: number;
    hash: string;
    type: BackupObjectType;
    size: number;
}

/**
 * View Collection: latest_vault_files (Section 24.1)
 * Head state per file for active vault browsing and trash recovery.
 */
export interface LatestVaultFilesViewRecord {
    id: string;                 // entries.id
    user?: string;              // entries.user
    vault: string;
    path: string;
    operation: BackupOperation;
    timestamp: number;
    hash: string;
    objectId: string;
}

/**
 * View Collection: vault_stats (Section 24.1)
 * Storage metrics and savings aggregation per vault.
 */
export interface VaultStatsViewRecord {
    id: string;                 // vault ID
    user?: string;              // objects.user
    vault: string;
    total_objects: number;
    snapshot_count: number;
    diff_count: number;
    total_bytes: number;
    snapshot_bytes: number;
    diff_bytes: number;
    total_entries: number;
}

export interface PocketBaseBackupObjectDto extends Omit<BackupObjectRecord, 'parentHash' | 'dataHash' | 'diffFormat'> {
    parent_hash?: string | null;
    data_hash: string;
    diff_format?: string | null;
}

export interface PocketBaseHistoryEntryDto extends Omit<HistoryEntryRecord, 'oldPath' | 'objectId'> {
    old_path?: string | null;
    object_id: string;
}

export interface PocketBaseEntriesWithObjectsDto extends Omit<EntriesWithObjectsViewRecord, 'oldPath' | 'parentHash' | 'dataHash' | 'diffFormat'> {
    old_path?: string | null;
    parent_hash?: string | null;
    data_hash: string;
    diff_format?: string | null;
}

export interface PocketBaseLatestVaultFilesDto extends Omit<LatestVaultFilesViewRecord, 'objectId'> {
    object_id: string;
}
