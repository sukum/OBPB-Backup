import { TAbstractFile, TFile, TFolder } from 'obsidian';
import { Container } from '../container';
import { OperationsManager } from '../operations/operations-manager';
import { DebounceController } from './debounce-controller';
import { PathUtils } from '../utils/path-utils';
import { FileFilterPolicy } from '../policies/file-filter-policy';
import { TaskFactory } from '../tasks/task-factory';
import type PBBackupPlugin from '../main';
import type { ObsidianBackupEventType } from '../types/domain';

/**
 * a renamed TFolder to recursively emits individual file rename events.
 */
async function handleFolderRename(
    folder: TFolder,
    oldFolderPath: string,
    operationsManager: OperationsManager
): Promise<void> {
    const collectFiles = (parent: TFolder, files: TFile[]): void => {
        for (const child of parent.children) {
            if (child instanceof TFile) {
                files.push(child);
            } else if (child instanceof TFolder) {
                collectFiles(child, files);
            }
        }
    };

    const nestedFiles: TFile[] = [];
    collectFiles(folder, nestedFiles);

    for (const file of nestedFiles) {
        // Compute the file's previous relative path before the folder was renamed
        const relativeSuffix = file.path.slice(folder.path.length);
        const oldFilePath = PathUtils.normalize(`${oldFolderPath}${relativeSuffix}`);
        await operationsManager.handleFileRename(file, oldFilePath);
    }
}

/**
 * Registers all vault, workspace, and lifecycle event handlers with Obsidian.
 */
export function registerEvents(plugin: PBBackupPlugin, container: Container): void {
    const operationsManager = container.resolve(OperationsManager);
    const debounceController = container.resolve(DebounceController);
    const taskFactory = container.resolve(TaskFactory);

    // File modification
    plugin.registerEvent(
        plugin.app.vault.on('modify' satisfies ObsidianBackupEventType, async (file: TAbstractFile) => {
            if (!(file instanceof TFile)) return;
            const settings = plugin.settings;
            if (!FileFilterPolicy.isMonitored(file.path, settings.monitoredExtensions)) return;
            const saveTask = taskFactory.createSaveTask(file);
            await debounceController.schedule(saveTask);
        })
    );

    // File and Folder renames
    plugin.registerEvent(
        plugin.app.vault.on('rename' satisfies ObsidianBackupEventType, async (file: TAbstractFile, oldPath: string) => {
            const normalizedOld = PathUtils.normalize(oldPath);
            if (file instanceof TFile) {
                await operationsManager.handleFileRename(file, normalizedOld);
            } else if (file instanceof TFolder) {
                // Recursive folder rename traversal
                await handleFolderRename(file, normalizedOld, operationsManager);
            }
        })
    );

    // File deletions
    plugin.registerEvent(
        plugin.app.vault.on('delete' satisfies ObsidianBackupEventType, async (file: TAbstractFile) => {
            const normalizedPath = PathUtils.normalize(file.path);
            if (file instanceof TFile) {
                await operationsManager.handleFileDelete(normalizedPath);
            }
        })
    );

    // Active leaf switch: trigger immediate debounce flush
    plugin.registerEvent(
        plugin.app.workspace.on('active-leaf-change', () => {
            void debounceController.flushAll();
        })
    );

    // Window unload: flush pending debounced changes
    if (typeof window !== 'undefined') {
        plugin.registerDomEvent(window, 'beforeunload', () => {
            void debounceController.flushAll();
        });
    }
}
