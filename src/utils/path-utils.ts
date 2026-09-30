/**
 * Path manipulation and normalization utilities.
 */
export class PathUtils {
    /**
     * Normalizes file paths across Windows, macOS, Linux, iOS, and Android.
     * Replaces backslashes with forward slashes and removes leading/trailing slashes.
     */
    public static normalize(path: string): string {
        return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    }

    /**
     * Extracts lowercase file extension without the leading dot.
     */
    public static getExtension(path: string): string {
        const normalized = this.normalize(path);
        const lastDot = normalized.lastIndexOf('.');
        const lastSlash = normalized.lastIndexOf('/');
        if (lastDot === -1 || lastDot < lastSlash) {
            return '';
        }
        return normalized.slice(lastDot + 1).toLowerCase();
    }
}
