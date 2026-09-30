import type {
    BackupObjectRecord,
    CreateBackupObject,
    CreateHistoryEntry,
    EntriesWithObjectsViewRecord,
    FileHistorySummary,
    LatestVaultFilesViewRecord,
    VaultStatsViewRecord
} from '../types/database';

/**
 * Abstract storage interface for remote backup backends.
 * Keeps core backup and reconstruction engine decoupled from PocketBase.
 */
export interface BackupStore {
    /**
     * Stores an immutable backup object (snapshot or diff).
     * Must be idempotent: if object already exists, succeed gracefully.
     */
    putObject(object: CreateBackupObject): Promise<void>;

    /**
     * Retrieves an object by its content hash.
     */
    getObject(vault: string, hash: string): Promise<BackupObjectRecord | null>;

    /**
     * Appends a new historical event entry.
     */
    addEntry(entry: CreateHistoryEntry): Promise<void>;

    /**
     * Lists version history entries for a given file path.
     */
    getHistory(vault: string, path: string, page?: number, perPage?: number): Promise<FileHistorySummary[]>;

    /**
     * Retrieves the latest history entry for a specific file path (sorted by -timestamp).
     */
    getLatestEntry(vault: string, path: string): Promise<FileHistorySummary | null>;

    /**
     * Fetches recent history entries joined with objects for a given path (sorted by -timestamp).
     */
    getEntriesWithObjects(vault: string, path: string, perPage?: number): Promise<EntriesWithObjectsViewRecord[]>;

    /**
     * Lists latest files in the vault (optionally filtering for deleted items).
     */
    getLatestFiles(vault: string, deletedOnly?: boolean): Promise<LatestVaultFilesViewRecord[]>;

    /**
     * Retrieves aggregate vault storage metrics and savings.
     */
    getVaultStats(vault: string): Promise<VaultStatsViewRecord | null>;
}
