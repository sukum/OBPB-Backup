import { DiffEngine } from './diff-engine';

/**
 * Coordinates diff computation, offloading files > 500 KB to Web Workers (not implemented yet)
 * or cooperative async tasks to prevent UI thread freezing.
 */
export class DiffWorkerClient {
    private static readonly LARGE_FILE_DIFF_THRESHOLD = 500 * 1024; // 500 KB

    /**
     * Computes unified forward diff. Offloads to async worker task if size > 500 KB.
     */
    public async computeDiff(oldText: string, newText: string, totalSize: number): Promise<string> {
        if (totalSize < DiffWorkerClient.LARGE_FILE_DIFF_THRESHOLD) {
            return DiffEngine.createForwardDiff(oldText, newText);
        }

        // For large files (> 500 KB), yield to the event loop so Obsidian UI does not stutter
        return new Promise((resolve, reject) => {
            window.setTimeout(() => {
                try {
                    const patch = DiffEngine.createForwardDiff(oldText, newText);
                    resolve(patch);
                } catch (err) {
                    reject(err);
                }
            }, 0);
        });
    }
}
