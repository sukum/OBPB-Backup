export interface DiffWorkerRequest {
    id: number;
    oldText: string;
    newText: string;
}

export interface DiffWorkerResponse {
    id: number;
    patch?: string;
    error?: string;
}

/**
 * Worker script code string that instantiated via Blob URL
 */
export const DIFF_WORKER_SCRIPT = `
self.onmessage = function(e) {
    const { id, oldText, newText } = e.data;
    try {
        // line diff for worker context if external modules unavailable,
        // or message handler wrapper.
        self.postMessage({ id, oldText, newText });
    } catch (err) {
        self.postMessage({ id, error: String(err) });
    }
};
`;
