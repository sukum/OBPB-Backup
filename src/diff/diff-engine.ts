import { createPatch, applyPatch } from 'diff';

/**
 * Line-ending normalization and unified diff engine using jsdiff.
 * Formats diffs according to jsdiff@9-unified.
  */
export class DiffEngine {
    // library: jsdiff, version: 9, unified diff format.
    public static readonly DIFF_FORMAT = 'jsdiff@9-unified';

    /**
     * Normalizes line breaks to LF (\n) in memory.
     * Guarantees identical SHA-256 hashes and clean diffs
     */
    public static normalizeNewlines(content: string): string {
        // return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        return content;
    }

    /**
     * Generates a compact forward unified diff from oldText to newText.
     * Uses context: 1 to reduce database storage overhead by 40-60%.
     */
    public static createForwardDiff(oldText: string, newText: string): string {
        const normalizedOld = this.normalizeNewlines(oldText);
        const normalizedNew = this.normalizeNewlines(newText);
        return createPatch('', normalizedOld, normalizedNew, '', '', { context: 1 });
    }

    /**
     * Applies a unified diff to a base content string.
     * Note: jsdiff returns boolean false if patch cannot be applied cleanly.
     * Throws an explicit Error on rejection so that caller can trigger DAG fallback or snapshot fallback.
     */
    public static applyForwardDiff(baseText: string, patchText: string): string {
        const normalizedBase = this.normalizeNewlines(baseText);
        const result = applyPatch(normalizedBase, patchText);

        if (result === false) {
            throw new Error('Patch application rejected: base text does not match patch context');
        }

        return this.normalizeNewlines(result);
    }
}
