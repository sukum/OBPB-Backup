import { TFile } from 'obsidian';
import { FileFilterPolicy } from '../policies/file-filter-policy';
import { PathUtils } from '../utils/path-utils';
import { generateUUID } from '../utils/uuid';
import {
    BASE_EXECUTION_POLICIES,
    type AutoDeleteIntent,
    type AutoRenameIntent,
    type FileRenameInput,
    type RenameFileOperationContext,
    type INTENT_DEFAULT_SPEC_PROPERTIES,
} from './types';

const AUTO_DELETE_INTENT_DEFAULTS = {
    trigger: 'auto',
    event: 'delete',
    operation: 'delete',
    policy: BASE_EXECUTION_POLICIES.AUTO,
} as const satisfies Pick<AutoDeleteIntent, INTENT_DEFAULT_SPEC_PROPERTIES>;

const AUTO_RENAME_INTENT_DEFAULTS = {
    trigger: 'auto',
    event: 'rename',
    operation: 'rename',
    policy: BASE_EXECUTION_POLICIES.AUTO,
} as const satisfies Pick<AutoRenameIntent, INTENT_DEFAULT_SPEC_PROPERTIES>;

export interface FolderLike {
    path: string;
    children: unknown[];
}

export function isFolderLike(value: unknown): value is FolderLike {
    return typeof value === 'object'
        && value !== null
        && 'path' in value
        && typeof value.path === 'string'
        && 'children' in value
        && Array.isArray(value.children);
}

/**
 * Records automatic rename topology changes and queues lean intents.
 * Resolution of remote state and publication are deliberately deferred to the runner.
 */
export class RenameFileOperation {
    constructor(private readonly context: RenameFileOperationContext) {}

    public async execute(input: FileRenameInput, oldPath: string): Promise<void> {
        const sourcePath = PathUtils.normalize(oldPath || '');
        if (!sourcePath) {
            throw new Error('Rename operation requires an old path.');
        }

        if (isFolderLike(input)) {
            await this.expandFolderRename(input, sourcePath);
            return;
        }

        if (!(input instanceof TFile)) {
            throw new Error('Rename operation requires a destination TFile.');
        }

        await this.enqueueFileRename(input, sourcePath);
    }

    private async expandFolderRename(folder: FolderLike, oldFolderPath: string): Promise<void> {
        const files: TFile[] = [];
        const collectFiles = (parent: FolderLike): void => {
            for (const child of parent.children) {
                if (child instanceof TFile) {
                    files.push(child);
                } else if (isFolderLike(child)) {
                    collectFiles(child);
                }
            }
        };

        collectFiles(folder);
        for (const file of files) {
            const suffix = file.path.slice(folder.path.length);
            await this.enqueueFileRename(file, PathUtils.normalize(`${oldFolderPath}${suffix}`));
        }
    }

    private async enqueueFileRename(file: TFile, oldPath: string): Promise<void> {
        const id = generateUUID();
        this.context.debounceController.cancel(oldPath);

        // If a monitored extension is changed to one not. Like .md -> .pdf.
        // DEL entry on old path
        if (!FileFilterPolicy.isMonitored(file.path, this.context.getSettings().monitoredExtensions)) {
            await this.context.dirtyFileManager.markDirty('DELETE', oldPath);
            const deleteIntent: AutoDeleteIntent = {
                ...AUTO_DELETE_INTENT_DEFAULTS,
                id,
                path: oldPath,
                createdAt: Date.now(),
            };
            await this.context.queue.enqueue(deleteIntent);
            return;
        }

        await this.context.dirtyFileManager.markDirty('RENAME', file.path, oldPath);
        const renameIntent: AutoRenameIntent = {
            ...AUTO_RENAME_INTENT_DEFAULTS,
            id,
            path: file.path,
            oldPath,
            file,
            createdAt: Date.now(),
        };
        await this.context.queue.enqueue(renameIntent);
    }
}
