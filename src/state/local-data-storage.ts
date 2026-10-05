import type { DataAdapter } from 'obsidian';
import type {
    StateFileAppender,
    StateFilePathResolver,
    StateFileReader,
    StateFileWriter,
} from './types';

/**
 * Centralized filesystem abstraction for all local plugin state stored under local_data/
  */
export class LocalDataStorage implements StateFileReader, StateFileWriter, StateFileAppender, StateFilePathResolver {
    public readonly localDataDir: string;

    constructor(
        // Can't use vault api to access plugin files inside .obsidian dir
        private adapter: DataAdapter,
        pluginDir: string
    ) {
        this.localDataDir = `${pluginDir}/local_data`;
    }

    public getPath(fileName: string): string {
        return `${this.localDataDir}/${fileName}`;
    }

    /** Exposes adapter-only operations that do not belong in every state manager. */
    public getAdapter(): DataAdapter {
        return this.adapter;
    }

    public async ensureDirectory(): Promise<void> {
        if (!(await this.adapter.exists(this.localDataDir))) {
            try {
                await this.adapter.mkdir(this.localDataDir);
            } catch (err) {
                console.warn('[PB Backup] mkdir failed for local_data directory (filesystem failure or concurrent creation):', err instanceof Error ? err.message : err);
            }
        }
    }

    public async exists(fileName: string): Promise<boolean> {
        return this.adapter.exists(this.getPath(fileName));
    }

    // Obsidian recommends using vault.cachedRead
    public async read(fileName: string): Promise<string | null> {
        const path = this.getPath(fileName);
        if (await this.adapter.exists(path)) {
            return this.adapter.read(path);
        }
        return null;
    }

    public async write(fileName: string, data: string): Promise<void> {
        await this.ensureDirectory();
        const separatorIndex = fileName.lastIndexOf('/');
        if (separatorIndex > 0) {
            const directory = `${this.localDataDir}/${fileName.slice(0, separatorIndex)}`;
            if (!(await this.adapter.exists(directory))) {
                try { await this.adapter.mkdir(directory); } catch (err) { console.warn(`[PB Backup] mkdir failed for subdirectory "${directory}" (filesystem failure or concurrent creation):`, err instanceof Error ? err.message : err); }
            }
        }
        await this.adapter.write(this.getPath(fileName), data);
    }

    public async append(fileName: string, data: string): Promise<void> {
        await this.ensureDirectory();
        await this.adapter.append(this.getPath(fileName), data);
    }

    public async remove(fileName: string): Promise<void> {
        const path = this.getPath(fileName);
        if (await this.adapter.exists(path)) {
            try {
                await this.adapter.remove(path);
            } catch (err) {
                console.warn(`[PB Backup] Failed to remove ${fileName}:`, err);
            }
        }
    }
}
