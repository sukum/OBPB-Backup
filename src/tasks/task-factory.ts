import { Hasher } from '../hashing/hasher';
import { DiffEngine } from '../diff/diff-engine';
import type { TFile } from 'obsidian';
import type { DebouncedSaveTask } from '../types/state';
import type { ObjectUploadPayload } from '../upload/types';
import { generateUUID } from '../utils/uuid';

/**
 * Pure factory functions for constructing debounce tasks, backup payloads,
 * deterministic IDs, and monotonic timestamps.
 */
export class TaskFactory {
    /**
     * Generates a unique task ID using standard UUID generation.
     */
    public static generateTaskId(): string {
        return generateUUID();
    }

    /**
     * Calculates a strictly monotonic timestamp (epoch ms).
     */
    public static nextMonotonicTimestamp(prevTimestamp?: number): number {
        const now = Date.now();
        return Math.max(now, (prevTimestamp || 0) + 1);
    }

    public createSaveTask(input: TFile | string): DebouncedSaveTask {
        const resolvedPath = typeof input === 'string' ? input : input.path;
        if (!resolvedPath.trim()) throw new Error('Save task path must not be empty.');
        return {
            id: TaskFactory.generateTaskId(),
            path: resolvedPath,
            file: typeof input === 'string' ? undefined : input,
            timestamp: Date.now(),
        };
    }

    /**
     * Creates an immutable snapshot object payload with deterministic ID and data hash.
     */
    public static async createSnapshotPayload(
        vaultId: string,
        contentHash: string,
        content: string,
        parentHash: string | null,
        size: number
    ): Promise<ObjectUploadPayload> {
        const deterministicId = await Hasher.deriveSnapshotObjectId(vaultId, contentHash);
        const dataHash = await Hasher.computeDataHash(content);

        return {
            deterministicId,
            hash: contentHash,
            parentHash,
            type: 'snapshot',
            data: content,
            dataHash,
            diffFormat: null,
            size,
        };
    }

    /**
     * Creates an immutable diff object payload with deterministic ID and data hash.
     */
    public static async createDiffPayload(
        vaultId: string,
        parentHash: string,
        contentHash: string,
        patch: string,
        size: number
    ): Promise<ObjectUploadPayload> {
        const deterministicId = await Hasher.deriveDiffObjectId(
            vaultId,
            parentHash,
            contentHash,
            DiffEngine.DIFF_FORMAT
        );
        const dataHash = await Hasher.computeDataHash(patch);

        return {
            deterministicId,
            hash: contentHash,
            parentHash,
            type: 'diff',
            data: patch,
            dataHash,
            diffFormat: DiffEngine.DIFF_FORMAT,
            size,
        };
    }

}
