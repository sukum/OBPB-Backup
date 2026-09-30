import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryCoalescePolicy } from '../src/policies/recovery-coalesce-policy';
import type { DirtyFileEntry } from '../src/types/state';

describe('RecoveryCoalescePolicy Tests', () => {
    test('coalesces multiple SAVE operations for a single path into one SAVE', () => {
        const input: DirtyFileEntry[] = [
            { operation: 'SAVE', path: 'note1.md' },
            { operation: 'SAVE', path: 'note1.md' },
            { operation: 'SAVE', path: 'note1.md' },
        ];
        const result = RecoveryCoalescePolicy.coalesce(input);
        assert.deepEqual(result, [
            { operation: 'SAVE', path: 'note1.md' },
        ]);
    });

    test('coalesces SAVE then DELETE into single DELETE', () => {
        const input: DirtyFileEntry[] = [
            { operation: 'SAVE', path: 'note.md' },
            { operation: 'SAVE', path: 'note.md' },
            { operation: 'DELETE', path: 'note.md' },
        ];
        const result = RecoveryCoalescePolicy.coalesce(input);
        assert.deepEqual(result, [
            { operation: 'DELETE', path: 'note.md' },
        ]);
    });

    test('coalesces DELETE then SAVE into single SAVE (last op wins)', () => {
        const input: DirtyFileEntry[] = [
            { operation: 'DELETE', path: 'note.md' },
            { operation: 'SAVE', path: 'note.md' },
        ];
        const result = RecoveryCoalescePolicy.coalesce(input);
        assert.deepEqual(result, [
            { operation: 'SAVE', path: 'note.md' },
        ]);
    });

    test('coalesces RENAME only on its destination path', () => {
        const input: DirtyFileEntry[] = [
            { operation: 'SAVE', path: 'old.md' },
            { operation: 'RENAME', path: 'new.md', oldPath: 'old.md' },
        ];
        const result = RecoveryCoalescePolicy.coalesce(input);
        assert.deepEqual(result, [
            { operation: 'SAVE', path: 'old.md' },
            { operation: 'RENAME', path: 'new.md', oldPath: 'old.md' },
        ]);
    });

    test('coalesces RENAME followed by SAVE on newPath without expanding rename effects', () => {
        const input: DirtyFileEntry[] = [
            { operation: 'RENAME', path: 'new.md', oldPath: 'old.md' },
            { operation: 'SAVE', path: 'new.md' },
        ];
        const result = RecoveryCoalescePolicy.coalesce(input);
        assert.deepEqual(result, [
            { operation: 'SAVE', path: 'new.md' },
        ]);
    });

    test('handles multiple distinct paths independently', () => {
        const input: DirtyFileEntry[] = [
            { operation: 'SAVE', path: 'a.md' },
            { operation: 'SAVE', path: 'b.md' },
            { operation: 'DELETE', path: 'a.md' },
            { operation: 'SAVE', path: 'c.md' },
            { operation: 'SAVE', path: 'b.md' },
        ];
        const result = RecoveryCoalescePolicy.coalesce(input);
        assert.deepEqual(result, [
            { operation: 'DELETE', path: 'a.md' },
            { operation: 'SAVE', path: 'b.md' },
            { operation: 'SAVE', path: 'c.md' },
        ]);
    });
});
