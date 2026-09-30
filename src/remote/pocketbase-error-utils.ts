import { isRecord } from '../utils/guards';
import { PocketBaseError } from './pocketbase-client';

/**
 * PocketBase individual field validation error representation.
 */
export interface PocketBaseFieldError {
    code?: string;
    message?: string;
}

/**
 * PocketBase API error response body (e.g. HTTP 400 validation failures).
 */
export interface PocketBaseErrorPayload {
    code?: number;
    message?: string;
    data?: Record<string, PocketBaseFieldError | undefined>;
}

/**
 * Type guard verifying whether an unknown value conforms to PocketBaseErrorPayload.
 */
export function isPocketBaseErrorPayload(value: unknown): value is PocketBaseErrorPayload {
    if (!isRecord(value)) return false;
    if ('code' in value && value.code !== undefined && typeof value.code !== 'number') {
        return false;
    }
    if ('message' in value && value.message !== undefined && typeof value.message !== 'string') {
        return false;
    }
    if ('data' in value && value.data !== undefined) {
        if (!isRecord(value.data)) return false;
        for (const field of Object.values(value.data)) {
            if (field !== undefined && !isRecord(field)) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Coarse classification of a failure originating from a PocketBase request or
 * from a local operation (secret storage, JWT parsing) that mirrors the same
 * diagnostic categories. Used only to make log output actionable; never
 * carries secret values.
 */
export type FailureKind =
    | 'token_expired'
    | 'permission_denied'
    | 'validation_error'
    | 'not_found'
    | 'network_error'
    | 'unknown';

/**
 * Classifies an unknown error into a diagnostic category based on
 * PocketBaseError HTTP status (when present) or error shape.
 * Safe to log: never includes request/response bodies or secret values.
 */
export function classifyPocketBaseError(err: unknown): FailureKind {
    if (err instanceof PocketBaseError) {
        switch (err.status) {
            case 401:
                return 'token_expired';
            case 403:
                return 'permission_denied';
            case 400:
                return 'validation_error';
            case 404:
                return 'not_found';
            default:
                return err.status >= 500 ? 'network_error' : 'unknown';
        }
    }
    // TypeError/fetch-level failures (DNS, offline, CORS, etc.) surface without a status.
    if (err instanceof TypeError) {
        return 'network_error';
    }
    return 'unknown';
}

/*
{
    "code": 400,
    "message": "Failed to create record.",
    "data": {
        "id": {
            "code": "validation_not_unique",
            "message": "Value must be unique."
        }
    }
}
*/

export function isDuplicateIdError(err: unknown): boolean {
    if (!(err instanceof PocketBaseError) || err.status !== 400) return false;
    if (!isPocketBaseErrorPayload(err.data)) return false;
    return err.data.data?.id?.code === 'validation_not_unique';
}
