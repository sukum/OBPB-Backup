import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { RequestUrlParam } from 'obsidian';
import { AuthManager } from '../src/remote/auth-manager';
import { PocketBaseStore } from '../src/remote/pocketbase-store';
import { PocketBaseHealthChecker } from '../src/remote/pocketbase-health-checker';
import { PocketBaseClient, PocketBaseError } from '../src/remote/pocketbase-client';
import { InMemorySecretStorageProvider } from '../src/remote/secret-storage';
import type { CreateBackupObject, CreateHistoryEntry } from '../src/types/database';
import { DEFAULT_SETTINGS } from '../src/types/settings';
import { setRequestUrlOverride } from './mocks/request-url-hook';

function createHarness(userId: string | null = 'user-1') {
    const requests: any[] = [];
    let requestImpl: (options: any) => Promise<any> = async () => undefined;
    const client = {
        request: async (options: any) => {
            requests.push(options);
            return requestImpl(options);
        },
    };
    const authManager = {
        getUserId: () => userId,
        executeWithAuthRetry: <T>(action: () => Promise<T>) => action(),
    };
    return {
        store: new PocketBaseStore(client as any, authManager as any),
        healthChecker: new PocketBaseHealthChecker(client as any),
        requests,
        setRequestImpl: (impl: (options: any) => Promise<any>) => { requestImpl = impl; },
    };
}

const object: CreateBackupObject = {
    id: 'object-1',
    vault: 'vault-1',
    hash: 'sha256:content',
    parentHash: null,
    type: 'snapshot',
    data: '# Note',
    dataHash: 'sha256:data',
    diffFormat: null,
    encoding: 'none',
    size: 6,
};

const entry: CreateHistoryEntry = {
    id: 'entry-1',
    vault: 'vault-1',
    path: 'Notes/Note.md',
    oldPath: null,
    objectId: object.id,
    hash: object.hash,
    operation: 'save',
    device: 'device-1',
    timestamp: 100,
};

for (const expired of [false, true]) {
    const recovery = expired ? 'password re-login after expiry' : 'token refresh';
    test(`PocketBaseStore uses the token saved by ${recovery} across a restart`, async (t) => {
        const settings = { ...DEFAULT_SETTINGS, serverUrl: 'https://backup.example.test', userEmail: 'user@example.test' };
        const storage = new InMemorySecretStorageProvider();
        const initialToken = `header.${btoa(JSON.stringify({ id: 'user-1', exp: expired ? 1 : 9999999998 }))}.signature`;
        const replacementToken = `header.${btoa(JSON.stringify({ id: 'user-1', exp: 9999999999 }))}.signature`;
        await storage.setSecret(AuthManager.SECRET_KEY_TOKEN, initialToken);
        await storage.setSecret(AuthManager.SECRET_KEY_PASSWORD, 'saved-password');

        const calls: Array<[string, string | undefined]> = [];
        setRequestUrlOverride(async ({ url, headers }: RequestUrlParam) => {
            const path = new URL(url).pathname;
            const authorization = headers?.Authorization;
            calls.push([path, authorization]);

            if (expired && path === '/api/collections/users/auth-refresh') {
                const json = { status: 401, message: 'The request requires valid record authorization token.', data: {} };
                return { status: 401, text: JSON.stringify(json), json };
            }
            if (path === '/api/collections/users/auth-refresh' || path === '/api/collections/users/auth-with-password') {
                return { status: 200, text: '', json: { token: replacementToken, record: { id: 'user-1' } } };
            }
            if (authorization !== `Bearer ${replacementToken}`) {
                const json = { status: 400, message: 'Failed to create record.', data: {} };
                return { status: 400, text: JSON.stringify(json), json };
            }
            return { status: 200, text: '', json: {} };
        });
        t.after(() => setRequestUrlOverride(undefined));

        const client = new PocketBaseClient(() => settings.serverUrl);
        const auth = new AuthManager(client, () => settings, storage);
        assert.equal(await auth.loadStoredAuth(), true);
        if (!expired) assert.equal(await auth.checkAuth(), true);
        await new PocketBaseStore(client, auth).putObject(object);
        assert.equal(await storage.getSecret(AuthManager.SECRET_KEY_TOKEN), replacementToken);

        const restartedClient = new PocketBaseClient(() => settings.serverUrl);
        const restartedAuth = new AuthManager(restartedClient, () => settings, storage);
        assert.equal(await restartedAuth.loadStoredAuth(), true);
        await new PocketBaseStore(restartedClient, restartedAuth).addEntry(entry);

        assert.deepEqual(calls.map(([path]) => path), [
            '/api/collections/users/auth-refresh',
            ...(expired ? ['/api/collections/users/auth-with-password'] : []),
            '/api/collections/objects/records',
            '/api/collections/entries/records',
        ]);
        assert.equal(calls[0]?.[1], `Bearer ${initialToken}`);
        assert.deepEqual(calls.slice(-2).map(([, authorization]) => authorization), [
            `Bearer ${replacementToken}`,
            `Bearer ${replacementToken}`,
        ]);
    });
}

test('PocketBaseStore writes mapped object and entry records with the authenticated user', async () => {
    const { store, requests } = createHarness();

    await store.putObject(object);
    await store.addEntry(entry);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].path, '/api/collections/objects/records');
    assert.deepEqual(requests[0].body, {
        id: 'object-1',
        vault: 'vault-1',
        hash: 'sha256:content',
        parent_hash: null,
        type: 'snapshot',
        data: '# Note',
        data_hash: 'sha256:data',
        diff_format: null,
        encoding: 'none',
        size: 6,
        user: 'user-1',
    });
    assert.equal(requests[1].method, 'POST');
    assert.equal(requests[1].path, '/api/collections/entries/records');
    assert.deepEqual(requests[1].body, {
        id: 'entry-1',
        vault: 'vault-1',
        path: 'Notes/Note.md',
        old_path: null,
        object_id: 'object-1',
        hash: 'sha256:content',
        operation: 'save',
        device: 'device-1',
        timestamp: 100,
        user: 'user-1',
    });
});

describe("PocketBase Store", () => {

test('PocketBaseStore rejects writes when the authenticated user ID is unavailable', async () => {
    const { store, requests } = createHarness(null);

    await assert.rejects(store.putObject(object), /Authenticated user ID is unavailable/);
    await assert.rejects(store.addEntry(entry), /Authenticated user ID is unavailable/);
    assert.deepEqual(requests, []);
});

test('PocketBaseStore treats duplicate object and entry IDs as idempotent writes', async () => {
    const { store, setRequestImpl } = createHarness();
    const errBody = `{
        "code": 400,
        "message": "Failed to create record.",
        "data": {
            "id": {
                "code": "validation_not_unique",
                "message": "Value must be unique."
            }
        }
    }`;
    setRequestImpl(async () => {
        throw new PocketBaseError(400, 'Bad request', JSON.parse(errBody));
    });

    await assert.doesNotReject(store.putObject(object));
    await assert.doesNotReject(store.addEntry(entry));
});

test('PocketBaseStore rethrows non-duplicate write errors', async () => {
    const { store, setRequestImpl } = createHarness();
    const validationError = new PocketBaseError(400, 'Bad request', { message: 'Schema mismatch' });
    setRequestImpl(async () => { throw validationError; });

    await assert.rejects(store.putObject(object), (error) => error === validationError);
    await assert.rejects(store.addEntry(entry), (error) => error === validationError);

    const serverError = new PocketBaseError(500, 'Server failure');
    setRequestImpl(async () => { throw serverError; });
    await assert.rejects(store.putObject(object), (error) => error === serverError);
});

test('PocketBaseHealthChecker healthCheck validates the health response code', async (t) => {
    t.mock.method(console, 'log', () => {});
    const { healthChecker, setRequestImpl, requests } = createHarness();
    setRequestImpl(async () => ({ code: 200 }));
    await healthChecker.healthCheck();
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].path, '/api/health');

    setRequestImpl(async () => ({ code: 503 }));
    await assert.rejects(healthChecker.healthCheck(), /Health check failed/);
    setRequestImpl(async () => undefined);
    await assert.rejects(healthChecker.healthCheck(), /Health check failed/);
});
});
