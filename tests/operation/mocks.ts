import { mock } from 'node:test';
import type { DebouncedSaveTask } from '../../src/types/state';
import type { DebounceScheduler } from '../../src/operations/types';

export class DebounceController implements DebounceScheduler {
    public constructor(private cancelCallback: (path: string) => void = () => {}) {}
    public async schedule(task: DebouncedSaveTask): Promise<void> { await mock.fn(); }
    public cancel(path: string): void { this.cancelCallback(path); }
    public async flushFile(path: string): Promise<void> { await mock.fn(); }
    public async flushAll(): Promise<void> { await mock.fn(); }
}
