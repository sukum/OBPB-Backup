import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe("Vault Event Registry Tests", () => {
test('registerEvents registers vault, workspace, and window listeners via Obsidian Plugin lifecycle', async () => {
    const { registerEvents } = await import('../src/vault/event-registry');
    const { OperationsManager } = await import('../src/operations/operations-manager');
    const { DebounceController } = await import('../src/vault/debounce-controller');

    const vaultListeners: any[] = [];
    const workspaceListeners: any[] = [];
    const registeredEvents: any[] = [];
    const registeredDomEvents: { target: any; type: string; listener: any }[] = [];

    const mockVault = {
        on: (event: string, callback: any) => {
            const ref = { event, callback };
            vaultListeners.push(ref);
            return ref;
        },
    };

    const mockWorkspace = {
        on: (event: string, callback: any) => {
            const ref = { event, callback };
            workspaceListeners.push(ref);
            return ref;
        },
    };

    const originalWindow = (global as any).window;
    (global as any).window = {};

    try {
        const mockApp: any = { vault: mockVault, workspace: mockWorkspace };
        let flushed = false;
        const mockDebounce: any = {
            flushAll: async () => {
                flushed = true;
            },
            handleModified: async () => {},
        };

        const mockPlugin: any = {
            app: mockApp,
            settings: { monitoredExtensions: ['md'] },
            registerEvent: (ref: any) => {
                registeredEvents.push(ref);
            },
            registerDomEvent: (target: any, type: string, listener: any) => {
                registeredDomEvents.push({ target, type, listener });
            },
        };

        const mockContainer: any = {
            resolve: (token: any) => {
                if (token === OperationsManager) return {} as any;
                if (token === DebounceController) return mockDebounce;
                return {} as any;
            },
        };

        registerEvents(mockPlugin, mockContainer);

        // 3 vault listeners: modify, rename, delete
        assert.equal(vaultListeners.length, 3);
        // 1 workspace listener: active-leaf-change
        assert.equal(workspaceListeners.length, 1);
        // Total plugin.registerEvent calls = 3 vault + 1 workspace = 4
        assert.equal(registeredEvents.length, 4);

        // 1 dom event: beforeunload
        assert.equal(registeredDomEvents.length, 1);
        assert.equal(registeredDomEvents[0].type, 'beforeunload');

        // Test that window beforeunload flushes debounce
        registeredDomEvents[0].listener();
        assert.equal(flushed, true);
    } finally {
        (global as any).window = originalWindow;
    }
});

test('registerEvents handleFolderRename recursively traverses TFolder hierarchy and dispatches rename tasks', async () => {
    const { registerEvents } = await import('../src/vault/event-registry');
    const { OperationsManager } = await import('../src/operations/operations-manager');
    const { DebounceController } = await import('../src/vault/debounce-controller');
    const { TaskFactory } = await import('../src/tasks/task-factory');
    const { TFile, TFolder } = await import('obsidian');

    const vaultListeners: Map<string, Function> = new Map();
    const mockVault = {
        on: (event: string, callback: any) => {
            vaultListeners.set(event, callback);
            return { event, callback };
        },
    };
    const mockApp: any = {
        vault: mockVault,
        workspace: { on: () => ({}) },
    };
    const mockPlugin: any = {
        app: mockApp,
        settings: { monitoredExtensions: ['md'] },
        registerEvent: () => {},
        registerDomEvent: () => {},
    };

    const renamedFiles: Array<{ file: any; oldPath: string }> = [];
    const mockOperations: any = {
        handleFileRename: async (file: any, oldPath: string) => {
            renamedFiles.push({ file, oldPath });
        },
    };
    const taskFactory = new TaskFactory();

    const mockContainer: any = {
        resolve: (token: any) => {
            if (token === OperationsManager) return mockOperations;
            if (token === DebounceController) return {} as any;
            if (token === TaskFactory) return taskFactory;
            return {} as any;
        },
    };

    registerEvents(mockPlugin, mockContainer);

    const renameHandler = vaultListeners.get('rename');
    assert.ok(renameHandler, 'Rename handler should be registered');

    // Build nested folder structure:
    // folder "Docs" (renamed from "OldDocs")
    //  - file1: "Docs/readme.md"
    //  - subFolder: "Docs/Guides"
    //      - file2: "Docs/Guides/getting-started.md"
    const rootFolder = new TFolder();
    rootFolder.path = 'Docs';
    rootFolder.name = 'Docs';

    const file1 = new TFile();
    file1.path = 'Docs/readme.md';
    file1.name = 'readme.md';

    const subFolder = new TFolder();
    subFolder.path = 'Docs/Guides';
    subFolder.name = 'Guides';

    const file2 = new TFile();
    file2.path = 'Docs/Guides/getting-started.md';
    file2.name = 'getting-started.md';

    subFolder.children = [file2];
    rootFolder.children = [file1, subFolder];

    // Trigger rename of folder from 'OldDocs' to 'Docs'
    await renameHandler!(rootFolder, 'OldDocs');

    assert.equal(renamedFiles.length, 2);
    assert.equal(renamedFiles[0].file.path, 'Docs/readme.md');
    assert.equal(renamedFiles[0].oldPath, 'OldDocs/readme.md');

    assert.equal(renamedFiles[1].file.path, 'Docs/Guides/getting-started.md');
    assert.equal(renamedFiles[1].oldPath, 'OldDocs/Guides/getting-started.md');
});
});

describe("Debounce Controller Tests", () => {
test('DebounceController.flushAll flushes all pending timers immediately and updateSettings updates intervals', async () => {
    const { DebounceController } = await import('../src/vault/debounce-controller');
    const { DirtyFileManager } = await import('../src/state/dirty-file-manager');
    const { TaskFactory } = await import('../src/tasks/task-factory');

    const executedTasks: any[] = [];
    const loggedEntries: any[] = [];
    const mockLogger: any = {
        record: (entry: any) => {
            loggedEntries.push(entry);
        },
    };

    const mockStorage: any = {
        read: async () => '',
        write: async () => {},
        exists: async () => true,
        mkdir: async () => {},
        append: async () => {},
    };
    const dirtyManager = new DirtyFileManager(mockStorage);
    const taskFactory = new TaskFactory();

    const controller = new DebounceController(
        dirtyManager,
        50000,
        300000,
        async (task) => {
            executedTasks.push(task);
        },
        mockLogger
    );

    // Test updateSettings
    controller.updateSettings(10000, 60000);
    assert.equal((controller as any).debounceIntervalMs, 10000);
    assert.equal((controller as any).maxWaitMs, 60000);
    const { TFile } = await import('obsidian');
    const file1 = new TFile();
    file1.path = 'Doc1.md';
    const file2 = new TFile();
    file2.path = 'Doc2.md';

    const task1 = taskFactory.createSaveTask(file1);
    const task2 = taskFactory.createSaveTask(file2);

    await controller.schedule(task1);
    await controller.schedule(task2);

    assert.equal((controller as any).activeTimers.size, 2);
    assert.equal(executedTasks.length, 0);

    // Call flushAll
    await controller.flushAll();

    assert.equal((controller as any).activeTimers.size, 0);
    assert.equal(executedTasks.length, 2);
    assert.equal(executedTasks[0].path, 'Doc1.md');
    assert.equal(executedTasks[1].path, 'Doc2.md');

    // Verify logger captured completed/flushed
    const flushedLogs = loggedEntries.filter(e => e.status === 'completed' && e.note === 'Flushed');
    assert.equal(flushedLogs.length, 2);
});
});
