import type { BackupStore } from './backup-store';
import { PocketBaseClient, PocketBaseError } from './pocketbase-client';
import { AuthManager } from './auth-manager';
import type {
    BackupObjectRecord,
    CreateBackupObject,
    CreateHistoryEntry,
    EntriesWithObjectsViewRecord,
    FileHistorySummary,
    LatestVaultFilesViewRecord,
    VaultStatsViewRecord,
} from '../types/database';
import {
    fromPocketBaseEntriesWithObjects,
    fromPocketBaseLatestFile,
    fromPocketBaseObject,
    toPocketBaseEntry,
    toPocketBaseObject,
} from './pocketbase-mappers';
import {
    parsePocketBaseBackupObject,
    parsePocketBaseEntriesWithObjects,
    parsePocketBaseFileHistorySummary,
    parsePocketBaseLatestVaultFile,
    parsePocketBaseListResult,
    parsePocketBaseVaultStats,
} from './pocketbase-response-parsers';
import { classifyPocketBaseError, isDuplicateIdError } from './pocketbase-error-utils';

export const LATEST_FILES_PAGE_FETCH_CONCURRENCY = 4;

/**
 * PocketBase implementation of BackupStore.
 * Interacts with collections: objects, entries,
 * and view collections: entries_with_objects, latest_vault_files, vault_stats.
 */
export class PocketBaseStore implements BackupStore {
    constructor(
        private client: PocketBaseClient,
        private authManager: AuthManager
    ) {}

    /**
     * Uploads an immutable object. If an object with deterministic ID already exists,
     * PocketBase returns HTTP 400 which is handled as idempotent success.
     * Used by task-uploader
     */
    public async putObject(object: CreateBackupObject): Promise<void> {
        return this.authManager.executeWithAuthRetry(async () => {
            const userId = this.authManager.getUserId();
            if (!userId) throw new Error('Authenticated user ID is unavailable.');
            const payload = {
                ...toPocketBaseObject(object),
                user: userId,
            };

            try {
                await this.client.request({
                    method: 'POST',
                    path: '/api/collections/objects/records',
                    body: payload,
                });
            } catch (err) {
                // Check if error is due to duplicate ID (id already exists)
                if (isDuplicateIdError(err)) {
                    // Prior upload attempt succeeded! Treat as idempotent success.
                    return;
                }
                throw err;
            }
        });
    }

    /**
     * Sanitizes values for PocketBase filter query expressions.
     */
    private escapeFilterValue(val: string): string {
        return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    /**
     * Used by reconstruction-engine if the getHistory returned items is exhausted
     */
    public async getObject(vault: string, hash: string): Promise<BackupObjectRecord | null> {
        return this.authManager.executeWithAuthRetry(async () => {
            const escapedVault = this.escapeFilterValue(vault);
            const escapedHash = this.escapeFilterValue(hash);
            const res = await this.client.request({
                method: 'GET',
                path: '/api/collections/objects/records',
                query: {
                    filter: `vault='${escapedVault}' && hash='${escapedHash}'`,
                    perPage: 1,
                },
            }, (value) => parsePocketBaseListResult(value, parsePocketBaseBackupObject));
            return res?.items?.[0] ? fromPocketBaseObject(res.items[0]) : null;
        });
    }

    /**
     * Add an entry record. Used by task-uploader.
     */
    public async addEntry(entry: CreateHistoryEntry): Promise<void> {
        return this.authManager.executeWithAuthRetry(async () => {
            const userId = this.authManager.getUserId();
            if (!userId) throw new Error('Authenticated user ID is unavailable.');
            const payload = {
                ...toPocketBaseEntry(entry),
                user: userId,
            };

            try {
                await this.client.request({
                    method: 'POST',
                    path: '/api/collections/entries/records',
                    body: payload,
                });
            } catch (err) {
                // Check if error is due to duplicate ID (id already exists)
                if (isDuplicateIdError(err)) {
                    // Prior upload attempt succeeded! Treat as idempotent success.
                    return;
                }
                throw err;
            }
        });
    }

    /**
     * Used in history view of a note
     */
    public async getHistory(
        vault: string,
        path: string,
        page: number = 1,
        perPage: number = 50
    ): Promise<FileHistorySummary[]> {
        return this.authManager.executeWithAuthRetry(async () => {
            const escapedVault = this.escapeFilterValue(vault);
            const escapedPath = this.escapeFilterValue(path);
            const res = await this.client.request({
                method: 'GET',
                path: '/api/collections/entries_with_objects/records',
                query: {
                    filter: `vault='${escapedVault}' && path='${escapedPath}'`,
                    sort: '-timestamp',
                    fields: 'id,user,vault,path,operation,device,timestamp,hash,type,size',
                    page,
                    perPage,
                },
            }, (value) => parsePocketBaseListResult(value, parsePocketBaseFileHistorySummary));
            return res?.items || [];
        });
    }

    /**
     * Used in rename and delete events to fetch the latest version of a file path
     */
    public async getLatestEntry(
        vault: string,
        path: string
    ): Promise<FileHistorySummary | null> {
        return this.authManager.executeWithAuthRetry(async () => {
            const escapedVault = this.escapeFilterValue(vault);
            const escapedPath = this.escapeFilterValue(path);
            const res = await this.client.request({
                method: 'GET',
                path: '/api/collections/entries_with_objects/records',
                query: {
                    filter: `vault='${escapedVault}' && path='${escapedPath}'`,
                    sort: '-timestamp',
                    fields: 'id,user,vault,path,operation,device,timestamp,hash,type,size',
                    perPage: 1,
                },
            }, (value) => parsePocketBaseListResult(value, parsePocketBaseFileHistorySummary));
            return res?.items?.[0] || null;
        });
    }

    /**
     * Used extensively for entries-objects fetching for versions of a path
     */
    public async getEntriesWithObjects(
        vault: string,
        path: string,
        perPage: number = 100
    ): Promise<EntriesWithObjectsViewRecord[]> {
        return this.authManager.executeWithAuthRetry(async () => {
            const escapedVault = this.escapeFilterValue(vault);
            const escapedPath = this.escapeFilterValue(path);
            const res = await this.client.request({
                method: 'GET',
                path: '/api/collections/entries_with_objects/records',
                query: {
                    filter: `vault='${escapedVault}' && path='${escapedPath}'`,
                    sort: '-timestamp',
                    perPage,
                },
            }, (value) => parsePocketBaseListResult(value, parsePocketBaseEntriesWithObjects));
            return (res?.items || []).map(fromPocketBaseEntriesWithObjects);
        });
    }

    /**
     * Used in Sync Now operation and trash modal 
     */
    public async getLatestFiles(vault: string, deletedOnly: boolean = false): Promise<LatestVaultFilesViewRecord[]> {
        return this.authManager.executeWithAuthRetry(async () => {
            const escapedVault = this.escapeFilterValue(vault);
            const opFilter = deletedOnly ? "operation='delete'" : "operation!='delete'";
            const fetchPage = (page: number) => this.client.request({
                method: 'GET',
                path: '/api/collections/latest_vault_files/records',
                query: {
                    filter: `vault='${escapedVault}' && ${opFilter}`,
                    sort: deletedOnly ? '-timestamp' : 'path',
                    page,
                    perPage: 500,
                },
            }, (value) => parsePocketBaseListResult(value, parsePocketBaseLatestVaultFile));

            const firstPage = await fetchPage(1);
            const records = [...firstPage.items];

            for (
                let startPage = 2;
                startPage <= firstPage.totalPages;
                startPage += LATEST_FILES_PAGE_FETCH_CONCURRENCY
            ) {
                const endPage = Math.min(
                    startPage + LATEST_FILES_PAGE_FETCH_CONCURRENCY - 1,
                    firstPage.totalPages
                );
                const groupPages: number[] = [];
                for (let p = startPage; p <= endPage; p++) {
                    groupPages.push(p);
                }
                const groupResults = await Promise.all(groupPages.map((page) => fetchPage(page)));
                for (const result of groupResults) {
                    records.push(...result.items);
                }
            }

            return records.map(fromPocketBaseLatestFile);
        });
    }

    /**
     * Used in settings to display vault related statistics 
     */
    public async getVaultStats(vault: string): Promise<VaultStatsViewRecord | null> {
        return this.authManager.executeWithAuthRetry(async () => {
            try {
                return await this.client.request({
                    method: 'GET',
                    path: `/api/collections/vault_stats/records/${encodeURIComponent(vault)}`,
                }, parsePocketBaseVaultStats);
            } catch (err) {
                if (err instanceof PocketBaseError && err.status === 404) {
                    return null;
                }
                // Fallback to filter query
                try {
                    const escapedVault = this.escapeFilterValue(vault);
                    const list = await this.client.request({
                        method: 'GET',
                        path: '/api/collections/vault_stats/records',
                        query: { filter: `vault='${escapedVault}'`, perPage: 1 },
                    }, (value) => parsePocketBaseListResult(value, parsePocketBaseVaultStats));
                    return list?.items?.[0] || null;
                } catch (fallbackErr) {
                    console.warn(`[PB Backup] getVaultStats fallback query failed (${classifyPocketBaseError(fallbackErr)}):`, fallbackErr instanceof Error ? fallbackErr.message : fallbackErr);
                    return null;
                }
            }
        });
    }
}
