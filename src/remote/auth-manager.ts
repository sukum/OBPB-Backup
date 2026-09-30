import { PocketBaseClient, PocketBaseError } from './pocketbase-client';
import { OBPBBackupSettings } from '../types/settings';
import { parsePocketBaseAuthResponse } from './auth-dtos';
import { classifyPocketBaseError } from './pocketbase-error-utils';
import { extractUserIdFromToken } from './jwt-utils';
import { FallbackSecretStorageProvider, type SecretStorageProvider } from './secret-storage';

/**
 * Manages user authentication lifecycle and Obsidian SecretStorage integration.
 * Performs silent background JWT renewal on HTTP 401 errors.
 */
export class AuthManager {
    public static readonly SECRET_KEY_TOKEN = 'obpb-backup-token';
    public static readonly SECRET_KEY_PASSWORD = 'obpb-backup-password';
    public static readonly SECRET_KEY_USER_ID = 'obpb-backup-user-id';
    private refreshPromise: Promise<boolean> | null = null;
    private readonly secretStorage: FallbackSecretStorageProvider;
    private cachedUserId: string | null = null;

    constructor(
        private client: PocketBaseClient,
        private getSettings: () => OBPBBackupSettings,
        secretStorage?: SecretStorageProvider | null
    ) {
        this.secretStorage = new FallbackSecretStorageProvider(secretStorage);
    }

    /**
     * Overwrites stored credential values with empty strings.
     */
    public async clearCredentials(): Promise<void> {
        const keys = [
            AuthManager.SECRET_KEY_TOKEN,
            AuthManager.SECRET_KEY_PASSWORD,
            AuthManager.SECRET_KEY_USER_ID,
        ];

        for (const key of keys) {
            await this.secretStorage.clearSecret(key);
        }
        this.cachedUserId = null;
        this.client.setToken(null);
    }

    /**
     * Loads saved token and registers it with the HTTP client.
     * Falls back to saved password re-authentication if token is missing.
     */
    public async loadStoredAuth(): Promise<boolean> {
        const token = await this.secretStorage.getSecret(AuthManager.SECRET_KEY_TOKEN);
        if (token) {
            this.client.setToken(token);
            const storedUserId = await this.secretStorage.getSecret(AuthManager.SECRET_KEY_USER_ID);
            this.cachedUserId = storedUserId || extractUserIdFromToken(token);
            return true;
        }

        const savedPassword = await this.secretStorage.getSecret(AuthManager.SECRET_KEY_PASSWORD);
        if (savedPassword) {
            try {
                await this.login(savedPassword);
                return true;
            } catch (err) {
                console.warn('[OBPB Backup] Stored password authentication failed on startup:', err);
            }
        }
        return false;
    }

    public isAuthenticated(): boolean {
        return Boolean(this.client.getToken());
    }

    /**
     * Returns the authenticated user's PocketBase record ID.
     */
    public getUserId(): string | null {
        if (this.cachedUserId) return this.cachedUserId;
        const token = this.client.getToken();
        if (token) {
            this.cachedUserId = extractUserIdFromToken(token);
            return this.cachedUserId;
        }
        return null;
    }

    /**
     * Checks authentication status using stored token or credentials in the background.
     * If no token exists and one of serverUrl/userEmail/password is missing,
     * returns false immediately (no-auth) without executing network requests.
     */
    public async checkAuth(): Promise<boolean> {
        const settings = this.getSettings();
        const serverUrl = settings.serverUrl?.trim();
        const userEmail = settings.userEmail?.trim();
        const token = (await this.secretStorage.getSecret(AuthManager.SECRET_KEY_TOKEN)) || this.client.getToken();
        const savedPassword = await this.secretStorage.getSecret(AuthManager.SECRET_KEY_PASSWORD);

        if (!serverUrl) {
            return false;
        }

        // If no token exists and one of url/email/password is unavailable,
        // it is considered no-auth and no auth check is run.
        if (!token) {
            if (!userEmail || !savedPassword) {
                return false;
            }
            try {
                await this.login(savedPassword);
                return true;
            } catch (err) {
                console.warn(`[OBPB Backup] Login with saved password failed during checkAuth (${classifyPocketBaseError(err)}):`, err instanceof Error ? err.message : err);
                return false;
            }
        }

        // Token exists; verify / refresh via auth-refresh (falls back to saved password if refresh fails)
        this.client.setToken(token);
        try {
            return await this.refreshToken();
        } catch (err) {
            console.error('[OBPB Backup] Unexpected error verifying stored token during checkAuth:', err instanceof Error ? err.message : err);
            return false;
        }
    }

    /**
     * Persists password directly to SecretStorage or in-memory fallback.
     */
    public async setPassword(password: string): Promise<void> {
        await this.secretStorage.setSecret(AuthManager.SECRET_KEY_PASSWORD, password);
    }

    /**
     * Ephemeral authentication test against PocketBase without mutating auth state or tokens.
     */
    public async testLogin(password: string): Promise<void> {
        const settings = this.getSettings();
        if (!settings.serverUrl || !settings.userEmail) {
            throw new Error('Server URL and User Email must be configured before testing login.');
        }

        await this.client.request({
            method: 'POST',
            path: '/api/collections/users/auth-with-password',
            body: {
                identity: settings.userEmail,
                password,
            },
        }, parsePocketBaseAuthResponse);
    }

    /**
     * Authenticates with user email and password against PocketBase.
     */
    public async login(password: string): Promise<void> {
        const settings = this.getSettings();
        if (!settings.serverUrl || !settings.userEmail) {
            throw new Error('Server URL and User Email must be configured before logging in.');
        }

        const auth = await this.client.request({
            method: 'POST',
            path: '/api/collections/users/auth-with-password',
            body: {
                identity: settings.userEmail,
                password,
            },
        }, parsePocketBaseAuthResponse);

        this.client.setToken(auth.token);
        const userId = auth.record?.id || extractUserIdFromToken(auth.token);
        this.cachedUserId = userId;
        await this.secretStorage.setSecret(AuthManager.SECRET_KEY_TOKEN, auth.token);
        await this.secretStorage.setSecret(AuthManager.SECRET_KEY_PASSWORD, password);
        if (userId) {
            await this.secretStorage.setSecret(AuthManager.SECRET_KEY_USER_ID, userId);
        }
    }

    /**
     * Performs silent background token renewal.
     */
    public async refreshToken(): Promise<boolean> {
        if (this.refreshPromise) return this.refreshPromise;

        const refreshPromise = this.refreshTokenOnce();
        this.refreshPromise = refreshPromise;
        try {
            return await refreshPromise;
        } finally {
            if (this.refreshPromise === refreshPromise) {
                this.refreshPromise = null;
            }
        }
    }

    private async refreshTokenOnce(): Promise<boolean> {
        try {
            const auth = await this.client.request({
                method: 'POST',
                path: '/api/collections/users/auth-refresh',
            }, parsePocketBaseAuthResponse);

            this.client.setToken(auth.token);
            const userId = auth.record?.id || extractUserIdFromToken(auth.token);
            if (userId) {
                this.cachedUserId = userId;
                await this.secretStorage.setSecret(AuthManager.SECRET_KEY_USER_ID, userId);
            }
            await this.secretStorage.setSecret(AuthManager.SECRET_KEY_TOKEN, auth.token);
            return true;
        } catch (err) {
            console.warn(`[OBPB Backup] Token refresh failed (${classifyPocketBaseError(err)}); attempting password re-login:`, err instanceof Error ? err.message : err);
            // If refresh fails, try re-authenticating with saved password
            const savedPassword = await this.secretStorage.getSecret(AuthManager.SECRET_KEY_PASSWORD);
            if (savedPassword) {
                try {
                    await this.login(savedPassword);
                    return true;
                } catch (reAuthErr) {
                    console.error(`[OBPB Backup] Re-login with saved password failed (${classifyPocketBaseError(reAuthErr)}):`, reAuthErr instanceof Error ? reAuthErr.message : reAuthErr);
                }
            }
        }

        return false;
    }

    /**
     * Executes a request with automatic HTTP 401 intercept and retry.
     */
    public async executeWithAuthRetry<T>(requestFn: () => Promise<T>): Promise<T> {
        try {
            return await requestFn();
        } catch (err) {
            if (err instanceof PocketBaseError && err.status === 401) {
                const refreshed = await this.refreshToken();
                if (refreshed) {
                    return await requestFn();
                }
            }
            throw err;
        }
    }
}
