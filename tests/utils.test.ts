import { test, TestContext, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PathUtils } from '../src/utils/path-utils';
import { generateUUID } from '../src/utils/uuid';
import { formatBytes } from '../src/utils/format';
import { TaskFactory } from '../src/tasks/task-factory';
import { utf8ByteLength } from '../src/utils/text-size';

describe("Utility Functions Tests", () => {
test('PathUtils normalizes paths and extracts lowercase extensions', () => {
    // Normalization
    assert.equal(PathUtils.normalize('\\Windows\\Path\\File.md'), 'Windows/Path/File.md');
    assert.equal(PathUtils.normalize('///Leading/and/trailing///'), 'Leading/and/trailing');
    assert.equal(PathUtils.normalize('mixed/separators\\nested/file.txt'), 'mixed/separators/nested/file.txt');
    assert.equal(PathUtils.normalize('plain_filename.md'), 'plain_filename.md');

    // Extension extraction
    assert.equal(PathUtils.getExtension('Notes/Daily.md'), 'md');
    assert.equal(PathUtils.getExtension('Visual/Board.CANVAS'), 'canvas');
    assert.equal(PathUtils.getExtension('Images/photo.PNG'), 'png');
    assert.equal(PathUtils.getExtension('no_extension'), '');
    assert.equal(PathUtils.getExtension('Folder.with.dots/file'), '');
    assert.equal(PathUtils.getExtension('Folder.with.dots/file.json'), 'json');
});


test('generateUUID creates RFC 4122 v4 compliant unique strings and handles fallback', () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    // Test default environment (native crypto.randomUUID in Node)
    const id1 = generateUUID();
    const id2 = generateUUID();
    assert.match(id1, uuidRegex, 'UUID must match RFC 4122 v4 format');
    assert.match(id2, uuidRegex, 'UUID must match RFC 4122 v4 format');
    assert.notEqual(id1, id2, 'Successive UUIDs must be distinct');

    // Test TaskFactory.generateTaskId delegating to generateUUID
    const taskId = TaskFactory.generateTaskId();
    assert.match(taskId, uuidRegex, 'TaskFactory.generateTaskId must produce valid UUID');

    // Test fallback when crypto.randomUUID is temporarily removed
    const originalRandomUUID = (globalThis as any).crypto?.randomUUID;
    try {
        if ((globalThis as any).crypto) {
            delete (globalThis as any).crypto.randomUUID;
        }
        const fallbackId1 = generateUUID();
        const fallbackId2 = generateUUID();
        assert.match(fallbackId1, uuidRegex, 'Fallback UUID must match RFC 4122 v4 format');
        assert.match(fallbackId2, uuidRegex, 'Fallback UUID must match RFC 4122 v4 format');
        assert.notEqual(fallbackId1, fallbackId2, 'Fallback UUIDs must be distinct');
    } finally {
        if (originalRandomUUID && (globalThis as any).crypto) {
            (globalThis as any).crypto.randomUUID = originalRandomUUID;
        }
    }
});

// Obsolete: TaskFactory is now a stateless factory; vault and device identities are
// managed by DeviceManager and injected into upload/payload creation pipelines.
test.skip('TaskFactory keeps immutable plugin identity instance-scoped', () => {
    const first = new (TaskFactory as any)('vault-one', 'device-one');
    const second = new (TaskFactory as any)('vault-two', 'device-two');

    const firstTask = first.createSaveTask('First.md');
    const secondTask = second.createSaveTask('Second.md');

    assert.equal((firstTask as any).vault, 'vault-one');
    assert.equal((firstTask as any).device, 'device-one');
    assert.equal((secondTask as any).vault, 'vault-two');
    assert.equal((secondTask as any).device, 'device-two');
    assert.throws(() => new (TaskFactory as any)('', 'device'), /immutable vault and device identities/);
});


test('EventEmitter supports typed subscriptions, unsubscriptions, clear, and error isolation', async (t: TestContext) => {
    const { EventEmitter } = await import('../src/utils/event-emitter');

    // 1. Typed payload event emitter
    const stringEmitter = new EventEmitter<string>();
    const received: string[] = [];

    const unsub1 = stringEmitter.subscribe((val) => {
        received.push(`listener1:${val}`);
    });

    const unsub2 = stringEmitter.subscribe((val) => {
        received.push(`listener2:${val}`);
    });

    assert.equal(stringEmitter.size, 2);

    stringEmitter.notify('event-1');
    assert.deepEqual(received, ['listener1:event-1', 'listener2:event-1']);

    // 2. Unsubscribe works cleanly
    unsub1();
    assert.equal(stringEmitter.size, 1);

    stringEmitter.notify('event-2');
    assert.deepEqual(received, [
        'listener1:event-1',
        'listener2:event-1',
        'listener2:event-2',
    ]);

    // 3. Void payload event emitter
    const voidEmitter = new EventEmitter<void>();
    let voidCallCount = 0;
    voidEmitter.subscribe(() => {
        voidCallCount++;
    });

    voidEmitter.notify();
    assert.equal(voidCallCount, 1);

    // 4. Error isolation: one listener throwing does not prevent subsequent listeners
    let secondListenerExecuted = false;
    t.mock.method(console, 'error', () => {});
    stringEmitter.subscribe(() => {
        throw new Error('Explosion in listener');
    });
    stringEmitter.subscribe(() => {
        secondListenerExecuted = true;
    });

    // Should not throw
    stringEmitter.notify('safe-event');
    assert.equal(secondListenerExecuted, true);

    // 5. Clear removes all listeners
    stringEmitter.clear();
    assert.equal(stringEmitter.size, 0);
});

test('formatBytes converts numeric byte counts into human-readable representations', () => {
    // 0 and negative bytes
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(-10), '0 B');

    // Small bytes (< 1024)
    assert.equal(formatBytes(1), '1 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1023), '1023 B');

    // Kilobytes (1024 to 1024*1024)
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 * 50), '50.0 KB');

    // Megabytes (>= 1024*1024)
    assert.equal(formatBytes(1024 * 1024), '1.00 MB');
    assert.equal(formatBytes(1024 * 1024 * 2.5), '2.50 MB');
    assert.equal(formatBytes(1024 * 1024 * 10.123), '10.12 MB');
});

test('utf8ByteLength measures encoded bytes for ASCII, accented characters, and emoji', () => {
    assert.equal(utf8ByteLength(''), 0);
    assert.equal(utf8ByteLength('abc'), 3);
    assert.equal(utf8ByteLength('é'), 2);
    assert.equal(utf8ByteLength('🙂'), 4);
    assert.equal(utf8ByteLength('aé🙂'), 7);
});
});
