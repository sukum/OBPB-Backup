import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PocketBaseClient, PocketBaseError } from '../src/remote/pocketbase-client';
import { setRequestUrlOverride } from './mocks/request-url-hook';

async function withRequestUrlOverride(
    override: (param: any) => Promise<any>,
    action: () => Promise<void>
): Promise<void> {
    setRequestUrlOverride(override);
    try {
        await action();
    } finally {
        setRequestUrlOverride(undefined);
    }
}

describe('PocketBase Client', () => {

test('PocketBaseClient builds URLs, omits undefined query values, and sends auth and JSON body', async () => {
    let request: any;
    await withRequestUrlOverride(async (param) => {
        request = param;
        return { status: 200, text: '{"saved":true}', json: { saved: true } };
    }, async () => {
        const client = new PocketBaseClient(() => 'https://pb.example.test///');
        client.setToken('secret-token');

        const response = await client.request({
            method: 'PATCH',
            path: '/api/records/1',
            query: { search: "a b&c'", count: 3, enabled: true, omitted: undefined },
            headers: { 'X-Request-Id': 'req-1' },
            body: { title: 'Updated' },
        }, (value): { saved: boolean } => {
            if (typeof value !== 'object' || value === null || !('saved' in value) || typeof value.saved !== 'boolean') {
                throw new Error('Invalid response.');
            }
            return { saved: value.saved };
        });

        assert.deepEqual(response, { saved: true });
        assert.equal(request.url, 'https://pb.example.test/api/records/1?search=a+b%26c%27&count=3&enabled=true');
        assert.equal(request.method, 'PATCH');
        assert.equal(request.headers.Accept, 'application/json');
        assert.equal(request.headers.Authorization, 'Bearer secret-token');
        assert.equal(request.headers['X-Request-Id'], 'req-1');
        assert.equal(request.headers['Content-Type'], 'application/json');
        assert.equal(request.body, '{"title":"Updated"}');
        assert.equal(request.throw, false);
    });
});

test('PocketBaseClient defaults to GET, supports paths without a leading slash, and omits the body', async () => {
    let request: any;
    await withRequestUrlOverride(async (param) => {
        request = param;
        return { status: 200, text: '', json: { id: 'record-1' } };
    }, async () => {
        const client = new PocketBaseClient(() => 'https://pb.example.test/');
        assert.deepEqual(await client.request({ path: 'api/records/record-1' }), { id: 'record-1' });
        assert.equal(request.url, 'https://pb.example.test/api/records/record-1');
        assert.equal(request.method, 'GET');
        assert.equal(request.body, undefined);
        assert.equal(request.headers.Authorization, undefined);
        assert.equal(request.headers['Content-Type'], undefined);
    });
});

test('PocketBaseClient rejects an empty base URL without making a request', async () => {
    let requestCount = 0;
    await withRequestUrlOverride(async () => {
        requestCount++;
        return { status: 200, text: '', json: {} };
    }, async () => {
        const client = new PocketBaseClient(() => '');
        await assert.rejects(client.request({ path: '/api/health' }), /server URL is not configured/i);
        assert.equal(requestCount, 0);
    });
});

test('PocketBaseClient resolves 204 responses as undefined', async () => {
    await withRequestUrlOverride(async () => ({ status: 204, text: '', json: null }), async () => {
        const client = new PocketBaseClient(() => 'https://pb.example.test');
        assert.equal(await client.request({ path: '/api/records/1', method: 'DELETE' }), undefined);
    });
});

test('PocketBaseClient exposes HTTP error status, response text, and parsed data', async () => {
    await withRequestUrlOverride(async () => ({
        status: 422,
        text: 'Validation failed',
        json: { message: 'Invalid field' },
    }), async () => {
        const client = new PocketBaseClient(() => 'https://pb.example.test');
        await assert.rejects(client.request({ path: '/api/records', method: 'POST' }), (error: unknown) => {
            assert.ok(error instanceof PocketBaseError);
            assert.equal(error.status, 422);
            assert.equal(error.responseText, 'Validation failed');
            assert.deepEqual(error.data, { message: 'Invalid field' });
            return true;
        });
    });
});

test('PocketBaseClient preserves HTTP errors as text when the response JSON getter fails', async () => {
    const response: any = { status: 500, text: 'Server failure' };
    await withRequestUrlOverride(async () => {
        Object.defineProperty(response, 'json', { get: () => { throw new Error('Invalid JSON'); } });
        return response;
    }, async () => {
        const client = new PocketBaseClient(() => 'https://pb.example.test');
        await assert.rejects(client.request({ path: '/api/health' }), (error: unknown) => {
            assert.ok(error instanceof PocketBaseError);
            assert.equal(error.status, 500);
            assert.equal(error.data, response?.text);
            return true;
        });
    });
});
});
