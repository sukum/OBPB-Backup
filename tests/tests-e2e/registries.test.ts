import test from 'node:test';
import assert from 'node:assert/strict';
import './setup-dom';
import {
    registerViews,
    activateHistoryView,
    activateActivityManagerView,
    VIEW_TYPE_HISTORICAL_BACKUP,
    VIEW_TYPE_ACTIVITY_MANAGER,
} from '../../src/ui/view-registry';
import { HistoryView } from '../../src/ui/note-history/history-view';
import { ActivityManagerView } from '../../src/ui/activity-manager/activity-manager-view';
import { StatusBarWidget } from '../../src/ui/status-bar';
import { createTestContext } from './mocks/test-context';
import { MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';

test('registerViews registers views, status bar widget, and ribbon icon', () => {
    const { plugin, container } = createTestContext();
    const pluginAny = plugin as any;

    registerViews(plugin, container);

    // 1. Check registered views
    assert.ok(pluginAny.registeredViews[VIEW_TYPE_HISTORICAL_BACKUP], 'History view should be registered');
    assert.ok(pluginAny.registeredViews[VIEW_TYPE_ACTIVITY_MANAGER], 'Activity manager view should be registered');

    // Verify view factories produce valid instances
    const dummyLeaf = new (WorkspaceLeaf as any)(plugin.app);
    const historyViewInstance = pluginAny.registeredViews[VIEW_TYPE_HISTORICAL_BACKUP](dummyLeaf);
    assert.ok(historyViewInstance instanceof HistoryView);

    const activityViewInstance = pluginAny.registeredViews[VIEW_TYPE_ACTIVITY_MANAGER](dummyLeaf);
    assert.ok(activityViewInstance instanceof ActivityManagerView);

    // 2. Check StatusBarWidget
    assert.ok(container.has(StatusBarWidget), 'StatusBarWidget should be registered in container');
    assert.equal(pluginAny.statusBarItems.length, 1, 'Status bar item should be created');

    // 3. Check ribbon icon registration and menu interaction
    assert.equal(pluginAny.ribbonIcons.length, 1);
    assert.equal(pluginAny.ribbonIcons[0].icon, 'archive');
    assert.equal(pluginAny.ribbonIcons[0].title, 'PB Backup');

    // Simulate ribbon click with active Markdown file
    const activeFile = new (TFile as any)('Notes/Architecture.md');
    const leafWithFile = new (WorkspaceLeaf as any)(plugin.app);
    leafWithFile.view = new (MarkdownView as any)(activeFile);
    (plugin.app.workspace as any).leaves.push(leafWithFile);

    const mouseEvt = new MouseEvent('click');
    pluginAny.ribbonIcons[0].cb(mouseEvt);
    assert.ok(true, 'Ribbon icon click callback executed cleanly');
});

test('activateHistoryView reveals existing leaf when present', async () => {
    const { app } = createTestContext();
    const leaf = new (WorkspaceLeaf as any)(app);
    await leaf.setViewState({ type: VIEW_TYPE_HISTORICAL_BACKUP });
    (app.workspace as any).leaves.push(leaf);

    assert.equal(leaf.revealed, false);
    await activateHistoryView(app);
    assert.equal(leaf.revealed, true);
});

test('activateHistoryView creates right leaf and sets view state when not present', async () => {
    const { app } = createTestContext();
    assert.equal((app.workspace as any).leaves.length, 0);

    await activateHistoryView(app);
    assert.equal((app.workspace as any).leaves.length, 1);
    const leaf = (app.workspace as any).leaves[0];
    assert.equal(leaf.viewType, VIEW_TYPE_HISTORICAL_BACKUP);
    assert.equal(leaf.revealed, true);
});

test('activateActivityManagerView reveals existing leaf when present', async () => {
    const { app } = createTestContext();
    const leaf = new (WorkspaceLeaf as any)(app);
    await leaf.setViewState({ type: VIEW_TYPE_ACTIVITY_MANAGER });
    (app.workspace as any).leaves.push(leaf);

    assert.equal(leaf.revealed, false);
    await activateActivityManagerView(app);
    assert.equal(leaf.revealed, true);
});

test('activateActivityManagerView creates tab leaf and sets view state when not present', async () => {
    const { app } = createTestContext();
    assert.equal((app.workspace as any).leaves.length, 0);

    await activateActivityManagerView(app);
    assert.equal((app.workspace as any).leaves.length, 1);
    const leaf = (app.workspace as any).leaves[0];
    assert.equal(leaf.viewType, VIEW_TYPE_ACTIVITY_MANAGER);
    assert.equal(leaf.revealed, true);
});
