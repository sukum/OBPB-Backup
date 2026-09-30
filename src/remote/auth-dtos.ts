import { isRecord } from '../utils/guards';

export interface PocketBaseAuthRecordDto {
    id: string;
}

export interface PocketBaseAuthResponseDto {
    token: string;
    record?: PocketBaseAuthRecordDto;
}

// Sample response format
/*
{
  "token": "...JWT...",
  "record": {
    "collectionId": "_pb_users_auth_",
    "collectionName": "users",
    "id": "7egkzqaaseawfxt",
    "email": "test@example.com",
    "emailVisibility": false,
    "verified": false,
    "name": "example text",
    "avatar": "test_dpq9eciy8i.txt",
    "created": "2026-01-18 07:03:38.897Z",
    "updated": "2026-01-18 07:03:38.897Z"
  }
}
*/

/** Validates the subset of PocketBase's auth response consumed by the plugin. */
export function parsePocketBaseAuthResponse(value: unknown): PocketBaseAuthResponseDto {
    if (!isRecord(value) || typeof value.token !== 'string' || value.token.length === 0) {
        throw new Error('Invalid PocketBase authentication response: token is missing.');
    }

    if (value.record === undefined || value.record === null) {
        return { token: value.token };
    }

    if (!isRecord(value.record) || typeof value.record.id !== 'string' || value.record.id.length === 0) {
        throw new Error('Invalid PocketBase authentication response: record ID is invalid.');
    }

    return {
        token: value.token,
        record: { id: value.record.id },
    };
}
