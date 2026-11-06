import { isRecord } from '../utils/guards';

/**
 * Extracts the user record ID from a PocketBase JWT token payload.
 */
export function extractUserIdFromToken(token: string): string | null {
    const id = readJwtPayload(token)?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

export function isTokenExpired(token: string): boolean {
    const expiresAt = readJwtPayload(token)?.exp;
    return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt * 1000 <= Date.now();
}

function readJwtPayload(token: string): Record<string, unknown> | null {
    try {
        const parts = token.split('.');
        if (parts.length >= 2) {
            const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            // base64 to utf8
            // const jsonPayload = decodeURIComponent(
            //     atob(base64)
            //         .split('')
            //         .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            //         .join('')
            // );
            const jsonPayload = new TextDecoder().decode(
                Uint8Array.from(atob(base64), c => c.charCodeAt(0))
            );
            const parsed: unknown = JSON.parse(jsonPayload);
            return isRecord(parsed) ? parsed : null;
        }
    } catch (err) {
        console.warn('[PB Backup] Failed to parse JWT payload (malformed token):', err instanceof Error ? err.message : err);
    }
    return null;
}
