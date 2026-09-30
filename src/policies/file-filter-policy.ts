import { PathUtils } from '../utils/path-utils';

/**
 * Evaluates whether a file should be tracked based on path conventions and monitored extensions.
 * Rules:
 * - Files in hidden folders (starting with '.') or system folders (.obsidian, .git, .trash) are ignored.
 * - Only files matching the user-configured monitored extensions are accepted.
 * Need to think about adding exclusion keywords in settings - like for password or secret
 */
export class FileFilterPolicy {
    public static readonly DEFAULT_IGNORED_SEGMENTS = ['.obsidian', '.git', '.trash'];

    /**
     * Checks if a path should be ignored (e.g. internal configuration folders, hidden files).
     */
    public static isIgnored(path: string): boolean {
        const normalized = PathUtils.normalize(path);
        const parts = normalized.split('/');
        for (const part of parts) {
            if (part.startsWith('.') || this.DEFAULT_IGNORED_SEGMENTS.includes(part)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Determines whether the file matches monitored extensions.
     */
    public static isMonitored(path: string, monitoredExtensions: string[]): boolean {
        if (this.isIgnored(path)) {
            return false;
        }
        const ext = PathUtils.getExtension(path);
        const cleanExtensions = monitoredExtensions.map(e => e.toLowerCase().replace(/^\./, '').trim());
        return cleanExtensions.includes(ext);
    }
}
