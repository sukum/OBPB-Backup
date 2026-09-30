import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PocketBaseStore } from '../src/remote/pocketbase-store';
import { PocketBaseHealthChecker } from '../src/remote/pocketbase-health-checker';
import { PocketBaseError } from '../src/remote/pocketbase-client';
import type { CreateBackupObject, CreateHistoryEntry } from '../src/types/database';

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
