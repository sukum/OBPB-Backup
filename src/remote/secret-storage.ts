/**
 * Async storage contract used by AuthManager.
 */
export interface SecretStorageProvider {
    getSecret(key: string): Promise<string | null>;
    setSecret(key: string, value: string): Promise<void>;
    clearSecret(key: string): Promise<void>;
}

/**
 * Map-backed SecretStorageProvider used when no platform secret storage exists.
 */
export class InMemorySecretStorageProvider implements SecretStorageProvider {
    private readonly secrets = new Map<string, string>();

    async getSecret(key: string): Promise<string | null> {
        return this.secrets.get(key) ?? null;
    }

    async setSecret(key: string, value: string): Promise<void> {
        this.secrets.set(key, value);
    }

    async clearSecret(key: string): Promise<void> {
        this.secrets.delete(key);
    }
}

/**
 * SecretStorageProvider that delegates to a primary provider (e.g. Obsidian
 * SecretStorage) and falls back to in-memory storage when the primary is
 * unavailable or throws (e.g. OS keychain locked).
 */
export class FallbackSecretStorageProvider implements SecretStorageProvider {
    private readonly fallback = new InMemorySecretStorageProvider();

    constructor(private readonly primary?: SecretStorageProvider | null) {}

    async getSecret(key: string): Promise<string | null> {
        if (this.primary && typeof this.primary.getSecret === 'function') {
            try {
                return (await this.primary.getSecret(key)) || null;
            } catch (err) {
                console.warn(`[PB Backup] secretStorage.getSecret failed for key "${key}" (secret storage unavailable); using in-memory fallback:`, err instanceof Error ? err.message : err);
            }
        }
        return this.fallback.getSecret(key);
    }

    async setSecret(key: string, value: string): Promise<void> {
        if (this.primary && typeof this.primary.setSecret === 'function') {
            try {
                await this.primary.setSecret(key, value);
                return;
            } catch (err) {
                console.warn(`[PB Backup] secretStorage.setSecret failed for key "${key}" (secret storage unavailable); using in-memory fallback:`, err instanceof Error ? err.message : err);
            }
        }
        await this.fallback.setSecret(key, value);
    }

    async clearSecret(key: string): Promise<void> {
        if (this.primary && typeof this.primary.clearSecret === 'function') {
            try {
                await this.primary.clearSecret(key);
            } catch (err) {
                console.warn(`[PB Backup] secretStorage.clearSecret failed for key "${key}" (secret storage unavailable):`, err instanceof Error ? err.message : err);
            }
        }
        await this.fallback.clearSecret(key);
    }
}
