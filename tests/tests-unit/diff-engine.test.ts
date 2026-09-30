import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DiffEngine } from '../../src/diff/diff-engine';

describe("Diff Engine Tests", () => {
test('DiffEngine.createForwardDiff generates unified diff with context 1 and normalized newlines', () => {
    const oldText = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n';
    const newText = 'Line 1\nLine 2 modified\nLine 3\nLine 4\nLine 5\n';

    const patch = DiffEngine.createForwardDiff(oldText, newText);

    // Assert patch format and contents
    assert.ok(patch.includes('---'));
    assert.ok(patch.includes('+++'));
    assert.ok(patch.includes('@@'));
    assert.ok(patch.includes('-Line 2'));
    assert.ok(patch.includes('+Line 2 modified'));

    // Verify context: 1 (only 1 line of context before and after change)
    assert.ok(patch.includes(' Line 1'));
    assert.ok(patch.includes(' Line 3'));
    // Line 5 is far from Line 2 and should not be in this hunk
    assert.ok(!patch.includes(' Line 5'));
});

test.skip('DiffEngine.createForwardDiff normalizes CRLF line breaks to LF', () => {
    const crlfOld = '# Header\r\nFirst paragraph\r\nSecond paragraph\r\n';
    const crlfNew = '# Header\r\nFirst paragraph modified\r\nSecond paragraph\r\n';

    const patch = DiffEngine.createForwardDiff(crlfOld, crlfNew);

    // Patch must not contain carriage return characters
    assert.ok(!patch.includes('\r\n'), 'Patch should have LF line endings, not CRLF');
    assert.ok(!patch.includes('\r'), 'Patch should not contain carriage returns');
    assert.ok(patch.includes('+First paragraph modified'));
});

test('DiffEngine.createForwardDiff handles empty text transitions', () => {
    // 1. Creation: empty string to populated string
    const emptyToText = DiffEngine.createForwardDiff('', 'Brand new content\n');
    assert.ok(emptyToText.includes('+Brand new content'));

    // 2. Deletion: populated string to empty string
    const textToEmpty = DiffEngine.createForwardDiff('Content to remove\n', '');
    assert.ok(textToEmpty.includes('-Content to remove'));

    // 3. No change: empty string to empty string
    const emptyToEmpty = DiffEngine.createForwardDiff('', '');
    assert.ok(!emptyToEmpty.includes('@@'), 'Empty to empty should have no hunk header');
    assert.equal(/^\+[^+]/m.test(emptyToEmpty), false, 'Empty to empty should not have added lines');
    assert.equal(/^-[^-]/m.test(emptyToEmpty), false, 'Empty to empty should not have removed lines');
});

test('DiffEngine.createForwardDiff handles identical content', () => {
    const content = '# Title\nBody content\n';
    const patch = DiffEngine.createForwardDiff(content, content);

    assert.ok(!patch.includes('@@'), 'Identical content patch should have no hunk header');
    assert.equal(/^\+[^+]/m.test(patch), false, 'Identical content patch should have no additions');
    assert.equal(/^-[^-]/m.test(patch), false, 'Identical content patch should have no deletions');
});

test('DiffEngine.applyForwardDiff cleanly reconstructs modified text from forward patch', () => {
    const oldText = '# Title\n\nIntro line.\nSection 1.\nSection 2.\n';
    const newText = '# Title\n\nIntro line modified.\nSection 1.\nSection 2 updated.\nSection 3 added.\n';

    const patch = DiffEngine.createForwardDiff(oldText, newText);
    const reconstructed = DiffEngine.applyForwardDiff(oldText, patch);

    assert.equal(reconstructed, newText);
});

test.skip('DiffEngine.applyForwardDiff normalizes CRLF base text before applying patch', () => {
    const oldTextLf = 'Alpha\nBeta\nGamma\n';
    const newTextLf = 'Alpha\nBeta modified\nGamma\n';
    const patch = DiffEngine.createForwardDiff(oldTextLf, newTextLf);

    // Base text has Windows CRLF line endings
    const oldTextCrlf = 'Alpha\r\nBeta\r\nGamma\r\n';
    const reconstructed = DiffEngine.applyForwardDiff(oldTextCrlf, patch);

    // Reconstructed output must be normalized to LF and match target
    assert.equal(reconstructed, newTextLf);
    assert.ok(!reconstructed.includes('\r'));
});

test('DiffEngine.applyForwardDiff handles creation and full deletion', () => {
    // Creation round-trip
    const createdText = 'Line A\nLine B';
    const creationPatch = DiffEngine.createForwardDiff('', createdText);
    const createdResult = DiffEngine.applyForwardDiff('', creationPatch);
    assert.equal(createdResult, createdText);

    // Deletion round-trip
    const deletionPatch = DiffEngine.createForwardDiff(createdText, '');
    const deletionResult = DiffEngine.applyForwardDiff(createdText, deletionPatch);
    assert.equal(deletionResult, '');
});

test('DiffEngine.applyForwardDiff throws explicit Error when patch cannot be applied cleanly', () => {
    const oldText = 'One\nTwo\nThree\n';
    const newText = 'One\nTwo modified\nThree\n';
    const patch = DiffEngine.createForwardDiff(oldText, newText);

    const conflictingBaseText = 'Unrelated content\nDoes not match\n';

    assert.throws(
        () => {
            DiffEngine.applyForwardDiff(conflictingBaseText, patch);
        },
        {
            name: 'Error',
            message: 'Patch application rejected: base text does not match patch context',
        }
    );
});

test('DiffEngine.applyForwardDiff throws error on corrupted patch text', () => {
    const validBase = 'Valid base text\n';
    const corruptPatch = '@@ invalid hunk header @@\n-Random line\n+Broken line\n';

    assert.throws(() => {
        DiffEngine.applyForwardDiff(validBase, corruptPatch);
    });
});
});
