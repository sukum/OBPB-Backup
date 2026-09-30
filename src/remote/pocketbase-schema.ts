/**
 * Client-side contract for the PocketBase `objects` collection.
 *
 * Keep this value aligned with the `objects.data` field's `max` value in
 * pb_schema.json and the PocketBase migration.
 * This is used to list in UI if an upload error is related to size exceeding.
 * policies/snapshot-policy has
 * - hard upper limit of MAX_FILE_SIZE_BYTES (10MB) to skip file at debounce stage
 * - isSnapshotOnly uses settings.maxFileSizeMb (default: 5MB)
 * Probably keep the pocketbase limit sufficiently high and control the limits in code
 * So need to increase POCKETBASE_OBJECT_DATA_MAX_CHARACTERS to something big acceptable by sqlite/pocketbase
 * TODO
 */
export const POCKETBASE_OBJECT_DATA_MAX_CHARACTERS = 5_000_000;

/**
 * PocketBase text-field limits are measured in characters, rather than the
 * UTF-8 byte count stored in an object's `size` metadata.
 */
export function exceedsPocketBaseObjectDataLimit(data: string | undefined): boolean {
    return Array.from(data ?? '').length > POCKETBASE_OBJECT_DATA_MAX_CHARACTERS;
}
