import type { CachedNoteState } from '../types/state';

interface CachedNoteEntry extends CachedNoteState {
    /** Wall-clock time when this state was added to the in-memory cache. */
    cachedAt: number;
}

/**
 * Pure in-memory LRU cache for recently touched notes during an active Obsidian session.
 * Bounded to a fixed capacity of MAX_CAPACITY (50) items.
  * When capacity is reached, the oldest (least recently used) entry is evicted.
  * Also uses createdAt timestamp to evict entries older than 10 minutes.
 */
export class RecentNotesCache {
    public static readonly MAX_CAPACITY = 50;
    public static readonly CACHE_TIME_MINUTES = 10;

    private cache = new Map<string, CachedNoteEntry>();

    /**
     * Checks if a note path is present in the cache.
     */
    public has(path: string): boolean {
        return this.getValidEntry(path) !== undefined;
    }

    /**
     * Retrieves cached note state and refreshes its LRU position to most-recent.
     */
    public get(path: string): CachedNoteState | undefined {
        const item = this.getValidEntry(path);
        if (item) {
            // Refresh LRU order: delete and re-insert at end
            this.cache.delete(path);
            this.cache.set(path, item);
        }
        return item;
    }

    /**
     * Inserts or updates cached note state. Evicts least recently used item if at capacity.
     */
    public set(path: string, state: CachedNoteState): void {
        if (this.cache.has(path)) {
            this.cache.delete(path);
        } else if (this.cache.size >= RecentNotesCache.MAX_CAPACITY) {
            // Evict oldest entry (first item in Map iterator)
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) {
                this.cache.delete(oldestKey);
            }
        }
        this.cache.set(path, { ...state, cachedAt: Date.now() });
    }

    private getValidEntry(path: string): CachedNoteEntry | undefined {
        const item = this.cache.get(path);
        if (!item) {
            return undefined;
        }

        const cacheTimeMs = RecentNotesCache.CACHE_TIME_MINUTES * 60 * 1000;
        if (Date.now() - item.cachedAt >= cacheTimeMs) {
            this.cache.delete(path);
            return undefined;
        }

        return item;
    }

    /**
     * Removes a path from the cache (e.g. on file delete).
     */
    public delete(path: string): boolean {
        return this.cache.delete(path);
    }

    /**
     * Clears all cached items.
     */
    public clear(): void {
        this.cache.clear();
    }

    /**
     * Returns current number of cached items.
     */
    public size(): number {
        return this.cache.size;
    }
}
