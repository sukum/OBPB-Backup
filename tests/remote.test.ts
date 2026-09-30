import { test, describe, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, OBPBBackupSettings } from '../src/types/settings';
import { PocketBaseStore, LATEST_FILES_PAGE_FETCH_CONCURRENCY } from '../src/remote/pocketbase-store';
import { exceedsPocketBaseObjectDataLimit, POCKETBASE_OBJECT_DATA_MAX_CHARACTERS } from '../src/remote/pocketbase-schema';
import { readFileSync } from 'node:fs';
import { fromPocketBaseEntriesWithObjects, fromPocketBaseObject, toPocketBaseEntry, toPocketBaseObject, fromPocketBaseLatestFile } from '../src/remote/pocketbase-mappers';
import { PocketBaseClient, PocketBaseError, type RequestOptions, type ResponseDecoder } from '../src/remote/pocketbase-client';
import { AuthManager } from '../src/remote/auth-manager';
import { extractUserIdFromToken } from '../src/remote/jwt-utils';
import { parsePocketBaseAuthResponse } from '../src/remote/auth-dtos';

describe("Auth tests", () => {
test('PocketBase auth DTO validation rejects malformed boundary data', () => {
    assert.deepEqual(
        parsePocketBaseAuthResponse({ token: 'jwt', record: { id: 'user-id', ignored: true } }),
        { token: 'jwt', record: { id: 'user-id' } }
    );
    assert.deepEqual(parsePocketBaseAuthResponse({ token: 'jwt' }), { token: 'jwt' });

    assert.throws(
        () => parsePocketBaseAuthResponse({ record: { id: 'user-id' } }),
        /token is missing/
    );
    assert.throws(
        () => parsePocketBaseAuthResponse({ token: 'jwt', record: { id: 123 } }),
        /record ID is invalid/
    );
    assert.throws(
        () => parsePocketBaseAuthResponse(['jwt']),
        /token is missing/
    );
});

test('JWT token parsing extracts user ID', () => {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = btoa(JSON.stringify({ id: 'usr_abc123xyz456', type: 'auth' }));
    const mockToken = `${header}.${payload}.signature`;

    assert.equal(extractUserIdFromToken(mockToken), 'usr_abc123xyz456');
    assert.equal(extractUserIdFromToken('invalid-token'), null);
});

test('extractUserIdFromToken decodes JWT payload and AuthManager exposes the user ID', async () => {
    const { AuthManager } = await import('../src/remote/auth-manager');

    // Construct valid JWT with id
    const payload = { id: 'usr-extracted-987', email: 'test@example.com', exp: 9999999999 };
    const base64Payload = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_');
    const token = `header.${base64Payload}.signature`;

    let clientToken: string | null = token;
    const mockClient: any = {
        getToken: () => clientToken,
        setToken: (t: string | null) => { clientToken = t; },
    };

    const storageMap = new Map<string, string>();
    storageMap.set(AuthManager.SECRET_KEY_TOKEN, token);
    // Note: SECRET_KEY_USER_ID is intentionally omitted to trigger token extraction!

    const mockStorage = {
        async getSecret(key: string) { return storageMap.get(key) || null; },
        async setSecret(key: string, value: string) { storageMap.set(key, value); },
        async clearSecret(key: string) { storageMap.delete(key); },
    };

    const authManager = new AuthManager(mockClient, () => ({ serverUrl: '', userEmail: '' } as any), mockStorage);

    // 1. Direct utility invocation
    const extracted = extractUserIdFromToken(token);
    assert.equal(extracted, 'usr-extracted-987');

    // 2. Integration via getUserId() resolving token and extracting
    const resolvedUserId = await authManager.getUserId();
    assert.equal(resolvedUserId, 'usr-extracted-987');

    // 3. Corrupted token returns null
    assert.equal(extractUserIdFromToken('invalid-token-without-periods'), null);
    assert.equal(extractUserIdFromToken('header.not_valid_json.sig'), null);
});


test('AuthManager manages secret persistence via SecretStorageProvider, in-memory fallback, and silent refresh', async (t: TestContext) => {
    const { AuthManager } = await import('../src/remote/auth-manager');
    const { PocketBaseError } = await import('../src/remote/pocketbase-client');

    const fakeTokenHeader = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const fakeTokenPayload = btoa(JSON.stringify({ id: 'user-xyz-123', type: 'auth' }));
    const sampleToken = `${fakeTokenHeader}.${fakeTokenPayload}.sig`;

    const settings = {
        serverUrl: 'http://localhost:8090',
        userEmail: 'test@example.com',
    } as any;

    // 1. Test AuthManager with SecretStorageProvider
    const storageMap = new Map<string, string>();
    const mockStorage = {
        async getSecret(key: string) {
            return storageMap.get(key) || null;
        },
        async setSecret(key: string, value: string) {
            storageMap.set(key, value);
        },
        async clearSecret(key: string) {
            storageMap.delete(key);
        },
    };

    let clientToken: string | null = null;
    const mockClient: any = {
        getToken: () => clientToken,
        setToken: (t: string | null) => { clientToken = t; },
        request: async (opts: any) => {
            if (opts.path === '/api/collections/users/auth-with-password') {
                return { token: sampleToken, record: { id: 'user-xyz-123' } };
            }
            if (opts.path === '/api/collections/users/auth-refresh') {
                return { token: `${sampleToken}-refreshed`, record: { id: 'user-xyz-123' } };
            }
            throw new Error(`Unhandled request path: ${opts.path}`);
        },
    };

    const authManager = new AuthManager(mockClient, () => settings, mockStorage);

    // Initial state
    assert.equal(authManager.isAuthenticated(), false);
    assert.equal(authManager.getUserId(), null);

    // Login stores credentials in SecretStorageProvider
    await authManager.login('secretpassword');
    assert.equal(authManager.isAuthenticated(), true);
    assert.equal(authManager.getUserId(), 'user-xyz-123');
    assert.equal(clientToken, sampleToken);
    assert.equal(storageMap.get(AuthManager.SECRET_KEY_TOKEN), sampleToken);
    assert.equal(storageMap.get(AuthManager.SECRET_KEY_PASSWORD), 'secretpassword');
    assert.equal(storageMap.get(AuthManager.SECRET_KEY_USER_ID), 'user-xyz-123');

    // Subsequent session: loadStoredAuth re-reads from SecretStorageProvider
    clientToken = null;
    const secondAuthManager = new AuthManager(mockClient, () => settings, mockStorage);
    const loaded = await secondAuthManager.loadStoredAuth();
    assert.equal(loaded, true);
    assert.equal(secondAuthManager.isAuthenticated(), true);
    assert.equal(secondAuthManager.getUserId(), 'user-xyz-123');
    assert.equal(clientToken, sampleToken);

    // Token refresh updates SecretStorageProvider
    const refreshed = await secondAuthManager.refreshToken();
    assert.equal(refreshed, true);
    assert.equal(clientToken, `${sampleToken}-refreshed`);
    assert.equal(storageMap.get(AuthManager.SECRET_KEY_TOKEN), `${sampleToken}-refreshed`);

    // clearCredentials wipes storageMap and resets token
    await secondAuthManager.clearCredentials();
    assert.equal(secondAuthManager.isAuthenticated(), false);
    assert.equal(clientToken, null);
    assert.equal(storageMap.has(AuthManager.SECRET_KEY_TOKEN), false);
    assert.equal(storageMap.has(AuthManager.SECRET_KEY_PASSWORD), false);
    assert.equal(storageMap.has(AuthManager.SECRET_KEY_USER_ID), false);

    // 2. Test In-Memory fallback when secretStorage is undefined
    const memAuthManager = new AuthManager(mockClient, () => settings);
    await memAuthManager.login('mempassword');
    assert.equal(memAuthManager.isAuthenticated(), true);
    assert.equal(memAuthManager.getUserId(), 'user-xyz-123');
    await memAuthManager.clearCredentials();
    assert.equal(memAuthManager.isAuthenticated(), false);

    // 3. Test Resilience when secretStorage methods throw errors (e.g. OS keychain locked)
    // const consoleWarn = console.warn;
    let consoleWarnCalled = false;
    t.mock.method(console, 'warn', () => { consoleWarnCalled = true; });
    const throwingStorage = {
        async getSecret() { throw new Error('OS Keychain Locked'); },
        async setSecret() { throw new Error('OS Keychain Permission Denied'); },
        async clearSecret() { throw new Error('OS Keychain Error'); },
    };
    const resilientAuth = new AuthManager(mockClient, () => settings, throwingStorage);
    // Should not throw, should fall back to memory
    await resilientAuth.login('resilientpass');
    assert.equal(resilientAuth.isAuthenticated(), true);
    assert.equal(resilientAuth.getUserId(), 'user-xyz-123');
    await resilientAuth.clearCredentials();
    assert.equal(resilientAuth.isAuthenticated(), false);
    assert.equal(consoleWarnCalled, true, "console.warn should have been called due to throwingStorage errors");
    t.mock.reset();

    // 4. Test executeWithAuthRetry on HTTP 401 PocketBaseError
    let attempt = 0;
    const retryAuth = new AuthManager(mockClient, () => settings);
    const result = await retryAuth.executeWithAuthRetry(async () => {
        attempt++;
        if (attempt === 1) {
            throw new PocketBaseError(401, 'Unauthorized');
        }
        return 'success-after-retry';
    });
    assert.equal(result, 'success-after-retry');
    assert.equal(attempt, 2);

    // 5. Test testLogin: ephemeral check without mutating client or storage state
    const ephemeralStorage = new Map<string, string>();
    const ephemeralStorageProvider = {
        async getSecret(key: string) { return ephemeralStorage.get(key) || null; },
        async setSecret(key: string, value: string) { ephemeralStorage.set(key, value); },
        async clearSecret(key: string) { ephemeralStorage.delete(key); },
    };
    let testClientToken: string | null = null;
    const testMockClient = {
        getToken: () => testClientToken,
        setToken: (tok: string | null) => { testClientToken = tok; },
        request: async (options: any) => {
            if (options.path.includes('/auth-with-password')) {
                if (options.body.password === 'badpassword') {
                    throw new Error('Invalid credentials');
                }
                return { token: sampleToken, record: { id: 'user-xyz-123' } };
            }
            throw new Error('Unexpected route');
        },
    } as any;
    const testAuthManager = new AuthManager(testMockClient, () => settings, ephemeralStorageProvider);
    // Successful testLogin
    await testAuthManager.testLogin('validpassword');
    assert.equal(testClientToken, null); // Client token unchanged
    assert.equal(testAuthManager.isAuthenticated(), false); // Not authenticated
    assert.equal(testAuthManager.getUserId(), null); // No user ID set
    assert.equal(ephemeralStorage.size, 0); // Nothing saved in storage

    // Failed testLogin
    await assert.rejects(
        () => testAuthManager.testLogin('badpassword'),
        /Invalid credentials/
    );

    // 6. Test setPassword and loadStoredAuth fallback to saved password
    await testAuthManager.setPassword('stored-secret-pass');
    assert.equal(ephemeralStorage.get(AuthManager.SECRET_KEY_PASSWORD), 'stored-secret-pass');
    assert.equal(testAuthManager.isAuthenticated(), false);
    // loadStoredAuth with no token should automatically authenticate using saved password
    const loadResult = await testAuthManager.loadStoredAuth();
    assert.equal(loadResult, true);
    assert.equal(testAuthManager.isAuthenticated(), true);
    assert.equal(testClientToken, sampleToken);
    assert.equal(ephemeralStorage.get(AuthManager.SECRET_KEY_TOKEN), sampleToken);

    // 7. Test checkAuth: no-auth without network when missing url/email/password and no token
    let networkCalls = 0;
    const trackingClient = {
        getToken: () => null,
        setToken: () => {},
        request: async () => {
            networkCalls++;
            return { token: sampleToken, record: { id: 'user-xyz-123' } };
        },
    } as any;
    const checkStorage = new Map<string, string>();
    const checkStorageProvider = {
        async getSecret(key: string) { return checkStorage.get(key) || null; },
        async setSecret(key: string, value: string) { checkStorage.set(key, value); },
        async clearSecret(key: string) { checkStorage.delete(key); },
    };
    let currentSettings: OBPBBackupSettings = { ...settings, serverUrl: '', userEmail: '' };
    const checkAuthManager = new AuthManager(trackingClient, () => currentSettings, checkStorageProvider);

    // No token and missing url/email/password -> returns false, 0 network calls
    assert.equal(await checkAuthManager.checkAuth(), false);
    assert.equal(networkCalls, 0);

    // Has url, but missing email and password -> returns false, 0 network calls
    currentSettings = { ...settings, serverUrl: 'https://backup.example.com', userEmail: '' };
    assert.equal(await checkAuthManager.checkAuth(), false);
    assert.equal(networkCalls, 0);

    // Has url and email, but missing password -> returns false, 0 network calls
    currentSettings = { ...settings, serverUrl: 'https://backup.example.com', userEmail: 'user@example.com' };
    assert.equal(await checkAuthManager.checkAuth(), false);
    assert.equal(networkCalls, 0);

    // Has url, email, and password -> runs login, returns true, network called
    checkStorage.set(AuthManager.SECRET_KEY_PASSWORD, 'valid-pass');
    assert.equal(await checkAuthManager.checkAuth(), true);
    assert.equal(networkCalls, 1);
});

test('AuthManager shares one refresh across concurrent unauthorized requests', async () => {
    const client = new PocketBaseClient(() => 'https://backup.example.com');
    let resolveRefresh: ((response: unknown) => void) | undefined;
    const refreshResponse = new Promise<unknown>((resolve) => {
        resolveRefresh = resolve;
    });
    let refreshStarted: (() => void) | undefined;
    const refreshStartedPromise = new Promise<void>((resolve) => {
        refreshStarted = resolve;
    });
    let refreshCalls = 0;

    Object.defineProperty(client, 'request', {
        value: async <T>(options: RequestOptions, decode?: ResponseDecoder<T>): Promise<unknown> => {
            if (options.path !== '/api/collections/users/auth-refresh') {
                throw new Error(`Unexpected request path: ${options.path}`);
            }
            refreshCalls++;
            refreshStarted?.();
            const response = await refreshResponse;
            return decode ? decode(response) : response;
        },
    });

    const authManager = new AuthManager(client, () => DEFAULT_SETTINGS);
    client.setToken('expired-token');
    let protectedAttempts = 0;
    const protectedRequest = async (): Promise<string> => {
        protectedAttempts++;
        if (client.getToken() !== 'renewed-token') {
            throw new PocketBaseError(401, 'Unauthorized');
        }
        return 'success';
    };

    const firstRequest = authManager.executeWithAuthRetry(protectedRequest);
    const secondRequest = authManager.executeWithAuthRetry(protectedRequest);
    await refreshStartedPromise;
    await Promise.resolve();
    assert.equal(refreshCalls, 1);

    resolveRefresh?.({ token: 'renewed-token', record: { id: 'user-1' } });
    assert.deepEqual(await Promise.all([firstRequest, secondRequest]), ['success', 'success']);
    assert.equal(refreshCalls, 1);
    assert.equal(protectedAttempts, 4);
    assert.equal(client.getToken(), 'renewed-token');
});
});



describe("Pocketbase enforce rules", () => {
test('PocketBase mappers isolate snake_case and normalize empty optional fields', () => {
    const object = fromPocketBaseObject({
        id: 'object-id', user: 'user-id', vault: 'vault-id', hash: 'sha256:content',
        parent_hash: '', type: 'snapshot', data: 'content', data_hash: 'sha256:data',
        diff_format: '', encoding: 'none', size: 7, created: 'created', updated: 'updated',
    });
    assert.equal(object.parentHash, null);
    assert.equal(object.diffFormat, null);
    assert.equal(object.dataHash, 'sha256:data');

    const entryView = fromPocketBaseEntriesWithObjects({
        id: 'entry-id', user: 'user-id', vault: 'vault-id', path: 'Note.md', old_path: '',
        operation: 'save', device: 'device-id', timestamp: 1, hash: 'sha256:content',
        parent_hash: '', type: 'snapshot', data: 'content', data_hash: 'sha256:data',
        diff_format: '', size: 7,
    });
    assert.equal(entryView.oldPath, null);
    assert.equal(entryView.parentHash, null);
    assert.equal(entryView.diffFormat, null);

    assert.deepEqual(toPocketBaseObject({
        id: 'object-id', vault: 'vault-id', hash: 'sha256:content', parentHash: null,
        type: 'snapshot', data: 'content', dataHash: 'sha256:data', diffFormat: null,
        encoding: 'none', size: 7,
    }), {
        id: 'object-id', vault: 'vault-id', hash: 'sha256:content', parent_hash: null,
        type: 'snapshot', data: 'content', data_hash: 'sha256:data', diff_format: null,
        encoding: 'none', size: 7,
    });

    assert.equal(toPocketBaseEntry({
        id: 'entry-id', vault: 'vault-id', path: 'New.md', oldPath: 'Old.md',
        objectId: 'object-id', hash: 'sha256:content', operation: 'rename',
        device: 'device-id', timestamp: 1,
    }).old_path, 'Old.md');
});

test('PocketBase object data limit matches the exported schema', () => {
    const schema = JSON.parse(readFileSync('pocketbase/pb_schema.json', 'utf8')) as Array<{ name: string; fields: Array<{ name: string; max?: number }> }>;
    const objects = schema.find((collection) => collection.name === 'objects');
    const dataField = objects?.fields.find((field) => field.name === 'data');

    assert.equal(dataField?.max, POCKETBASE_OBJECT_DATA_MAX_CHARACTERS);
    assert.equal(exceedsPocketBaseObjectDataLimit('x'.repeat(POCKETBASE_OBJECT_DATA_MAX_CHARACTERS)), false);
    assert.equal(exceedsPocketBaseObjectDataLimit('x'.repeat(POCKETBASE_OBJECT_DATA_MAX_CHARACTERS + 1)), true);
});

test('fromPocketBaseLatestFile maps snake_case object_id to camelCase objectId', () => {
    const rawDto: any = {
        id: 'rec-1',
        vault: 'vault-1',
        path: 'Folder/Note.md',
        operation: 'save',
        timestamp: 123456789,
        hash: 'hash-abc',
        object_id: 'obj-999',
    };
    const mapped = fromPocketBaseLatestFile(rawDto);
    assert.equal(mapped.id, 'rec-1');
    assert.equal(mapped.vault, 'vault-1');
    assert.equal(mapped.path, 'Folder/Note.md');
    assert.equal(mapped.operation, 'save');
    assert.equal(mapped.objectId, 'obj-999');
    assert.equal('object_id' in mapped, false);
});
});

describe("Pocketbase get fns", () => {

test('PocketBaseStore getHistory and getLatestEntry query entries_with_objects with field projections', async () => {
    const requests: any[] = [];
    const mockClient = {
        request: async (opts: any) => {
            requests.push(opts);
            return {
                page: 1,
                perPage: opts.query?.perPage || 50,
                totalItems: 1,
                totalPages: 1,
                items: [
                    {
                        id: 'rec123',
                        user: 'u-1',
                        vault: 'v-1',
                        path: 'Notes/Test.md',
                        operation: 'save',
                        device: 'dev-1',
                        timestamp: 1700000000000,
                        hash: 'sha256:abc',
                        type: 'snapshot',
                        size: 42,
                    },
                ],
            };
        },
    };

    const mockAuthManager = {
        executeWithAuthRetry: async (fn: () => Promise<any>) => fn(),
        getUserId: () => 'u-1',
    };

    const store = new PocketBaseStore(mockClient as any, mockAuthManager as any);

    // 1. Test getHistory
    const history = await store.getHistory('v-1', 'Notes/Test.md', 1, 25);
    assert.equal(history.length, 1);
    assert.equal(requests.length, 1);

    const histReq = requests[0];
    assert.equal(histReq.method, 'GET');
    assert.equal(histReq.path, '/api/collections/entries_with_objects/records');
    assert.equal(histReq.query.filter, "vault='v-1' && path='Notes/Test.md'");
    assert.equal(histReq.query.sort, '-timestamp');
    assert.equal(histReq.query.fields, 'id,user,vault,path,operation,device,timestamp,hash,type,size');
    assert.equal(histReq.query.page, 1);
    assert.equal(histReq.query.perPage, 25);

    // 2. Test getLatestEntry
    const latest = await store.getLatestEntry('v-1', 'Notes/Test.md');
    assert.ok(latest);
    assert.equal(latest!.hash, 'sha256:abc');
    assert.equal(requests.length, 2);

    const latestReq = requests[1];
    assert.equal(latestReq.method, 'GET');
    assert.equal(latestReq.path, '/api/collections/entries_with_objects/records');
    assert.equal(latestReq.query.filter, "vault='v-1' && path='Notes/Test.md'");
    assert.equal(latestReq.query.sort, '-timestamp');
    assert.equal(latestReq.query.fields, 'id,user,vault,path,operation,device,timestamp,hash,type,size');
    assert.equal(latestReq.query.perPage, 1);
});

test('PocketBaseStore.getObject retrieves single object by hash or returns null', async () => {
    const requests: any[] = [];
    const mockClient: any = {
        request: async (opts: any) => {
            requests.push(opts);
            if (opts.query.filter.includes("hash='found-hash'")) {
                return {
                    items: [
                        {
                            id: 'obj-found',
                            vault: 'vault-test',
                            hash: 'found-hash',
                            parent_hash: null,
                            type: 'snapshot',
                            data: '# Content',
                            data_hash: 'dh-1',
                            diff_format: null,
                            size: 9,
                        },
                    ],
                };
            }
            return { items: [] };
        },
    };

    const mockAuthManager: any = {
        executeWithAuthRetry: async (op: () => Promise<any>) => op(),
    };

    const store = new PocketBaseStore(mockClient, mockAuthManager);

    // Found
    const objFound = await store.getObject('vault-test', 'found-hash');
    assert.ok(objFound);
    assert.equal(objFound?.id, 'obj-found');
    assert.equal(objFound?.data, '# Content');
    assert.equal(requests[0].path, '/api/collections/objects/records');
    assert.equal(requests[0].query.perPage, 1);
    assert.equal(requests[0].query.filter, "vault='vault-test' && hash='found-hash'");

    // Not found
    const objMissing = await store.getObject('vault-test', 'missing-hash');
    assert.equal(objMissing, null);
});

test('PocketBaseStore.getLatestFiles queries latest_vault_files with active and deleted filters', async () => {
    const requests: any[] = [];
    const mockClient: any = {
        request: async (opts: any) => {
            requests.push(opts);
            return {
                page: opts.query.page,
                perPage: opts.query.perPage,
                totalItems: 1,
                totalPages: 1,
                items: [
                    {
                        id: 'latest-1',
                        vault: 'vault-1',
                        path: 'Note.md',
                        operation: opts.query.filter.includes("operation='delete'") ? 'delete' : 'save',
                        timestamp: 100,
                        hash: 'hash-1',
                        object_id: 'obj-1',
                    },
                ],
            };
        },
    };

    const mockAuthManager: any = {
        executeWithAuthRetry: async (op: () => Promise<any>) => op(),
    };

    const store = new PocketBaseStore(mockClient, mockAuthManager);

    // 1. Query active (non-deleted) files
    const active = await store.getLatestFiles('vault-1', false);
    assert.equal(active.length, 1);
    assert.equal(active[0].objectId, 'obj-1');
    assert.equal(active[0].operation, 'save');
    assert.equal(requests[0].query.filter, "vault='vault-1' && operation!='delete'");
    assert.equal(requests[0].query.sort, 'path');

    // 2. Query deleted files
    const deleted = await store.getLatestFiles('vault-1', true);
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].operation, 'delete');
    assert.equal(requests[1].query.filter, "vault='vault-1' && operation='delete'");
    assert.equal(requests[1].query.sort, '-timestamp');
});

test('PocketBaseStore.getLatestFiles fetches every page across multiple groups with bounded concurrency in order', async () => {
    const requestedPages: number[] = [];
    const activePages = new Set<number>();
    let currentInFlight = 0;
    let maxInFlight = 0;
    const pageDelays: Record<number, number> = {
        1: 5,
        2: 25,
        3: 5,
        4: 15,
        5: 10,
        6: 5,
    };

    const client = new PocketBaseClient(() => 'https://backup.example.com');
    Object.defineProperty(client, 'request', {
        value: async <T>(options: RequestOptions, decode?: ResponseDecoder<T>): Promise<unknown> => {
            const page = options.query?.page;
            if (typeof page !== 'number') {
                throw new Error('Expected a numeric page query');
            }

            if (page === 1) {
                assert.equal(activePages.size, 0, 'page 1 must be fetched alone before subsequent pages');
            } else if (page === 6) {
                assert.ok(!activePages.has(2) && !activePages.has(3) && !activePages.has(4) && !activePages.has(5), 'group 1 must finish before group 2 starts');
            }

            activePages.add(page);
            currentInFlight++;
            maxInFlight = Math.max(maxInFlight, currentInFlight);
            assert.ok(currentInFlight <= LATEST_FILES_PAGE_FETCH_CONCURRENCY, 'in-flight requests must never exceed concurrency limit');
            requestedPages.push(page);

            await new Promise((resolve) => setTimeout(resolve, pageDelays[page] ?? 5));

            activePages.delete(page);
            currentInFlight--;

            const response: unknown = {
                page,
                perPage: 500,
                totalItems: 6,
                totalPages: 6,
                items: [makeLatestVaultFile(page)],
            };
            return decode ? decode(response) : response;
        },
    });
    const store = new PocketBaseStore(client, new AuthManager(client, () => DEFAULT_SETTINGS));

    const files = await store.getLatestFiles('vault-1');

    assert.ok(maxInFlight > 1, 'more than one page fetch overlaps');
    assert.ok(maxInFlight <= LATEST_FILES_PAGE_FETCH_CONCURRENCY, 'no more than four page fetches overlap');
    assert.equal(maxInFlight, 4);
    assert.deepEqual(requestedPages.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
    assert.equal(files.length, 6);
    assert.deepEqual(
        files.map((f) => f.path),
        ['Note-1.md', 'Note-2.md', 'Note-3.md', 'Note-4.md', 'Note-5.md', 'Note-6.md']
    );
});

test('PocketBaseStore.getLatestFiles handles single-page result without requesting additional pages', async () => {
    const requestedPages: number[] = [];
    let currentInFlight = 0;
    let maxInFlight = 0;
    const client = new PocketBaseClient(() => 'https://backup.example.com');
    Object.defineProperty(client, 'request', {
        value: async <T>(options: RequestOptions, decode?: ResponseDecoder<T>): Promise<unknown> => {
            const page = options.query?.page;
            if (typeof page !== 'number') {
                throw new Error('Expected a numeric page query');
            }
            currentInFlight++;
            maxInFlight = Math.max(maxInFlight, currentInFlight);
            requestedPages.push(page);
            await new Promise((resolve) => setTimeout(resolve, 5));
            currentInFlight--;

            const response: unknown = {
                page,
                perPage: 500,
                totalItems: 1,
                totalPages: 1,
                items: [makeLatestVaultFile(1)],
            };
            return decode ? decode(response) : response;
        },
    });
    const store = new PocketBaseStore(client, new AuthManager(client, () => DEFAULT_SETTINGS));

    const files = await store.getLatestFiles('vault-1');

    assert.deepEqual(requestedPages, [1]);
    assert.equal(maxInFlight, 1);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'Note-1.md');
});

function makeLatestVaultFile(index: number): Record<string, string | number> {
    return {
        id: `latest-${index}`,
        vault: 'vault-1',
        path: `Note-${index}.md`,
        operation: 'save',
        timestamp: index,
        hash: `hash-${index}`,
        object_id: `object-${index}`,
    };
}

test('PocketBaseStore.getVaultStats handles direct fetch, 404, and fallback query', async () => {
    let callCount = 0;
    const mockClient: any = {
        request: async (opts: any) => {
            callCount++;
            if (opts.path === '/api/collections/vault_stats/records/vault-success') {
                return { id: 'vault-success', vault: 'vault-success', total_objects: 10, snapshot_count: 5, diff_count: 5, total_bytes: 1000, snapshot_bytes: 800, diff_bytes: 200 };
            }
            if (opts.path === '/api/collections/vault_stats/records/vault-notfound') {
                throw new PocketBaseError(404, 'Record not found');
            }
            if (opts.path === '/api/collections/vault_stats/records/vault-fallback') {
                throw new Error('Internal error');
            }
            if (opts.path === '/api/collections/vault_stats/records' && opts.query?.filter?.includes("vault='vault-fallback'")) {
                return { items: [{ id: 'vault-fallback', vault: 'vault-fallback', total_objects: 2, snapshot_count: 1, diff_count: 1, total_bytes: 200, snapshot_bytes: 100, diff_bytes: 100 }] };
            }
            throw new Error(`Unhandled: ${opts.path}`);
        },
    };

    const mockAuthManager: any = {
        executeWithAuthRetry: async (op: () => Promise<any>) => op(),
    };

    const store = new PocketBaseStore(mockClient, mockAuthManager);

    // Direct success
    const stats1 = await store.getVaultStats('vault-success');
    assert.equal(stats1?.id, 'vault-success');
    assert.equal(stats1?.total_objects, 10);

    // 404 error returns null
    const stats2 = await store.getVaultStats('vault-notfound');
    assert.equal(stats2, null);

    // Fallback list query
    const stats3 = await store.getVaultStats('vault-fallback');
    assert.equal(stats3?.id, 'vault-fallback');
    assert.equal(stats3?.total_objects, 2);
});
});
