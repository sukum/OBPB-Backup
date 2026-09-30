import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '../src/container';
import { runOnLayoutReady, teardownContainer } from '../src/bootstrap';
import { DeviceManager } from '../src/state/device-manager';
import { AuthManager } from '../src/remote/auth-manager';
import { ActivityTracker } from '../src/state/activity-tracker';
import { FailedTasksManager } from '../src/state/failed-tasks-manager';
import { BatchFailureReportManager } from '../src/state/batch-failure-report-manager';
import { AutomaticQueueManager } from '../src/queue/automatic-queue-manager';
import { OperationsManager } from '../src/operations/operations-manager';
import { DebounceController } from '../src/vault/debounce-controller';
import { ActivityHistoryManager } from '../src/state/activity-history-manager';
import { StatusBarWidget } from '../src/ui/status-bar';
import type OBPBBackupPlugin from '../src/main';

function createContainer(services: Array<[any, any]>): Container {
    const container = new Container();
    for (const [token, service] of services) {
        container.registerInstance(token, service);
    }
    return container;
}

function interceptTimeouts(t: any): Array<() => unknown> {
    const callbacks: Array<() => unknown> = [];
    t.mock.method(globalThis, 'setTimeout', ((callback: () => unknown) => {
        callbacks.push(callback);
        return 1;
    }) as any);
    return callbacks;
}

function makeStartupServices(order: string[]) {
    const deviceManager = {
        initialize: async (fallbackVaultId?: string) => { order.push(`device:${fallbackVaultId}`); },
        getVaultId: () => 'persisted-vault',
    };
    const authManager = { loadStoredAuth: async () => { order.push('auth'); } };
    const activityTracker = { initialize: async () => { order.push('activity'); } };
    const failedTasksManager = { initialize: async () => { order.push('failed-tasks'); } };
    const batchFailureReportManager = { clearPreviousSessionReports: async () => { order.push('clear-reports'); } };
    const automaticQueueManager = {
        pause: async (reason: string) => { order.push(`pause:${reason}`); },
        initialize: async () => { order.push('queue-initialize'); },
        resume: async (reason: string) => { order.push(`resume:${reason}`); },
    };
    const operationsManager = { runStartupRecovery: async () => { order.push('recovery'); } };
    return {
        services: [
            [DeviceManager, deviceManager],
            [AuthManager, authManager],
            [ActivityTracker, activityTracker],
            [FailedTasksManager, failedTasksManager],
            [BatchFailureReportManager, batchFailureReportManager],
            [AutomaticQueueManager, automaticQueueManager],
            [OperationsManager, operationsManager],
        ] as Array<[any, any]>,
        failedTasksManager,
        batchFailureReportManager,
        automaticQueueManager,
    };
}

test('runOnLayoutReady initializes services in order and schedules delayed startup work', async (t) => {
    const order: string[] = [];
    const callbacks = interceptTimeouts(t);
    const startup = makeStartupServices(order);
    let settingsSaved = 0;
    const plugin = {
        settings: { vaultId: 'seed-vault' },
        saveSettings: async () => { settingsSaved++; order.push('save-settings'); },
        shutdownController: {
            signal: { 
                aborted: false,
                addEventListener: () => {},
                removeEventListener: () => {},
            },
        },
    } as unknown as OBPBBackupPlugin;
    const container = createContainer(startup.services);

    await runOnLayoutReady(plugin, container);

    assert.deepEqual(order, [
        'device:seed-vault',
        'auth',
        'activity',
        'pause:boot',
        'queue-initialize',
        'recovery',
    ]);
    assert.equal(plugin.settings.vaultId, 'persisted-vault');
    assert.equal(callbacks.length, 4);

    for (const callback of callbacks) {
        await callback();
    }

    assert.equal(settingsSaved, 1);
    assert.deepEqual(order.slice(-4), ['save-settings', 'failed-tasks', 'clear-reports', 'resume:boot']);
});

test('runOnLayoutReady skips settings persistence for a matching vault and contains delayed failures', async (t) => {
    const order: string[] = [];
    const callbacks = interceptTimeouts(t);
    const startup = makeStartupServices(order);
    startup.failedTasksManager.initialize = async () => { throw new Error('failed manager'); };
    startup.batchFailureReportManager.clearPreviousSessionReports = async () => { throw new Error('failed cleanup'); };
    startup.automaticQueueManager.resume = async (reason: string) => { order.push(`resume:${reason}`); };
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    let settingsSaved = 0;
    const plugin = {
        settings: { vaultId: 'persisted-vault' },
        saveSettings: async () => { settingsSaved++; },
        shutdownController: {
            signal: { 
                aborted: false,
                addEventListener: () => {},
                removeEventListener: () => {},
            },
        },
    } as unknown as OBPBBackupPlugin;

    await runOnLayoutReady(plugin, createContainer(startup.services));
    assert.equal(callbacks.length, 3);
    assert.equal(settingsSaved, 0);

    for (const callback of callbacks) {
        await assert.doesNotReject(Promise.resolve(callback()));
    }

    assert.equal(errors.length, 2);
    assert.ok(order.includes('resume:boot'));
});

test('teardownContainer handles an empty container and tears down registered services in order', async () => {
    await teardownContainer(new Container());

    const order: string[] = [];
    const container = createContainer([
        [OperationsManager, { requestShutdown: async () => { order.push('stop'); } }],
        [DebounceController, { close: async () => { order.push('debounce'); } }],
        [AutomaticQueueManager, { shutdown: () => { order.push('queue'); } }],
        [ActivityHistoryManager, { flush: async () => { order.push('activity-history'); } }],
        [FailedTasksManager, { flush: async () => { order.push('failed-tasks'); } }],
        [StatusBarWidget, { destroy: () => { order.push('status-bar'); } }],
    ]);

    await teardownContainer(container);

    assert.deepEqual(order, ['stop', 'debounce', 'queue', 'activity-history', 'failed-tasks', 'status-bar']);
});
