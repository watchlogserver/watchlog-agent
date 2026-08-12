// Shared incremental log reader tests.
//
// app/logTail.js is the tailing primitive both the log watchlist and the
// Elasticsearch slow-log collector follow files with, so a regression here
// breaks two pipelines. The cases that matter are the ones a happy-path append
// never exercises: rotation, truncation, a write caught mid-line, and a file
// that grew faster than one read window.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTailReader } = require('../app/logTail');

function withTempFile(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-logtail-'));
    const file = path.join(dir, 'app.log');
    try {
        return run(file, dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('a newly watched file starts at its end, never replaying history', () => {
    withTempFile((file) => {
        fs.writeFileSync(file, 'old line 1\nold line 2\n');
        const reader = createTailReader();

        assert.deepStrictEqual(reader.read(file).lines, [],
            'enabling a watcher must not ship months of history in one burst');

        fs.appendFileSync(file, 'new line\n');
        assert.deepStrictEqual(reader.read(file).lines, ['new line']);
    });
});

test('seek("start") replays from the beginning when that is what is wanted', () => {
    withTempFile((file) => {
        fs.writeFileSync(file, 'one\ntwo\n');
        const reader = createTailReader();
        reader.seek(file, 'start');
        assert.deepStrictEqual(reader.read(file).lines, ['one', 'two']);
    });
});

test('a write caught mid-line is re-read whole rather than split or dropped', () => {
    withTempFile((file) => {
        fs.writeFileSync(file, '');
        const reader = createTailReader();
        reader.read(file);

        // A partial line, as a logger flushing mid-write produces.
        fs.appendFileSync(file, 'complete line\nincomplete li');
        const first = reader.read(file);
        assert.deepStrictEqual(first.lines, ['complete line'],
            'the incomplete tail is left unread, not emitted as a truncated line');

        fs.appendFileSync(file, 'ne here\n');
        const second = reader.read(file);
        assert.deepStrictEqual(second.lines, ['incomplete line here'],
            'the offset stayed put, so the whole line arrives once it is complete');
    });
});

test('rotation is detected and reading resumes from the new file', () => {
    withTempFile((file, dir) => {
        fs.writeFileSync(file, 'before rotation\n');
        const reader = createTailReader();
        reader.read(file);

        fs.appendFileSync(file, 'last line before rotate\n');
        assert.deepStrictEqual(reader.read(file).lines, ['last line before rotate']);

        // logrotate: move the old file aside and create a new one.
        fs.renameSync(file, path.join(dir, 'app.log.1'));
        fs.writeFileSync(file, 'first line after rotate\n');

        const result = reader.read(file);
        assert.strictEqual(result.rotated, true);
        assert.deepStrictEqual(result.lines, ['first line after rotate']);
    });
});

test('truncation in place is treated as a rotation', () => {
    withTempFile((file) => {
        fs.writeFileSync(file, 'a'.repeat(500) + '\n');
        const reader = createTailReader();
        reader.read(file);

        // `> app.log` — same inode, smaller size.
        fs.writeFileSync(file, 'fresh\n');
        const result = reader.read(file);

        assert.strictEqual(result.rotated, true);
        assert.deepStrictEqual(result.lines, ['fresh']);
    });
});

test('a read is bounded and reports that more is waiting', () => {
    withTempFile((file) => {
        fs.writeFileSync(file, '');
        const reader = createTailReader({ maxReadBytes: 100 });
        reader.read(file);

        // Ten 20-byte lines: 200 bytes, twice the window.
        const line = 'x'.repeat(19);
        fs.appendFileSync(file, Array.from({ length: 10 }, () => line).join('\n') + '\n');

        const first = reader.read(file);
        assert.ok(first.lines.length > 0 && first.lines.length < 10);
        assert.strictEqual(first.more, true, 'the caller can loop rather than losing the rest');

        const rest = reader.drain(file);
        assert.strictEqual(first.lines.length + rest.lines.length, 10,
            'draining picks up exactly what the bounded read left behind');
    });
});

test('drain stops once the file is caught up', () => {
    withTempFile((file) => {
        fs.writeFileSync(file, '');
        const reader = createTailReader({ maxReadBytes: 64 });
        reader.read(file);

        fs.appendFileSync(file, Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n');

        const drained = reader.drain(file, 10);
        assert.strictEqual(drained.lines.length, 20);
        assert.deepStrictEqual(reader.drain(file).lines, []);
    });
});

test('a pathologically long line is skipped rather than stalling the reader forever', () => {
    withTempFile((file) => {
        fs.writeFileSync(file, '');
        const reader = createTailReader({ maxReadBytes: 100, maxLineLength: 50 });
        reader.read(file);

        // 500 bytes with no newline: it can never fit the window.
        fs.appendFileSync(file, 'y'.repeat(500));
        const stuck = reader.read(file);
        assert.strictEqual(stuck.lines.length, 0);
        assert.strictEqual(stuck.truncatedLines, 1);

        // The reader moved past it, so the next real line still arrives.
        fs.appendFileSync(file, '\nrecovered\n');
        const after = reader.drain(file);
        assert.ok(after.lines.includes('recovered'));
    });
});

test('an over-long but terminated line is truncated, not dropped', () => {
    withTempFile((file) => {
        fs.writeFileSync(file, '');
        const reader = createTailReader({ maxLineLength: 20 });
        reader.read(file);

        fs.appendFileSync(file, 'z'.repeat(100) + '\n');
        const result = reader.read(file);

        assert.strictEqual(result.lines.length, 1);
        assert.strictEqual(result.lines[0].length, 20);
        assert.strictEqual(result.truncatedLines, 1);
    });
});

test('carriage returns and blank lines are stripped', () => {
    withTempFile((file) => {
        fs.writeFileSync(file, '');
        const reader = createTailReader();
        reader.read(file);

        fs.appendFileSync(file, 'windows line\r\n\n   \nunix line\n');
        assert.deepStrictEqual(reader.read(file).lines, ['windows line', 'unix line']);
    });
});

test('a missing file reports an error instead of throwing', () => {
    const reader = createTailReader();
    const result = reader.read('/definitely/not/a/real/file.log');
    assert.strictEqual(result.error, 'ENOENT');
    assert.deepStrictEqual(result.lines, []);
});

test('a directory is rejected rather than read', () => {
    const reader = createTailReader();
    const result = reader.read(os.tmpdir());
    assert.strictEqual(result.error, 'NOT_A_FILE');
});

test('two readers keep independent offsets over the same file', () => {
    withTempFile((file) => {
        fs.writeFileSync(file, '');
        const a = createTailReader();
        const b = createTailReader();
        a.read(file);
        b.read(file);

        fs.appendFileSync(file, 'shared line\n');

        // The Elasticsearch slow-log reader and the log watchlist can follow the
        // same path without stealing each other's position.
        assert.deepStrictEqual(a.read(file).lines, ['shared line']);
        assert.deepStrictEqual(b.read(file).lines, ['shared line']);
    });
});

test('forget and reset clear tracked offsets', () => {
    withTempFile((file) => {
        fs.writeFileSync(file, 'existing\n');
        const reader = createTailReader();
        reader.read(file);
        assert.strictEqual(reader.isTracked(file), true);

        reader.forget(file);
        assert.strictEqual(reader.isTracked(file), false);

        reader.read(file);
        assert.strictEqual(reader.isTracked(file), true);
        reader.reset();
        assert.strictEqual(reader.isTracked(file), false);
    });
});
