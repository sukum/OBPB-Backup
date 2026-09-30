import { PocketBaseError } from '../remote/pocketbase-client';
import { isPocketBaseErrorPayload } from '../remote/pocketbase-error-utils';
import { POCKETBASE_OBJECT_DATA_MAX_CHARACTERS } from '../remote/pocketbase-schema';
import type { FailedTaskLikelyReason } from '../types/state';

/**
 * Classifies an upload failure without deciding how the queue should recover.
 */
export type UploadErrorCategory =
    | 'connectivity'
    | 'authentication'
    | 'validation'
    | 'rate_limited'
    | 'retryable_request'
    | 'terminal_request';

// Message substrings kept for failures that carry no HTTP status (the PocketBase
// max-length validation echoes the configured limit back in its response text).
// Centralized here so no other module pattern-matches error text.
const SIZE_LIMIT_MESSAGE_HINTS: readonly string[] = [
    'validation_max_length',
    'size_limit',
    'file exceeds',
    String(POCKETBASE_OBJECT_DATA_MAX_CHARACTERS),
];

const NETWORK_ERROR_MESSAGE_HINTS: readonly string[] = ['offline', 'network', 'timeout'];

function includesAny(haystack: string, needles: readonly string[]): boolean {
    return needles.some((needle) => haystack.includes(needle));
}

/**
 * PocketBase 400 bodies carry per-field validation codes, e.g.
 * { data: { data: { code: 'validation_max_length' } } } when objects.data
 * exceeds its `max` characters limit.
 */
function hasOversizeFieldValidation(data: unknown): boolean {
    if (!isPocketBaseErrorPayload(data) || !data.data) return false;
    return Object.values(data.data).some(
        (field) => field?.code === 'validation_max_length'
    );
}

export class ErrorClassificationPolicy {
    public static classify(error: unknown): UploadErrorCategory {
        // requestUrl failures (DNS, timeouts, connection refused) do not have
        // an HTTP status and should not consume a task's retry budget.
        // but will it lead to continuous pause. need to check.
        if (!(error instanceof PocketBaseError)) {
            return 'connectivity';
        }

        if (error.status === 401 || error.status === 403) return 'authentication';
        if (error.status === 400 || error.status === 422) return 'validation';
        if (error.status === 408 || (error.status >= 500 && error.status <= 599)) return 'connectivity';
        if (error.status === 429) return 'rate_limited';
        if (error.status >= 409 && error.status < 500) return 'retryable_request';

        return 'terminal_request';
    }

    /**
     * User-facing diagnosis of why a task most likely failed, derived from the
     * structured error (HTTP status, PocketBase field validation codes) where
     * available. Callers should pass the unwrapped cause, not a
     * RunnerExecutionError whose message composes stage text with the cause.
     */
    public static diagnose(error: unknown): FailedTaskLikelyReason {
        const loweredMessage = (error instanceof Error ? error.message : String(error)).toLowerCase();

        if (includesAny(loweredMessage, SIZE_LIMIT_MESSAGE_HINTS)
            || (error instanceof PocketBaseError && hasOversizeFieldValidation(error.data))) {
            return 'size_limit';
        }

        if (error instanceof PocketBaseError) {
            if (error.status === 400 || error.status === 422) return 'validation_error';
            if (error.status === 408 || error.status === 429 || error.status >= 500) return 'network_outage';
            return 'other';
        }

        if (loweredMessage.includes('http 400') || loweredMessage.includes('validation')) {
            return 'validation_error';
        }
        if (includesAny(loweredMessage, NETWORK_ERROR_MESSAGE_HINTS)) {
            return 'network_outage';
        }
        return 'other';
    }
}
