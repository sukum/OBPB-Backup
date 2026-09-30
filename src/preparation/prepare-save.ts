import { TFile, Notice } from 'obsidian';
import type { SaveIntent } from '../operations/types';
import type { PreparedSaveUpload } from '../upload/types';
import type { PreparationContext, PreparationResult, PayloadPreparerDependencies } from './types';
import { DiffEngine } from '../diff/diff-engine';
import { SnapshotPolicy } from '../policies/snapshot-policy';
import { FileFilterPolicy } from '../policies/file-filter-policy';
import { BaseResolutionPolicy } from '../policies/base-resolution-policy';
import { Hasher } from '../hashing/hasher';
import { TaskFactory } from '../tasks/task-factory';
import { utf8ByteLength } from '../utils/text-size';
import {
    exceedsPocketBaseObjectDataLimit,
    POCKETBASE_OBJECT_DATA_MAX_CHARACTERS,
} from '../remote/pocketbase-schema';

interface SaveSource {
    file: TFile;
    content: string;
    contentHash: string;
    fileSizeBytes: number;
}

interface ResolvedSaveBase {
    baseText: string | null;
    parentHash: string | null;
    prevTimestamp?: number;
    diffDepth?: number;
    forceSnapshot: boolean;
}

type BaseResolutionResult =
    | { kind: 'unchanged' }
    | { kind: 'resolved'; base: ResolvedSaveBase };

export class PrepareSave {

    constructor(private readonly deps: PayloadPreparerDependencies) {}

    public async prepare(intent: SaveIntent, context?: PreparationContext): Promise<PreparationResult> {
        const settings = this.deps.getSettings();
        const source = await this.loadSource(intent, settings.monitoredExtensions);
        // Skipped
        if ('kind' in source) {
            return source;
        }
        // for sync
        const skipIfUnchanged = intent.policy.skipIfUnchanged;
        const vaultId = this.deps.deviceManager.getVaultId();
        const baseResolution = await this.resolveBase(intent, context, vaultId, source.contentHash, skipIfUnchanged);
        if (baseResolution.kind === 'unchanged') {
            return { kind: 'unchanged', path: intent.path };
        }

        return this.createUpload(intent, source, baseResolution.base, vaultId, settings);
    }

    private async loadSource(
        intent: SaveIntent,
        monitoredExtensions: string[]
    ): Promise<SaveSource | PreparationResult> {

        // Verify extension monitoring
        if (!FileFilterPolicy.isMonitored(intent.path, monitoredExtensions)) {
            return { kind: 'skipped', path: intent.path, reason: 'unmonitored_extension' };
        }

        // Resolve local file handle
        const candidate = intent.file || this.deps.vault.getAbstractFileByPath(intent.path);
        if (!(candidate instanceof TFile)) {
            return { kind: 'skipped', path: intent.path, reason: 'missing_file' };
        }
        const file = candidate;

        // Read content and normalize newlines
        const rawContent = await this.deps.vault.cachedRead(file);
        const content = DiffEngine.normalizeNewlines(rawContent);
        const fileSizeBytes = utf8ByteLength(content);

        // Validate upper file size bounds (< 10 MB)
        if (SnapshotPolicy.shouldSkipFile(fileSizeBytes)) {
            new Notice(`[OBPB Backup] Skipped ${file.name}: file exceeds 10 MB limit.`);
            return { kind: 'skipped', path: intent.path, reason: 'size_limit_exceeded' };
        }

        // Compute content hash
        const contentHash = await Hasher.computeHash(content);
        return { file, content, contentHash, fileSizeBytes };
    }

    private async resolveBase(
        intent: SaveIntent,
        context: PreparationContext | undefined,
        vaultId: string,
        contentHash: string,
        skipIfUnchanged: boolean
    ): Promise<BaseResolutionResult> {
        const initialBase: ResolvedSaveBase = {
            baseText: null,
            parentHash: null,
            forceSnapshot: intent.mode === 'snapshot',
        };

        // 6. Base Resolution
        // Fast path: In-memory NoteStateCache
        if (!context?.disableRecentNotesCache && this.deps.cache.has(intent.path)) {
            const cached = this.deps.cache.get(intent.path);
            const action = BaseResolutionPolicy.evaluate(contentHash, skipIfUnchanged, cached);
            if (action.action === 'skip_unchanged') {
                return { kind: 'unchanged' };
            }
            if (action.action === 'use_cached_base') {
                return {
                    kind: 'resolved',
                    base: {
                        ...initialBase,
                        baseText: action.baseText,
                        parentHash: action.parentHash,
                        diffDepth: action.diffDepth,
                        prevTimestamp: action.prevTimestamp,
                    },
                };
            }
            return { kind: 'resolved', base: initialBase };
        }

        // sync vault fetches existing remotes in bulk
        if (context?.bulkRemoteMap && context.bulkRemoteMap.has(intent.path)) {
            // Bulk path: Pre-fetched latest vault files map
            const remoteHead = context.bulkRemoteMap.get(intent.path)!;
            if (remoteHead.operation === 'delete') {
                return {
                    kind: 'resolved',
                    base: { ...initialBase, forceSnapshot: true, prevTimestamp: remoteHead.timestamp },
                };
            }
            if (skipIfUnchanged && remoteHead.hash === contentHash) {
                return { kind: 'unchanged' };
            }
            return this.resolveRemoteBase(intent, vaultId, contentHash, skipIfUnchanged, {
                ...initialBase,
                parentHash: remoteHead.hash,
                prevTimestamp: remoteHead.timestamp,
            });
        }

        // Cold path (or individual cold-path fallback when absent from bulk map)
        return this.resolveRemoteBase(intent, vaultId, contentHash, skipIfUnchanged, initialBase);
    }

    private async resolveRemoteBase(
        intent: SaveIntent,
        vaultId: string,
        contentHash: string,
        skipIfUnchanged: boolean,
        fallbackBase: ResolvedSaveBase
    ): Promise<BaseResolutionResult> {
        try {
            const entries = await this.deps.store.getEntriesWithObjects(vaultId, intent.path, 100);
            const action = BaseResolutionPolicy.evaluate(contentHash, skipIfUnchanged, undefined, entries);
            if (action.action === 'skip_unchanged') {
                return { kind: 'unchanged' };
            }
            if (action.action === 'reconstruct_remote_base') {
                try {
                    const baseText = await this.deps.reconstructionEngine.reconstructVersion(
                        vaultId,
                        intent.path,
                        action.parentHash,
                        entries
                    );
                    return {
                        kind: 'resolved',
                        base: {
                            ...fallbackBase,
                            baseText,
                            parentHash: action.parentHash,
                            diffDepth: action.diffDepth,
                            prevTimestamp: action.prevTimestamp,
                        },
                    };
                } catch { // Error calculating base - fallback to snapshot
                    return {
                        kind: 'resolved',
                        base: { ...fallbackBase, baseText: null, forceSnapshot: true },
                    };
                }
            }
            // Snapshot fallback in chain
            if (action.action === 'snapshot_fallback') {
                return {
                    kind: 'resolved',
                    base: {
                        ...fallbackBase,
                        forceSnapshot: true,
                        parentHash: action.parentHash,
                        prevTimestamp: action.prevTimestamp,
                    },
                };
            }
            // New snapshot backup fallback
            return {
                kind: 'resolved',
                base: {
                    ...fallbackBase,
                    forceSnapshot: true,
                    parentHash: null,
                    prevTimestamp: action.prevTimestamp,
                },
            };
        } catch { // Error resolving base - fallback to snapshot
            return {
                kind: 'resolved',
                base: { ...fallbackBase, forceSnapshot: true, parentHash: fallbackBase.parentHash },
            };
        }
    }

    private async createUpload(
        intent: SaveIntent,
        source: SaveSource,
        base: ResolvedSaveBase,
        vaultId: string,
        settings: ReturnType<PayloadPreparerDependencies['getSettings']>
    ): Promise<PreparationResult> {
        // Decide snapshot vs diff
        const isSnapshot = base.forceSnapshot // BaseResolution decided on snapshot
            || intent.mode === 'snapshot' // if intent (entryPoint) is snapshot
            || !base.parentHash // No parent, must snapshot
            || base.baseText === null // No base text, must snapshot
            // snapshot if file size, diff depth by settings require it
            || (intent.mode !== 'diff' && SnapshotPolicy.isSnapshotRequired(source.fileSizeBytes, base.diffDepth, settings, Boolean(base.parentHash)));

        // Generate diff payload
        if (!isSnapshot && base.baseText !== null && base.parentHash) {
            try {
                const patch = await this.deps.diffComputer.computeDiff(base.baseText, source.content, source.fileSizeBytes);
                const verified = DiffEngine.applyForwardDiff(base.baseText, patch);
                if (verified !== source.content) {
                    throw new Error('Diff verification mismatch; triggering snapshot fallback.');
                }

                const objectPayload = await TaskFactory.createDiffPayload(
                    vaultId,
                    base.parentHash,
                    source.contentHash,
                    patch,
                    utf8ByteLength(patch)
                );
                const invalidPayload = this.validateObjectData(intent, objectPayload.data);
                if (invalidPayload) return invalidPayload;

                const timestamp = TaskFactory.nextMonotonicTimestamp(base.prevTimestamp);
                const upload: PreparedSaveUpload = {
                    id: intent.id,
                    device: this.deps.deviceManager.getDevice(),
                    vault: vaultId,
                    path: intent.path,
                    timestamp,
                    targetHash: source.contentHash,
                    operation: 'save',
                    objectPayload,
                };
                return {
                    kind: 'ready',
                    upload,
                    content: source.content,
                    newDiffDepth: (base.diffDepth ?? 0) + 1,
                };
            } catch (diffErr) {
                console.warn(`[OBPB Backup] Diff generation failed for ${intent.path}, falling back to snapshot:`, diffErr);
            }
        }
        // snapshot payload prepare and return
        const objectPayload = await TaskFactory.createSnapshotPayload(
            vaultId,
            source.contentHash,
            source.content,
            base.parentHash,
            source.fileSizeBytes
        );
        const invalidPayload = this.validateObjectData(intent, objectPayload.data);
        if (invalidPayload) return invalidPayload;

        const timestamp = TaskFactory.nextMonotonicTimestamp(base.prevTimestamp);
        const upload: PreparedSaveUpload = {
            id: intent.id,
            device: this.deps.deviceManager.getDevice(),
            vault: vaultId,
            path: intent.path,
            timestamp,
            targetHash: source.contentHash,
            operation: 'save',
            objectPayload,
        };
        return {
            kind: 'ready',
            upload,
            content: source.content,
            newDiffDepth: 0,
        };
    }

    private validateObjectData(
        intent: SaveIntent,
        data: string
    ): Extract<PreparationResult, { kind: 'skipped' }> | undefined {
        if (!exceedsPocketBaseObjectDataLimit(data)) return undefined;

        new Notice(
            `[OBPB Backup] Skipped ${intent.path}: prepared object data exceeds PocketBase's ${POCKETBASE_OBJECT_DATA_MAX_CHARACTERS.toLocaleString()} character limit.`
        );
        return { kind: 'skipped', path: intent.path, reason: 'object_data_limit_exceeded' };
    }
}
