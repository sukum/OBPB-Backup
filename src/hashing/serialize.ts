/**
 * Deterministic, dependency-free serialization used to feed simpleHash().
 * Unlike plain JSON.stringify, object keys are sorted so that key insertion
 * order never changes the resulting hash, and keys in `excludeKeys` are
 * omitted at every depth (e.g. volatile 'timestamp' fields).
 */
export function stableSerialize(value: unknown, excludeKeys: ReadonlySet<string> = new Set()): string {
    if (value === null || typeof value !== 'object') {
        return String(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map(v => stableSerialize(v, excludeKeys)).join(',')}]`;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
        .filter(k => !excludeKeys.has(k))
        .sort();
    const parts = keys.map(k => `${k}:${stableSerialize(record[k], excludeKeys)}`);
    return `{${parts.join(',')}}`;
}
