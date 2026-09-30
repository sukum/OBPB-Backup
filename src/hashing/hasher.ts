import type { BackupOperation } from "../types/domain";

/**
 * cryptographic hashing using standard Web Crypto API.
 */
export const HASH_ALGO_PREFIX = 'sha256:';
const HASH_STUB_LENGTH = 8;
const HASH_ALGO_LENGTH = HASH_ALGO_PREFIX.length;
const HASH_STUB_END = HASH_ALGO_LENGTH + HASH_STUB_LENGTH;

export class Hasher {
    private static textEncoder = new TextEncoder();

    /**
     * subtle crypto instance.
     */
    private static getSubtleCrypto(): SubtleCrypto {
        const subtle = globalThis.crypto?.subtle;
        if (!subtle) {
            throw new Error('Web Crypto API (crypto.subtle) is not available in this environment.');
        }
        return subtle;
    }

    /**
     * Computes raw SHA-256 hex digest of a UTF-8 string.
     */
    public static async sha256Hex(content: string): Promise<string> {
        const subtle = this.getSubtleCrypto();
        const data = this.textEncoder.encode(content);
        const hashBuffer = await subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Strips away the sha256: prefix and returns the next 8 chars
     */
    public static hashStub8(hash: string): string {
        return hash.substring(HASH_ALGO_LENGTH, HASH_STUB_END);
    }

    /**
     * Computes content hash prefixed with "sha256:".
     * This represents the resulting file content identity.
     */
    public static async computeHash(content: string): Promise<string> {
        const hex = await this.sha256Hex(content);
        return `${HASH_ALGO_PREFIX}${hex}`;
    }

    /**
     * Computes raw data payload hash prefixed with "sha256:".
     */
    public static async computeDataHash(data: string): Promise<string> {
        return this.computeHash(data);
    }

    /**
     * Converts a SHA-256 hex string into a valid 15-character lowercase alphanumeric PocketBase ID.
     * PocketBase record IDs must be 15 lowercase letters or digits.
     */
    public static hexToPocketBaseId(hexOrHash: string): string {
        const clean = hexOrHash.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (clean.length < 15) {
            throw new Error(`Insufficient alphanumeric characters for PocketBase ID from '${hexOrHash}'`);
        }
        return clean.slice(0, 15);
    }

    /**
     * Derives deterministic 15-character PocketBase record ID for entry record.
     * Formula: hex_to_pb_id(sha256(device + vault + path + oldPath + operation + objectId + timestamp))
     */
    public static async deriveEntryId(
        device: string,
        vault: string,
        path: string,
        oldPath: string | null,
        operation: BackupOperation,
        objectId: string | null,
        timestamp: number
    ): Promise<string> {
        const rawSeed = `${device}:${vault}:${path}:${oldPath ?? 'null'}:${operation}:${objectId}:${timestamp}`;
        const hex = await this.sha256Hex(rawSeed);
        return this.hexToPocketBaseId(hex);
    }

    /**
     * Derives deterministic 15-character PocketBase record ID for snapshot objects.
     * Formula: hex_to_pb_id(sha256(vault + ":" + contentHash))
     */
    public static async deriveSnapshotObjectId(vault: string, contentHash: string): Promise<string> {
        const rawSeed = `${vault}:${contentHash}`;
        const hex = await this.sha256Hex(rawSeed);
        return this.hexToPocketBaseId(hex);
    }

    /**
     * Derives deterministic 15-character PocketBase record ID for diff objects.
     * Formula: hex_to_pb_id(sha256(vault + ":" + parentHash + ":" + contentHash + ":" + diffFormat))
     */
    public static async deriveDiffObjectId(
        vault: string,
        parentHash: string | null,
        contentHash: string,
        diffFormat: string | null
    ): Promise<string> {
        const rawSeed = `${vault}:${parentHash ?? 'null'}:${contentHash}:${diffFormat ?? 'null'}`;
        const hex = await this.sha256Hex(rawSeed);
        return this.hexToPocketBaseId(hex);
    }
}
