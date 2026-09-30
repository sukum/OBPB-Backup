/**
 * Lightweight, type-safe subscriber-notify emitter.
 */

export type Listener<T> = (payload: T) => void;
export type Unsubscribe = () => void;

type EmitArgs<T> = [T] extends [void] ? [] | [payload?: void] : [payload: T];

export class EventEmitter<T = void> {
    private listeners = new Set<Listener<T>>();

    /**
     * Subscribes a listener function and returns an unsubscription closure.
     */
    public subscribe(listener: Listener<T>): Unsubscribe {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Notifies all registered listeners with a payload.
     * Catches and logs any listener errors so sibling listeners continue execution.
     */
    public notify(...args: EmitArgs<T>): void {
        const payload = args[0] as T;
        for (const listener of this.listeners) {
            try {
                listener(payload);
            } catch (err) {
                console.error('[OBPB Backup] Error in event listener:', err);
            }
        }
    }

    /**
     * Alias for notify to support backwards compatibility.
     */
    public emit(...args: EmitArgs<T>): void {
        this.notify(...args);
    }

    /**
     * Clears all registered listeners.
     */
    public clear(): void {
        this.listeners.clear();
    }

    /**
     * Returns the count of active listeners.
     */
    public get size(): number {
        return this.listeners.size;
    }
}
