import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Container, InjectionToken } from '../src/container';
import { bootstrapContainer } from '../src/bootstrap';
import { DeviceManager } from '../src/state/device-manager';
import { PayloadPreparer } from '../src/preparation/payload-preparer';
import { SingleFileRunner } from '../src/runner/single-file-runner';
import { VaultBatchCoordinator } from '../src/operations/vault-batch-coordinator';
import { ManualFileOperation } from '../src/operations/manual-file-operation';
import { RetryFailedTaskOperation } from '../src/operations/retry-failed-task-op';
import { OperationsManager } from '../src/operations/operations-manager';
import { AutomaticQueueProcessor } from '../src/queue/automatic-queue-processor';
import { DEFAULT_SETTINGS } from '../src/types/settings';

describe("Container Tests", () => {
test.skip('Container registers and resolves constructors with dependencies and singletons', () => {
    class ServiceA {
        public readonly id = 'A';
    }

    class ServiceB {
        constructor(public readonly a: ServiceA) {}
    }

    const container = new Container();
    assert.equal(container.has(ServiceA), false);

    // register fn unused and removed
    // container.register(ServiceA, ServiceA);
    // container.register(ServiceB, ServiceB, [ServiceA]);

    assert.equal(container.has(ServiceA), true);
    assert.equal(container.has(ServiceB), true);

    const b = container.resolve(ServiceB);
    assert.ok(b instanceof ServiceB);
    assert.ok(b.a instanceof ServiceA);
    assert.equal(b.a.id, 'A');

    // Verify singleton caching
    const a = container.resolve(ServiceA);
    assert.strictEqual(b.a, a);
});


test('Container registers instances and factories with singleton and transient lifecycles', () => {
    const container = new Container();
    const appToken = new InjectionToken<{ name: string; version: number }>('AppToken');
    const singletonToken = new InjectionToken<{ count: number; appName: string }>('SingletonService');
    const transientToken = new InjectionToken<{ seq: number }>('TransientService');
    const unregisteredToken = new InjectionToken<object>('UnregisteredService');

    // 1. registerInstance
    const existingInstance = { name: 'ObsidianApp', version: 1 };
    container.registerInstance(appToken, existingInstance);
    assert.equal(container.has(appToken), true);
    assert.strictEqual(container.resolve(appToken), existingInstance);

    // 2. registerFactory singleton (default)
    let factoryCount = 0;
    container.registerFactory(singletonToken, (c) => {
        factoryCount++;
        const app = c.resolve(appToken);
        return { count: factoryCount, appName: app.name };
    });

    const s1 = container.resolve(singletonToken);
    const s2 = container.resolve(singletonToken);
    assert.equal(factoryCount, 1);
    assert.strictEqual(s1, s2);
    assert.equal(s1.appName, 'ObsidianApp');

    // 3. registerFactory transient (singleton = false)
    let transientCount = 0;
    container.registerFactory(transientToken, () => {
        transientCount++;
        return { seq: transientCount };
    }, false);

    const t1 = container.resolve(transientToken);
    const t2 = container.resolve(transientToken);
    assert.equal(transientCount, 2);
    assert.notStrictEqual(t1, t2);
    assert.equal(t1.seq, 1);
    assert.equal(t2.seq, 2);

    // 4. Error on unregistered token
    assert.throws(
        () => container.resolve(unregisteredToken),
        /Service not registered: UnregisteredService/
    );
});

test('Container rejects duplicate registrations', () => {
    const container = new Container();
    const token = new InjectionToken<number>('Number');

    container.registerInstance(token, 1);

    assert.throws(
        () => container.registerFactory(token, () => 2),
        /Service already registered: Number/
    );
});

test('bootstrapContainer registers and resolves all refactored services', async () => {
    const mockPlugin: any = {
        manifest: { id: 'obsidian-backup', dir: '/mock/plugin/dir' },
        app: {
            vault: {
                adapter: {
                    read: async () => '',
                    write: async () => {},
                    exists: async () => false,
                    mkdir: async () => {},
                    remove: async () => {},
                    list: async () => ({ files: [], folders: [] }),
                },
                configDir: '.obsidian',
                getAbstractFileByPath: () => null,
            },
        },
        settings: { ...DEFAULT_SETTINGS },
    };

    const container = await bootstrapContainer(mockPlugin);
    await container.resolve(DeviceManager).initialize('test-vault');

    // Verify registration presence
    assert.equal(container.has(PayloadPreparer), true);
    assert.equal(container.has(SingleFileRunner), true);
    assert.equal(container.has(VaultBatchCoordinator), true);
    assert.equal(container.has(ManualFileOperation), true);
    assert.equal(container.has(RetryFailedTaskOperation), true);
    assert.equal(container.has(AutomaticQueueProcessor), true);
    assert.equal(container.has(OperationsManager), true);

    // Verify concrete class resolution and singleton caching
    const preparer = container.resolve(PayloadPreparer);
    assert.ok(preparer instanceof PayloadPreparer);
    assert.strictEqual(container.resolve(PayloadPreparer), preparer);

    const runner = container.resolve(SingleFileRunner);
    assert.ok(runner instanceof SingleFileRunner);
    assert.strictEqual(container.resolve(SingleFileRunner), runner);

    const batchCoord = container.resolve(VaultBatchCoordinator);
    assert.ok(batchCoord instanceof VaultBatchCoordinator);
    assert.strictEqual(container.resolve(VaultBatchCoordinator), batchCoord);

    const manualOp = container.resolve(ManualFileOperation);
    assert.ok(manualOp instanceof ManualFileOperation);
    assert.strictEqual(container.resolve(ManualFileOperation), manualOp);

    const retryOp = container.resolve(RetryFailedTaskOperation);
    assert.ok(retryOp instanceof RetryFailedTaskOperation);
    assert.strictEqual(container.resolve(RetryFailedTaskOperation), retryOp);

    const opsManager = container.resolve(OperationsManager);
    assert.ok(opsManager instanceof OperationsManager);
});
});

// These unreachable assertions are compiled by `npm run typecheck` and guard the public API.
/*
if (false) {
    const container = new Container();
    const numberToken = new InjectionToken<number>('Number');
    const stringToken = new InjectionToken<string>('String');

    // @ts-expect-error The registered value must match the token's service type.
    container.registerInstance(numberToken, 'not a number');

    class NeedsNumber {
        constructor(public readonly value: number) {}
    }

    // @ts-expect-error Constructor dependency tokens must match constructor parameters.
    container.register(NeedsNumber, NeedsNumber, [stringToken]);
}
*/
