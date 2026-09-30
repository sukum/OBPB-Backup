import type { DirtyFileEntry, DirtyOperation } from '../types/state';
import { parseDirtyFileTsv, formatDirtyFileTsv } from './state-validation';
import type { DirtyFileMarker } from '../runner/types';
import type { DirtyFileStorage, DirtyPathWriter } from './types';
import { Mutex } from '../utils/mutex';

/**
 * Intent and crash-protection journal for uncommitted file operations.
 * Stored as a tab-separated values (TSV) file at local_data/dirty_files.tsv.
 * Format: <OPERATION>\t<PATH>[\t<OLD_PATH>]
 * 
 * Rules:
 * - Appended on transition to dirty (keystroke, delete, or rename).
 * - Removed via markClean ONLY when task is successfully uploaded or terminally failed.
 * - Protects pending edits and offline queues across app crashes.
 * - Re-dirty tracking protects in-flight operations that receive edits before upload finishes.
 */
export class DirtyFileManager implements DirtyFileMarker, DirtyPathWriter {
    public static readonly FILE_NAME = 'dirty_files.tsv';
    private entries: DirtyFileEntry[] = [];
    private inFlightCounts = new Map<string, number>();
    private reDirtied = new Set<string>();

    private writeMutex = new Mutex();

    constructor(private storage: DirtyFileStorage) {}

    public async load(): Promise<DirtyFileEntry[]> {
        const content = await this.storage.read(DirtyFileManager.FILE_NAME);
        if (content) {
            this.entries = parseDirtyFileTsv(content);
            return this.getEntries();
        }
        this.entries = [];
        return [];
    }

    public isDirty(path: string): boolean {
        return this.entries.some((e) => e.path === path) || this.reDirtied.has(path);
    }

    public getDirtyPaths(): string[] {
        return Array.from(new Set(this.entries.map((e) => e.path)));
    }

    public getEntries(): DirtyFileEntry[] {
        return this.entries.map((e) => ({ ...e }));
    }

    public beginFlight(path: string): void {
        const current = this.inFlightCounts.get(path) ?? 0;
        this.inFlightCounts.set(path, current + 1);
    }

    public endFlight(path: string): void {
        const current = this.inFlightCounts.get(path) ?? 0;
        if (current <= 1) {
            this.inFlightCounts.delete(path);
        } else {
            this.inFlightCounts.set(path, current - 1);
        }
    }

    public setInFlight(path: string, inFlight: boolean): void {
        if (inFlight) {
            this.beginFlight(path);
        } else {
            this.inFlightCounts.delete(path);
        }
    }

    public isInFlight(path: string): boolean {
        return (this.inFlightCounts.get(path) ?? 0) > 0;
    }

    public markReDirtied(path: string): void {
        this.reDirtied.add(path);
    }

    public async markDirty(path: string): Promise<void>;
    public async markDirty(operation: 'SAVE' | 'DELETE', path: string): Promise<void>;
    public async markDirty(operation: 'RENAME', path: string, oldPath: string): Promise<void>;
    public async markDirty(operationOrPath: string, path?: string, oldPath?: string): Promise<void> {
        const op: DirtyOperation = path === undefined ? 'SAVE' : (operationOrPath as DirtyOperation);
        const targetPath = path === undefined ? operationOrPath : path;

        const entry = this.createEntry(op, targetPath, oldPath);

        if (this.isInFlight(targetPath)) {
            this.reDirtied.add(targetPath);
        }

        const existingIndex = this.entries.findIndex((existing) => existing.path === targetPath
            && existing.operation === op
            && (op !== 'RENAME' || (existing.operation === 'RENAME' && existing.oldPath === oldPath)));
        if (existingIndex !== -1 && !this.isInFlight(targetPath)) {
            // Already dirty with identical operation and not currently in-flight: zero disk I/O!
            return;
        }

        this.entries.push(entry);
        await this.appendEntry(entry);
    }

    public async markClean(path: string): Promise<void> {
        if (this.reDirtied.has(path)) {
            this.reDirtied.delete(path);
            // Re-dirtied while in flight: retain or re-add a SAVE entry for this path
            this.entries = this.entries.filter((e) => e.path !== path);
            this.entries.push({ operation: 'SAVE', path });
            await this.persist();
            return;
        }

        const beforeCount = this.entries.length;
        this.entries = this.entries.filter((e) => e.path !== path);
        if (this.entries.length === beforeCount) {
            return;
        }
        await this.persist();
    }

    public async saveAll(entries: DirtyFileEntry[]): Promise<void> {
        this.entries = [...entries];
        await this.persist();
    }

    private async persist(): Promise<void> {
        const text = formatDirtyFileTsv(this.entries);
        await this.writeMutex.runExclusive(async () => {
            await this.storage.write(DirtyFileManager.FILE_NAME, text);
        });
    }

    private async appendEntry(entry: DirtyFileEntry): Promise<void> {
        const line = entry.operation === 'RENAME'
            ? `RENAME\t${entry.path}\t${entry.oldPath}\n`
            : `${entry.operation}\t${entry.path}\n`;
        await this.writeMutex.runExclusive(async () => {
            await this.storage.append(DirtyFileManager.FILE_NAME, line);
        });
    }

    private createEntry(operation: DirtyOperation, path: string, oldPath?: string): DirtyFileEntry {
        if (operation === 'RENAME') {
            if (!oldPath) throw new Error('A RENAME dirty entry requires a non-empty oldPath.');
            return { operation, path, oldPath };
        }

        if (operation === 'SAVE' || operation === 'DELETE') {
            if (oldPath !== undefined) {
                throw new Error(`${operation} dirty entries cannot have an oldPath.`);
            }
            return { operation, path };
        }

        throw new Error(`Unsupported dirty operation: ${operation}`);
    }
}
