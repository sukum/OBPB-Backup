import type { SecretStorage } from 'obsidian';
import type { SecretStorageProvider } from './secret-storage';

/**
 * Adapts Obsidian's synchronous SecretStorage API to AuthManager's async contract.
 */
export class ObsidianSecretStorageProvider implements SecretStorageProvider {
    constructor(private readonly storage: SecretStorage) {}

    async getSecret(key: string): Promise<string | null> {
        return this.storage.getSecret(key);
    }

    async setSecret(key: string, value: string): Promise<void> {
        this.storage.setSecret(key, value);
    }

    async clearSecret(key: string): Promise<void> {
        this.storage.setSecret(key, '');
    }
}
