// To abort a scheduled timout when app is closing and calls onUnload
export function scheduleAbortableTimeout(
    signal: AbortSignal,
    callback: () => Promise<void>,  // Called on normal execution after the delay
    delayMs: number,                // delay
    onAbort?: () => Promise<void>,  // Called if aborted
): void {
    if (signal.aborted) {
        if (onAbort) void onAbort();
        return;
    }

    const timeout = setTimeout(() => {
        signal.removeEventListener('abort', handleAbort);
        if (!signal.aborted) void callback();
    }, delayMs);

    const handleAbort = (): void => {
        clearTimeout(timeout);
        if (onAbort) void onAbort();
    };

    signal.addEventListener('abort', handleAbort, { once: true });
}
