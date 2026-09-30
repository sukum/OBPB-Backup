import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DiffWorkerClient } from '../../src/diff/diff-worker-client';
import { DiffEngine } from '../../src/diff/diff-engine';

describe("Diff Worker Client Tests", () => {
test('DiffWorkerClient.computeDiff handles small files (< 500 KB) synchronously via DiffEngine', async () => {
    const client = new DiffWorkerClient();
    const oldText = '# Note\nLine A\nLine B\n';
    const newText = '# Note\nLine A modified\nLine B\n';

    // 1. Small size test (e.g., 200 bytes)
    const patch = await client.computeDiff(oldText, newText, 200);

    assert.ok(patch.includes('+Line A modified'));
    assert.ok(patch.includes('-Line A'));

    const reconstructed = DiffEngine.applyForwardDiff(oldText, patch);
    assert.equal(reconstructed, newText);

    // 2. Just below threshold boundary: 500 * 1024 - 1
    const nearBoundarySize = 500 * 1024 - 1;
    const boundaryPatch = await client.computeDiff(oldText, newText, nearBoundarySize);
    assert.equal(DiffEngine.applyForwardDiff(oldText, boundaryPatch), newText);
});

test('DiffWorkerClient.computeDiff yields to event loop for large files (>= 500 KB)', async () => {
    const client = new DiffWorkerClient();
    const oldText = 'Large content base\nLine 1\nLine 2\n';
    const newText = 'Large content base\nLine 1 modified\nLine 2\n';

    // 1. Boundary size: exactly 500 * 1024 (512,000 bytes)
    const thresholdSize = 500 * 1024;
    let microtaskRan = false;

    const promiseBoundary = client.computeDiff(oldText, newText, thresholdSize);
    queueMicrotask(() => {
        microtaskRan = true;
    });

    const boundaryPatch = await promiseBoundary;
    // Because large file computation uses setTimeout (macrotask), the queued microtask must have run first
    assert.equal(microtaskRan, true, 'Microtask should run before setTimeout macrotask resolves');
    assert.equal(DiffEngine.applyForwardDiff(oldText, boundaryPatch), newText);

    // 2. Large size: 600 KB
    const largeSize = 600 * 1024;
    const largePatch = await client.computeDiff(oldText, newText, largeSize);
    assert.ok(largePatch.includes('+Line 1 modified'));
    assert.equal(DiffEngine.applyForwardDiff(oldText, largePatch), newText);
});

test('DiffWorkerClient.computeDiff handles identical content and empty transitions', async () => {
    const client = new DiffWorkerClient();

    // Identical content for small file
    const samePatchSmall = await client.computeDiff('Same text', 'Same text', 100);
    assert.ok(!samePatchSmall.includes('@@'), 'Identical diff should have no hunks');
    assert.equal(/^\+[^+]/m.test(samePatchSmall), false, 'Identical diff should have no additions');

    // Identical content for large file
    const samePatchLarge = await client.computeDiff('Same text', 'Same text', 600 * 1024);
    assert.ok(!samePatchLarge.includes('@@'), 'Identical diff should have no hunks');
    assert.equal(/^\+[^+]/m.test(samePatchLarge), false, 'Identical diff should have no additions');

    // Empty to populated for large file
    const createdPatch = await client.computeDiff('', 'Hello world\n', 500 * 1024);
    assert.equal(DiffEngine.applyForwardDiff('', createdPatch), 'Hello world\n');
});

test('DiffWorkerClient.computeDiff propagates errors in large file async execution', async () => {
    const client = new DiffWorkerClient();

    // Force error in DiffEngine.createForwardDiff by passing null/invalid type
    await assert.rejects(
        async () => {
            await client.computeDiff(null as unknown as string, 'valid', 500 * 1024);
        },
        {
            name: 'TypeError',
        }
    );
});
});
