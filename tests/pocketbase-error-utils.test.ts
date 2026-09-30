import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PocketBaseError } from '../src/remote/pocketbase-client';
import {
    classifyPocketBaseError,
    isDuplicateIdError,
    isPocketBaseErrorPayload,
} from '../src/remote/pocketbase-error-utils';

describe('PocketBase Error Utils', () => {
    describe('isPocketBaseErrorPayload', () => {
        test('recognizes valid error payloads', () => {
            assert.equal(isPocketBaseErrorPayload({}), true);
            assert.equal(isPocketBaseErrorPayload({ code: 400, message: 'Bad request' }), true);
            assert.equal(
                isPocketBaseErrorPayload({
                    code: 400,
                    message: 'Failed to create record.',
                    data: {
                        id: {
                            code: 'validation_not_unique',
                            message: 'Value must be unique.',
                        },
                    },
                }),
                true
            );
            assert.equal(isPocketBaseErrorPayload({ data: {} }), true);
            assert.equal(
                isPocketBaseErrorPayload({
                    data: {
                        field1: { code: 'validation_max_length' },
                        field2: undefined,
                    },
                }),
                true
            );
        });

        test('rejects non-object or invalid payloads', () => {
            assert.equal(isPocketBaseErrorPayload(null), false);
            assert.equal(isPocketBaseErrorPayload(undefined), false);
            assert.equal(isPocketBaseErrorPayload('error string'), false);
            assert.equal(isPocketBaseErrorPayload(400), false);
            assert.equal(isPocketBaseErrorPayload([]), false);
            assert.equal(isPocketBaseErrorPayload({ code: '400' }), false);
            assert.equal(isPocketBaseErrorPayload({ message: 123 }), false);
            assert.equal(isPocketBaseErrorPayload({ data: 'not an object' }), false);
            assert.equal(isPocketBaseErrorPayload({ data: null }), false);
            assert.equal(isPocketBaseErrorPayload({ data: { id: 'invalid_field_error_string' } }), false);
        });
    });

    describe('isDuplicateIdError', () => {
        test('returns true for status 400 with validation_not_unique on id', () => {
            const err = new PocketBaseError(400, 'Failed to create record.', {
                code: 400,
                message: 'Failed to create record.',
                data: {
                    id: {
                        code: 'validation_not_unique',
                        message: 'Value must be unique.',
                    },
                },
            });
            assert.equal(isDuplicateIdError(err), true);
        });

        test('returns false for non-400 status codes even if payload matches', () => {
            const err = new PocketBaseError(422, 'Unprocessable', {
                data: {
                    id: { code: 'validation_not_unique' },
                },
            });
            assert.equal(isDuplicateIdError(err), false);
        });

        test('returns false when validation code on id is different', () => {
            const err = new PocketBaseError(400, 'Failed to create record.', {
                data: {
                    id: { code: 'validation_required' },
                },
            });
            assert.equal(isDuplicateIdError(err), false);
        });

        test('returns false when error is not PocketBaseError or has missing/invalid data', () => {
            assert.equal(isDuplicateIdError(new Error('validation_not_unique')), false);
            assert.equal(isDuplicateIdError(new PocketBaseError(400, 'Bad request', null)), false);
            assert.equal(isDuplicateIdError(new PocketBaseError(400, 'Bad request', 'raw string')), false);
            assert.equal(isDuplicateIdError(new PocketBaseError(400, 'Bad request', {})), false);
            assert.equal(isDuplicateIdError(new PocketBaseError(400, 'Bad request', { data: {} })), false);
        });
    });

    describe('classifyPocketBaseError', () => {
        test('classifies HTTP statuses correctly', () => {
            assert.equal(classifyPocketBaseError(new PocketBaseError(401, 'Unauthorized')), 'token_expired');
            assert.equal(classifyPocketBaseError(new PocketBaseError(403, 'Forbidden')), 'permission_denied');
            assert.equal(classifyPocketBaseError(new PocketBaseError(400, 'Bad request')), 'validation_error');
            assert.equal(classifyPocketBaseError(new PocketBaseError(404, 'Not found')), 'not_found');
            assert.equal(classifyPocketBaseError(new PocketBaseError(500, 'Internal Server Error')), 'network_error');
            assert.equal(classifyPocketBaseError(new PocketBaseError(502, 'Bad Gateway')), 'network_error');
            assert.equal(classifyPocketBaseError(new PocketBaseError(418, "I'm a teapot")), 'unknown');
        });

        test('classifies TypeError as network_error', () => {
            assert.equal(classifyPocketBaseError(new TypeError('Failed to fetch')), 'network_error');
        });

        test('classifies arbitrary errors as unknown', () => {
            assert.equal(classifyPocketBaseError(new Error('generic failure')), 'unknown');
            assert.equal(classifyPocketBaseError('string error'), 'unknown');
            assert.equal(classifyPocketBaseError(null), 'unknown');
        });
    });
});
