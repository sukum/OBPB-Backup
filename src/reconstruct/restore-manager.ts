import { Vault, TFile } from 'obsidian';
import type { RestoreResult, RestoreVersionOptions, SafetyBackupPerformer, VersionReconstructor } from './types';
import { OBPBBackupSettings } from '../types/settings';
import { RestoreSafetyPolicy } from '../policies/restore-safety-policy';
import { PathUtils } from '../utils/path-utils';
import { Hasher } from '../hashing/hasher';

/**
 * Manages historical note restoration.
 * Writes reconstructed text back to the local vault,
 * take safety snapshot of current version if checked in settings
 */
export class RestoreManager {
    constructor(
        private vault: Vault,
        private reconstructionEngine: VersionReconstructor,
        private getSettings: () => OBPBBackupSettings,
        private performSafetyBackup: SafetyBackupPerformer
    ) {}

    /**
     * Restores a specific version hash to a file path.
     * Handles existing files (modify) or deleted files (create).
     */
    public async restoreVersion(
        vaultId: string,
        relativePath: string,
        targetHash: string,
        options?: RestoreVersionOptions
    ): Promise<RestoreResult> {
        const normalizedPath = PathUtils.normalize(relativePath);

        // Reconstruct historical content with verification
        options?.notify?.(`Reconstructing ${normalizedPath}...`);

        let reconstructedContent: string | null = null;
        // content passed in (from note history)
        if (options?.knownContent) {
            const computedHash = await Hasher.computeHash(options.knownContent);
            if (computedHash === targetHash) {
                reconstructedContent = options.knownContent;
            }
        }
        // content not passed in (trash), or passed in content failed hash check
        if (!reconstructedContent) {
            reconstructedContent = await this.reconstructionEngine.reconstructVersion(
                vaultId,
                normalizedPath,
                targetHash,
                options?.entries
            );
        }
        // Sanity check: ensure reconstruction was successful
        if (!reconstructedContent) {
            throw new Error(`Failed to reconstruct text content for ${normalizedPath} to the target version ${targetHash}.`);
        }

        // Write reconstructed content to the local vault
        const existingFile = this.vault.getAbstractFileByPath(normalizedPath);
        if (existingFile instanceof TFile) { // Note history version restore
            // Check if current content is already identical to the target version
            const currentContent = await this.vault.read(existingFile);
            if (currentContent === reconstructedContent) {
                options?.notify?.(`${normalizedPath} exists with the same content. No change made.`);
                return { status: 'unchanged', path: normalizedPath };
            }

            // Perform safety backup of the current version if the policy requires it
            if (RestoreSafetyPolicy.shouldTakeSafetyBackup(this.getSettings(), options?.takeSafetyBackup)) {
                const backupResult = await this.performSafetyBackup(existingFile);
                // inFlightProcessing check of ManualFileOperation.execute returns null
                if (backupResult === null) {
                    throw new Error(`Cannot safely restore ${normalizedPath}: a vault backup or sync operation is currently active.`);
                }
            }
            await this.vault.modify(existingFile, reconstructedContent);
            options?.notify?.(`Successfully restored ${normalizedPath}`);
            return { status: 'modified', path: normalizedPath };
        } else { // Trashed note restore
            // File does not exist locally (e.g. recovering deleted file from trash)
            // Ensure parent directory exists recursively
            await this.createParentDirectoriesIfNeeded(normalizedPath);
            await this.vault.create(normalizedPath, reconstructedContent);
            options?.notify?.(`Restored note ${normalizedPath} from backup history`);
            return { status: 'created', path: normalizedPath };
        }
    }

    // Not used anywhere else, so no point in extracting this out as a utility
    private async createParentDirectoriesIfNeeded(normalizedFilePath: string): Promise<void> {
        const lastSlash = normalizedFilePath.lastIndexOf('/');
        if (lastSlash !== -1) {
            const parentDir = normalizedFilePath.slice(0, lastSlash);
            const segments = parentDir.split('/');
            let currentPath = '';
            for (const segment of segments) {
                currentPath = currentPath ? `${currentPath}/${segment}` : segment;
                if (!(await this.vault.adapter.exists(currentPath))) {
                    await this.vault.createFolder(currentPath);
                }
            }
        }
    }
}
