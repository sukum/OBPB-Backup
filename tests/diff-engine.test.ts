import test from 'node:test';
import assert from 'node:assert/strict';
import { DiffEngine } from '../src/diff/diff-engine';

test.skip('DiffEngine handles newline normalization, compact patches, and application', () => {
    const textV1 = '# Note\r\nLine 1\r\nLine 2\r\nLine 3\r\n';
    const textV2 = '# Note\nLine 1\nLine 2 modified\nLine 3\nLine 4\n';

    // Normalization test
    const normV1 = DiffEngine.normalizeNewlines(textV1);
    assert.ok(!normV1.includes('\r\n'));

    // Create patch with context 1
    const patch = DiffEngine.createForwardDiff(textV1, textV2);
    assert.ok(patch.includes('Line 2 modified'));
    assert.ok(patch.includes('+Line 4'));

    // Apply patch forward
    const reconstructed = DiffEngine.applyForwardDiff(textV1, patch);
    assert.equal(reconstructed, DiffEngine.normalizeNewlines(textV2));

    // Assert that bad patch throws error (asserting rejection)
    assert.throws(() => {
        DiffEngine.applyForwardDiff('Completely different content that does not match patch', patch);
    });
});

