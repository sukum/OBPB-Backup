
export const FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS = 1500 as const;

export function truncatePayloadPreview(raw: string): string;
export function truncatePayloadPreview(raw: undefined): undefined;
export function truncatePayloadPreview(raw?: string): string | undefined;
export function truncatePayloadPreview(raw?: string): string | undefined {
    if (typeof raw !== 'string') {
        return undefined;
    }
    return raw.slice(0, FAILED_TASK_PAYLOAD_PREVIEW_MAX_CHARS);
}
