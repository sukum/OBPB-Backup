import test from 'node:test';
import assert from 'node:assert/strict';
import './setup-dom';
import { HistoryView } from '../../src/ui/note-history/history-view';
import { HistoryModal } from '../../src/ui/note-history/history-modal';
import { DiffViewer } from '../../src/ui/components/diff-viewer';
import { createTestContext } from './mocks/test-context';
import { TFile, WorkspaceLeaf } from 'obsidian';
import { FileHistorySummary } from '../../src/types/database';
import { Hasher } from '../../src/hashing/hasher';
import { RestoreResult, RestoreVersionOptions } from '../../src/reconstruct/types';

test('DiffViewer.renderDiff generates expected DOM structure and prefixes', () => {
    const container = document.createElement('div');

    const oldText = 'Line 1\nLine 2\nLine 3';
    const newText = 'Line 1\nLine 2 Modified\nLine 3\nLine 4 Added';

    DiffViewer.renderDiff(container, oldText, newText);

    assert.ok(container.classList.contains('obpb_diff_container'));
    const pre = container.querySelector('pre.obpb_diff_pre');
    assert.ok(pre);

    const addedLines = container.querySelectorAll('.obpb_diff_added');
    const removedLines = container.querySelectorAll('.obpb_diff_removed');
    const unchangedLines = container.querySelectorAll('.obpb_diff_unchanged');

    assert.ok(addedLines.length >= 1, 'Should contain added lines');
    assert.ok(removedLines.length >= 1, 'Should contain removed lines');
    assert.ok(unchangedLines.length >= 1, 'Should contain unchanged lines');

    // Verify prefix formatting
    const addedPrefix = addedLines[0].querySelector('.obpb_diff_prefix')?.textContent;
    assert.equal(addedPrefix, '+ ');

    const removedPrefix = removedLines[0].querySelector('.obpb_diff_prefix')?.textContent;
    assert.equal(removedPrefix, '- ');

    const unchangedPrefix = unchangedLines[0].querySelector('.obpb_diff_prefix')?.textContent;
    assert.equal(unchangedPrefix, '  ');
});

test('HistoryView renders loading, history list, item selection, refresh, and error states', async () => {
    const { plugin, mocks } = createTestContext();
    const leaf = new (WorkspaceLeaf as any)(plugin.app);

    let selectedVersion: FileHistorySummary | null = null;
    const historyView = new HistoryView(
        leaf,
        () => plugin.settings.vaultId,
        mocks.pocketBaseStore,
        (item) => { selectedVersion = item; }
    );

    assert.equal(historyView.getViewType(), 'historical-backup-view');
    assert.equal(historyView.getDisplayText(), 'Note History');
    assert.equal(historyView.getIcon(), 'history');

    // 1. Initial onOpen with no active file
    (plugin.app.workspace as any).activeFile = null;
    await historyView.onOpen();
    assert.ok(historyView.containerEl.querySelector('.obpb_empty')?.textContent?.includes('No active note selected.'));

    // 2. Open file and load version history
    const mockFileRecord: FileHistorySummary = {
        id: 'hist-1',
        vault: 'test-vault-id',
        hash: 'abcdef1234567890',
        path: 'Projects/Roadmap.md',
        operation: 'save',
        timestamp: Date.now() - 60000,
        type: 'snapshot',
        size: 2048,
        device: 'dev-laptop-01',
    };

    mocks.pocketBaseStore.getHistory = async () => [mockFileRecord];

    await historyView.updateForFile('Projects/Roadmap.md');

    // Check header
    const header = historyView.containerEl.querySelector('.obpb_history_header h4');
    assert.equal(header?.textContent, 'Roadmap.md');

    // Check version item rendering
    const itemEl = historyView.containerEl.querySelector('.obpb_history_item') as HTMLElement;
    assert.ok(itemEl);
    assert.ok(
        itemEl.querySelector(
            '.obpb_version_hash'
        )?.textContent?.includes(
            Hasher.hashStub8(mockFileRecord.hash) // after first 8 chars
        )
    );
    assert.ok(itemEl.querySelector('.obpb_badge_snapshot'));
    assert.ok(itemEl.querySelector('.obpb_version_size')?.textContent?.includes('2.0 KB'));

    // Click version item
    itemEl.click();
    assert.strictEqual(selectedVersion, mockFileRecord);

    // Click refresh button
    let refreshQueried = false;
    mocks.pocketBaseStore.getHistory = async () => {
        refreshQueried = true;
        return [mockFileRecord];
    };
    const refreshBtn = historyView.containerEl.querySelector('.obpb_history_header button') as HTMLButtonElement;
    assert.ok(refreshBtn);
    refreshBtn.click();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(refreshQueried, true);

    // 3. Empty history state
    mocks.pocketBaseStore.getHistory = async () => [];
    await historyView.updateForFile('Projects/Roadmap.md');
    assert.ok(historyView.containerEl.querySelector('.obpb_empty')?.textContent?.includes('No backups recorded yet'));

    // 4. Error state
    mocks.pocketBaseStore.getHistory = async () => {
        throw new Error('Connection refused');
    };
    await historyView.updateForFile('Projects/Roadmap.md');
    assert.ok(historyView.containerEl.querySelector('.obpb_empty')?.textContent?.includes('Failed to load history: Connection refused'));
});

test('HistoryModal reconstructs historical version, shows diff, and executes restore flow', async () => {
    const { plugin, mocks } = createTestContext();

    const fileRecord: FileHistorySummary = {
        id: 'hist-modal-test',
        vault: 'test-vault-id',
        hash: 'hash998877665544',
        path: 'Research.md',
        operation: 'save',
        timestamp: Date.now() - 120000,
        type: 'diff',
        size: 512,
        device: 'dev-desktop-01',
    };

    const activeFile = new (TFile as any)('Research.md');
    plugin.app.vault.getAbstractFileByPath = (path: string) => activeFile;
    plugin.app.vault.cachedRead = async () => 'Current note content line 1\nCurrent note line 2';

    mocks.operationsManager.reconstructVersion = async () => 'Current note content line 1\nHistorical modified line 2';

    let restoredVault = '';
    let restoredPath = '';
    let restoredHash = '';
    mocks.operationsManager.restoreVersion = async (
        v: string, p: string, h: string, options: RestoreVersionOptions
    ): Promise<RestoreResult> => {
        restoredVault = v;
        restoredPath = p;
        restoredHash = h;
        return { status: 'modified', path: p };
    };

    const context = {
        getVaultId: () => plugin.settings.vaultId,
        operationsManager: mocks.operationsManager,
    };

    const modal = new HistoryModal(plugin.app, context, fileRecord);
    await modal.onOpen();

    // Verify modal metadata
    assert.ok(modal.contentEl.querySelector('h2')?.textContent?.includes('Research.md'));
    assert.ok(modal.contentEl.querySelector('.obpb_diff_container'), 'Should render diff container');

    // Since currentContent !== historicalContent, restore button should be present
    const restoreBtn = Array.from(modal.contentEl.querySelectorAll('button')).find(b => b.textContent?.includes('Restore to Note'));
    assert.ok(restoreBtn, 'Restore to Note button should exist when content differs');

    // Click restore
    let modalClosed = false;
    modal.close = () => { modalClosed = true; };
    await (restoreBtn as HTMLButtonElement).click();

    assert.equal(restoredVault, 'test-vault-id');
    assert.equal(restoredPath, 'Research.md');
    assert.equal(restoredHash, 'hash998877665544');
    assert.equal(modalClosed, true);

    modal.onClose();
    assert.equal(modal.contentEl.children.length, 0);
});

test('HistoryModal handles identical content (no restore button) and reconstruction failure', async () => {
    const { plugin, mocks } = createTestContext();

    const fileRecord: FileHistorySummary = {
        id: 'hist-identical',
        vault: 'test-vault-id',
        hash: 'hashidentical',
        path: 'Identical.md',
        operation: 'save',
        timestamp: Date.now(),
        type: 'snapshot',
        size: 100,
        device: 'dev-01',
    };

    const activeFile = new (TFile as any)('Identical.md');
    plugin.app.vault.getAbstractFileByPath = () => activeFile;
    plugin.app.vault.cachedRead = async () => 'Exact same content';
    mocks.operationsManager.reconstructVersion = async () => 'Exact same content';

    const context = {
        getVaultId: () => plugin.settings.vaultId,
        operationsManager: mocks.operationsManager,
    };

    // 1. Identical content test
    const modal = new HistoryModal(plugin.app, context, fileRecord);
    await modal.onOpen();

    const restoreBtn = Array.from(modal.contentEl.querySelectorAll('button')).find(b => b.textContent?.includes('Restore to Note'));
    assert.equal(restoreBtn, undefined, 'Restore to Note button should not exist when content is identical');
    assert.ok(modal.contentEl.textContent?.includes('Current version'));

    // 2. Reconstruction error test
    mocks.operationsManager.reconstructVersion = async () => {
        throw new Error('Corrupted patch sequence');
    };

    const errorModal = new HistoryModal(plugin.app, context, fileRecord);
    await errorModal.onOpen();

    assert.ok(errorModal.contentEl.querySelector('.obpb_error')?.textContent?.includes('Error reconstructing version: Corrupted patch sequence'));
});
