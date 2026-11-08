import './setup.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { ActivityHistoryManager } from '../src/state/activity-history-manager';
import { ActivityTracker } from '../src/state/activity-tracker';
import { parseActivityHistoryState } from '../src/state/state-validation';
import type { ActivityHistoryPersistence } from '../src/state/types';
import type { ActivityRecord } from '../src/types/state';
import { Container } from '../src/container';
import { teardownContainer } from '../src/bootstrap';

function deferred() {
    let resolve = (): void => {};
    const promise = new Promise<void>((complete) => { resolve = complete; });
    return { promise, resolve };
}

function record(id: string): ActivityRecord {
    return { id, path: `${id}.md`, event: 'modify', timestamp: 1, status: 'completed' };
}

function createHistory(t: TestContext, beforeWrite: () => Promise<void> = async () => {}) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const writes: ActivityRecord[][] = [];
    let persisted: string | null = null;
    const manager = new ActivityHistoryManager({
        read: async () => persisted,
        write: async (fileName: string, data: string) => {
            assert.equal(fileName, ActivityHistoryManager.FILE_NAME);
            const state = parseActivityHistoryState(data);
            await beforeWrite();
            writes.push(state.records);
            persisted = data;
        },
    });
    return { manager, writes };
}

test('activity events schedule each stage update with the configured history limit', async () => {
    const scheduled: Array<{ records: ActivityRecord[]; limit: number }> = [];
    const persistence: ActivityHistoryPersistence = {
        load: async () => [],
        scheduleSave: async (records, limit) => { scheduled.push({ records: structuredClone(records), limit }); },
        flush: async () => {},
    };
    const tracker = new ActivityTracker(persistence, () => 7);
    await tracker.initialize();

    tracker.record({ taskId: 'task', path: 'Note.md', stage: 'debounce', status: 'active' });
    tracker.record({ taskId: 'task', path: 'Note.md', stage: 'queue', status: 'completed' });

    assert.equal(scheduled.length, 2);
    assert.deepEqual(scheduled.map(save => save.limit), [7, 7]);
    assert.equal(scheduled[0]?.records[0]?.status, 'ongoing');
    assert.equal(scheduled[1]?.records[0]?.status, 'completed');
});

test('shutdown persists scheduled activities and dismissals before their timer fires', async (t) => {
    const { manager, writes } = createHistory(t);
    const tracker = new ActivityTracker(manager, () => 7);
    await tracker.initialize();
    const container = new Container();
    container.registerInstance(ActivityHistoryManager, manager);
    container.registerInstance(ActivityTracker, tracker);

    for (const taskId of ['first', 'second']) {
        tracker.record({ taskId, path: `${taskId}.md`, stage: 'queue', status: 'completed' });
    }
    assert.equal(writes.length, 0);
    await teardownContainer(container);
    assert.deepEqual((await manager.load(7)).map(entry => entry.id), ['first', 'second']);

    tracker.dismissRecord('first');
    await teardownContainer(container);
    assert.deepEqual((await manager.load(7)).map(entry => entry.id), ['second']);

    tracker.dismissRecord('second');
    await teardownContainer(container);
    assert.deepEqual(await manager.load(7), []);
    assert.equal(writes.length, 3);
    t.mock.timers.tick(15_000);
    await setImmediate();
    assert.equal(writes.length, 3, 'shutdown must cancel pending timers');
});

for (const mode of ['timer', 'flush'] as const) {
    for (const update of ['replacement', 'empty', 'in-place'] as const) {
        test(`${mode} write preserves ${update} updates scheduled during disk I/O`, async (t) => {
            const started = deferred();
            const release = deferred();
            let writeCount = 0;
            const { manager, writes } = createHistory(t, async () => {
                if (++writeCount === 1) {
                    started.resolve();
                    await release.promise;
                }
            });
            const records = [record('first')];
            let firstFlush: Promise<void> | undefined;
            if (mode === 'timer') {
                await manager.scheduleSave(records, 7);
                t.mock.timers.tick(15_000);
            } else {
                firstFlush = manager.flush(records, 7);
            }
            await started.promise;

            const latest = update === 'empty' ? [] : [record('second')];
            if (update === 'in-place') {
                records.splice(0, records.length, ...latest);
            }
            await manager.scheduleSave(update === 'in-place' ? records : latest, 7);
            release.resolve();
            await firstFlush;
            await setImmediate();

            t.mock.timers.tick(15_000);
            await setImmediate();
            assert.deepEqual(writes, [[record('first')], latest]);
        });
    }
}

test('flush waits for an active timer write even when no records remain pending', async (t) => {
    const started = deferred();
    const release = deferred();
    const { manager, writes } = createHistory(t, async () => {
        started.resolve();
        await release.promise;
    });
    await manager.scheduleSave([record('first')], 7);
    t.mock.timers.tick(15_000);
    await started.promise;

    let flushed = false;
    const flushing = manager.flush().then(() => { flushed = true; });
    await setImmediate();
    assert.equal(flushed, false);
    release.resolve();
    await flushing;
    assert.deepEqual(writes, [[record('first')]]);
});

test('flush persists the latest records after waiting for an active write', async (t) => {
    const started = deferred();
    const release = deferred();
    let writeCount = 0;
    const { manager, writes } = createHistory(t, async () => {
        if (++writeCount === 1) {
            started.resolve();
            await release.promise;
        }
    });
    const firstFlush = manager.flush([record('first')], 7);
    await started.promise;
    const nextFlush = manager.flush([record('second')], 7);
    await manager.scheduleSave([record('latest')], 7);
    release.resolve();
    await Promise.all([firstFlush, nextFlush]);

    assert.deepEqual(writes, [[record('first')], [record('latest')]]);
    t.mock.timers.tick(15_000);
    await setImmediate();
    assert.equal(writes.length, 2);
});

for (const update of ['none', 'replacement', 'empty'] as const) {
    test(`failed flush retains ${update === 'none' ? 'its records' : update + ' updates'} for retry`, async (t) => {
        const started = deferred();
        const release = deferred();
        let writeCount = 0;
        const { manager, writes } = createHistory(t, async () => {
            if (++writeCount === 1) {
                started.resolve();
                await release.promise;
                throw new Error('disk unavailable');
            }
        });
        const firstFlush = assert.rejects(manager.flush([record('first')], 7), /disk unavailable/);
        await started.promise;
        const latest = update === 'empty' ? [] : [record(update === 'none' ? 'first' : 'latest')];
        if (update !== 'none') await manager.scheduleSave(latest, 7);
        release.resolve();
        await firstFlush;
        await manager.flush();
        assert.deepEqual(writes, [latest]);
    });
}

test('timer write failures are logged and retain pending records for retry', async (t) => {
    let writeCount = 0;
    const { manager, writes } = createHistory(t, async () => {
        if (++writeCount === 1) throw new Error('disk unavailable');
    });
    const errors = t.mock.method(console, 'error', () => {});
    await manager.scheduleSave([record('first')], 7);
    t.mock.timers.tick(15_000);
    await setImmediate();

    assert.equal(errors.mock.callCount(), 1);
    await manager.flush();
    assert.deepEqual(writes, [[record('first')]]);
});
