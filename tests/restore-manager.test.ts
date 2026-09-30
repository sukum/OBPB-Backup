import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RestoreManager } from '../src/reconstruct/restore-manager';
import { Hasher } from '../src/hashing/hasher';
import { TFile } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/types/settings';

function createMockFile(path: string): TFile {
    const file = new TFile();
    file.path = path;
    file.name = path.split('/').pop() || path;
    return file;
}

function createIntent(path: string) {
    return {
        id: `task-${path}`,
        trigger: "manual",
        event: "",
        operation: 'save',
        path: path,
        policy: "default",
    } as any;
}

describe('RestoreManager tests', () => {
    test('RestoreManager.restoreVersion modifies existing file and triggers safety backup when enabled', async () => {
        const targetFile = createMockFile('notes/test.md');
        let modifiedFile: any = null;
        let modifiedContent = '';
        let safetyBackupFile: TFile | null = null;

        const mockVault: any = {
            getAbstractFileByPath: (p: string) => (p === 'notes/test.md' ? targetFile : null),
            read: async () => '# Old Content',
            modify: async (file: any, content: string) => {
                modifiedFile = file;
                modifiedContent = content;
            },
        };

        const mockReconstructionEngine: any = {
            reconstructVersion: async (vaultId: string, path: string, hash: string) => {
                assert.equal(vaultId, 'vault-1');
                assert.equal(path, 'notes/test.md');
                assert.equal(hash, 'hash-123');
                return '# Reconstructed Content';
            },
        };

        const settings = { ...DEFAULT_SETTINGS, safetyBackupBeforeRestore: true };
        const manager = new RestoreManager(mockVault, mockReconstructionEngine, () => settings, async (file) => {
            safetyBackupFile = file;
            return { status: 'uploaded', intent: createIntent('notes/test.md') };
        });

        const result = await manager.restoreVersion('vault-1', 'notes/test.md', 'hash-123');

        assert.deepEqual(result, { status: 'modified', path: 'notes/test.md' });
        assert.equal(safetyBackupFile, targetFile);
        assert.equal(modifiedFile, targetFile);
        assert.equal(modifiedContent, '# Reconstructed Content');
    });

    test('RestoreManager.restoreVersion does not trigger safety backup when disabled in settings', async () => {
        const targetFile = createMockFile('notes/test.md');
        let modifiedContent = '';
        let safetyBackupCalled = false;

        const mockVault: any = {
            getAbstractFileByPath: (p: string) => (p === 'notes/test.md' ? targetFile : null),
            read: async () => '# Old Content',
            modify: async (_file: any, content: string) => {
                modifiedContent = content;
            },
        };

        const mockReconstructionEngine: any = {
            reconstructVersion: async () => '# Reconstructed Content Without Safety',
        };

        const settings = { ...DEFAULT_SETTINGS, safetyBackupBeforeRestore: false };
        const manager = new RestoreManager(mockVault, mockReconstructionEngine, () => settings, async () => {
            safetyBackupCalled = true;
            return { status: 'uploaded', intent: createIntent('notes/test.md') };
        });

        const result = await manager.restoreVersion('vault-1', 'notes/test.md', 'hash-123');

        assert.deepEqual(result, { status: 'modified', path: 'notes/test.md' });
        assert.equal(safetyBackupCalled, false);
        assert.equal(modifiedContent, '# Reconstructed Content Without Safety');
    });

    test('RestoreManager.restoreVersion takeSafetyBackup override wins over the setting', async () => {
        const targetFile = createMockFile('notes/test.md');

        const mockVault: any = {
            getAbstractFileByPath: (p: string) => (p === 'notes/test.md' ? targetFile : null),
            read: async () => '# Old Content',
            modify: async () => {},
        };

        const mockReconstructionEngine: any = {
            reconstructVersion: async () => '# Reconstructed Content',
        };

        let backupCallsWhenDisabled = 0;
        const disabledSettings = { ...DEFAULT_SETTINGS, safetyBackupBeforeRestore: false };
        const managerWithDisabledSetting = new RestoreManager(mockVault, mockReconstructionEngine, () => disabledSettings, async () => {
            backupCallsWhenDisabled++;
            return { status: 'uploaded', intent: createIntent('notes/test.md') };
        });

        // Explicit override forces a backup even though the setting is off
        await managerWithDisabledSetting.restoreVersion('vault-1', 'notes/test.md', 'hash-123', { takeSafetyBackup: true });
        assert.equal(backupCallsWhenDisabled, 1);

        let backupCallsWhenEnabled = 0;
        const enabledSettings = { ...DEFAULT_SETTINGS, safetyBackupBeforeRestore: true };
        const managerWithEnabledSetting = new RestoreManager(mockVault, mockReconstructionEngine, () => enabledSettings, async () => {
            backupCallsWhenEnabled++;
            return { status: 'uploaded', intent: createIntent('notes/test.md') };
        });

        // Explicit override skips the backup even though the setting is on
        await managerWithEnabledSetting.restoreVersion('vault-1', 'notes/test.md', 'hash-123', { takeSafetyBackup: false });
        assert.equal(backupCallsWhenEnabled, 0);
    });

    test('RestoreManager.restoreVersion skips restore and returns unchanged when content is already identical', async () => {
        const targetFile = createMockFile('notes/test.md');
        let safetyBackupCalled = false;
        let modifyCalled = false;

        const mockVault: any = {
            getAbstractFileByPath: (p: string) => (p === 'notes/test.md' ? targetFile : null),
            read: async () => '# Identical Content\n',
            modify: async () => {
                modifyCalled = true;
            },
        };

        const mockReconstructionEngine: any = {
            reconstructVersion: async () => '# Identical Content\n',
        };

        const settings = { ...DEFAULT_SETTINGS, safetyBackupBeforeRestore: true };
        const manager = new RestoreManager(mockVault, mockReconstructionEngine, () => settings, async () => {
            safetyBackupCalled = true;
            return { status: 'uploaded', intent: createIntent('notes/test.md') };
        });

        const notices: string[] = [];
        const result = await manager.restoreVersion('vault-1', 'notes/test.md', 'hash-ident', {
            notify: (msg) => notices.push(msg),
        });

        assert.deepEqual(result, { status: 'unchanged', path: 'notes/test.md' });
        assert.equal(safetyBackupCalled, false, 'must not run safety backup when content is identical');
        assert.equal(modifyCalled, false, 'must not modify file when content is identical');
        assert.ok(notices.some((n) => n.includes('No change')));
    });

    test('RestoreManager.restoreVersion aborts and throws when safety backup returns null (batch in progress)', async () => {
        const targetFile = createMockFile('notes/test.md');
        let modifyCalled = false;

        const mockVault: any = {
            getAbstractFileByPath: (p: string) => (p === 'notes/test.md' ? targetFile : null),
            read: async () => '# Old Content',
            modify: async () => {
                modifyCalled = true;
            },
        };

        const mockReconstructionEngine: any = {
            reconstructVersion: async () => '# New Version',
        };

        const settings = { ...DEFAULT_SETTINGS, safetyBackupBeforeRestore: true };
        const manager = new RestoreManager(mockVault, mockReconstructionEngine, () => settings, async () => {
            return null; // Signals vault batch is active
        });

        await assert.rejects(
            async () => {
                await manager.restoreVersion('vault-1', 'notes/test.md', 'hash-new');
            },
            {
                name: 'Error',
                message: /Cannot safely restore notes\/test\.md: a vault backup or sync operation is currently active\./,
            }
        );

        assert.equal(modifyCalled, false, 'file must not be modified when safety backup cannot proceed');
    });

    test('RestoreManager.restoreVersion fast-paths when knownContent matches targetHash', async () => {
        const targetFile = createMockFile('notes/test.md');
        let modifiedContent = '';
        let reconstructCalls = 0;

        const content = '# Verified Fast Path Content';
        const validHash = await Hasher.computeHash(content);

        const mockVault: any = {
            getAbstractFileByPath: (p: string) => (p === 'notes/test.md' ? targetFile : null),
            read: async () => '# Old Content',
            modify: async (_file: any, text: string) => {
                modifiedContent = text;
            },
        };

        const mockReconstructionEngine: any = {
            reconstructVersion: async () => {
                reconstructCalls++;
                return '# Engine Content';
            },
        };

        const settings = { ...DEFAULT_SETTINGS, safetyBackupBeforeRestore: false };
        const manager = new RestoreManager(mockVault, mockReconstructionEngine, () => settings, async () => null);

        const result = await manager.restoreVersion('vault-1', 'notes/test.md', validHash, {
            knownContent: content,
        });

        assert.deepEqual(result, { status: 'modified', path: 'notes/test.md' });
        assert.equal(reconstructCalls, 0, 'reconstructionEngine must be bypassed on valid knownContent');
        assert.equal(modifiedContent, content);
    });

    test('RestoreManager.restoreVersion falls back to engine when knownContent does not match targetHash', async () => {
        const targetFile = createMockFile('notes/test.md');
        let modifiedContent = '';
        let reconstructCalls = 0;

        const mockVault: any = {
            getAbstractFileByPath: (p: string) => (p === 'notes/test.md' ? targetFile : null),
            read: async () => '# Old Content',
            modify: async (_file: any, text: string) => {
                modifiedContent = text;
            },
        };

        const mockReconstructionEngine: any = {
            reconstructVersion: async () => {
                reconstructCalls++;
                return '# Engine Content';
            },
        };

        const settings = { ...DEFAULT_SETTINGS, safetyBackupBeforeRestore: false };
        const manager = new RestoreManager(mockVault, mockReconstructionEngine, () => settings, async () => null);

        const result = await manager.restoreVersion('vault-1', 'notes/test.md', 'expected-hash-456', {
            knownContent: '# Mismatched Local Content',
        });

        assert.deepEqual(result, { status: 'modified', path: 'notes/test.md' });
        assert.equal(reconstructCalls, 1, 'must fall back to reconstructionEngine when hash mismatches');
        assert.equal(modifiedContent, '# Engine Content');
    });

    test('RestoreManager.restoreVersion invokes notify callback with progress and completion', async () => {
        const targetFile = createMockFile('notes/test.md');
        const notices: string[] = [];

        const mockVault: any = {
            getAbstractFileByPath: (p: string) => (p === 'notes/test.md' ? targetFile : null),
            read: async () => '# Old Content',
            modify: async () => {},
        };

        const mockReconstructionEngine: any = {
            reconstructVersion: async () => '# Restored',
        };

        const settings = { ...DEFAULT_SETTINGS, safetyBackupBeforeRestore: false };
        const manager = new RestoreManager(mockVault, mockReconstructionEngine, () => settings, async () => null);

        await manager.restoreVersion('vault-1', 'notes/test.md', 'hash-notify', {
            notify: (msg) => notices.push(msg),
        });

        assert.ok(notices.some((n) => n.includes('Reconstructing notes/test.md...')));
        assert.ok(notices.some((n) => n.includes('Successfully restored notes/test.md')));
    });

    test('RestoreManager.restoreVersion creates new file and parent directories recursively for deleted file recovery', async () => {
        let createdPath = '';
        let createdContent = '';
        let safetyBackupCalled = false;
        const createdFolders: string[] = [];
        const existingFolders = new Set<string>();

        const mockVault: any = {
            getAbstractFileByPath: () => null, // File does not exist locally
            create: async (path: string, content: string) => {
                createdPath = path;
                createdContent = content;
            },
            createFolder: async (path: string) => {
                createdFolders.push(path);
                existingFolders.add(path);
            },
            adapter: {
                exists: async (path: string) => existingFolders.has(path),
            },
        };

        const mockReconstructionEngine: any = {
            reconstructVersion: async () => '# Recreated Note',
        };

        const settings = { ...DEFAULT_SETTINGS, safetyBackupBeforeRestore: true };
        const manager = new RestoreManager(mockVault, mockReconstructionEngine, () => settings, async () => {
            safetyBackupCalled = true;
            return { status: 'uploaded', intent: createIntent('notes/test.md') };
        });

        const result = await manager.restoreVersion('vault-1', 'deeply/nested/folder/deleted.md', 'hash-del');

        // No local file exists, so there is nothing to safely back up
        assert.equal(safetyBackupCalled, false);
        assert.deepEqual(createdFolders, ['deeply', 'deeply/nested', 'deeply/nested/folder']);
        assert.equal(createdPath, 'deeply/nested/folder/deleted.md');
        assert.equal(createdContent, '# Recreated Note');
        assert.deepEqual(result, { status: 'created', path: 'deeply/nested/folder/deleted.md' });
    });

    test('RestoreManager.restoreVersion creates root-level deleted file without attempting folder creation', async () => {
        let createdPath = '';
        let createdContent = '';
        let createFolderCalled = false;

        const mockVault: any = {
            getAbstractFileByPath: () => null,
            create: async (path: string, content: string) => {
                createdPath = path;
                createdContent = content;
            },
            createFolder: async () => {
                createFolderCalled = true;
            },
            adapter: {
                exists: async () => true,
            },
        };

        const mockReconstructionEngine: any = {
            reconstructVersion: async () => '# Root Note',
        };

        const settings = { ...DEFAULT_SETTINGS };
        const manager = new RestoreManager(mockVault, mockReconstructionEngine, () => settings, async () => { return { status: 'uploaded', intent: createIntent('notes/test.md') }; });

        const result = await manager.restoreVersion('vault-1', 'root-note.md', 'hash-root');

        assert.equal(createFolderCalled, false);
        assert.equal(createdPath, 'root-note.md');
        assert.equal(createdContent, '# Root Note');
        assert.deepEqual(result, { status: 'created', path: 'root-note.md' });
    });
});
