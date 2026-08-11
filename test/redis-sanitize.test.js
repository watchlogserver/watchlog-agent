// Redaction tests for Redis slowlog arguments.
//
// These guard a privacy boundary, not a formatting preference: anything that
// survives sanitizeCommand() leaves the customer's server. A regression here
// ships passwords and session tokens to Watchlog's storage, so the assertions
// are deliberately strict about what must NOT appear.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { sanitizeCommand, REDACTED } = require('../app/integrations/redis/sanitize');

test('redacts the value but keeps the key, matching the documented example', () => {
    const result = sanitizeCommand(['SET', 'user:token', 'secret-value']);
    assert.strictEqual(result.command, 'SET user:token [REDACTED]');
    assert.strictEqual(result.commandName, 'SET');
    assert.strictEqual(result.redactedCount, 1);
});

test('AUTH never exposes the password', () => {
    const result = sanitizeCommand(['AUTH', 'hunter2']);
    assert.strictEqual(result.command, 'AUTH [REDACTED]');
    assert.ok(!result.command.includes('hunter2'));
});

test('AUTH with a username redacts both parts', () => {
    const result = sanitizeCommand(['AUTH', 'admin', 'hunter2']);
    assert.strictEqual(result.command, 'AUTH [REDACTED] [REDACTED]');
    assert.ok(!result.command.includes('admin'));
    assert.ok(!result.command.includes('hunter2'));
});

test('CONFIG SET never exposes the value being set', () => {
    const result = sanitizeCommand(['CONFIG', 'SET', 'requirepass', 'topsecret']);
    // The subcommand survives so the entry is readable; the parameters do not.
    assert.strictEqual(result.command, 'CONFIG SET [REDACTED] [REDACTED]');
    assert.ok(!result.command.includes('topsecret'));
    assert.ok(!result.command.includes('requirepass'));
});

test('ACL SETUSER never exposes credentials', () => {
    const result = sanitizeCommand(['ACL', 'SETUSER', 'alice', 'on', '>s3cr3t', '~*', '+@all']);
    assert.ok(!result.command.includes('s3cr3t'));
    assert.ok(!result.command.includes('alice'));
    assert.strictEqual(result.command.startsWith('ACL SETUSER'), true);
});

test('HELLO with AUTH never exposes the password', () => {
    const result = sanitizeCommand(['HELLO', '3', 'AUTH', 'default', 'hunter2']);
    assert.ok(!result.command.includes('hunter2'));
    assert.ok(!result.command.includes('default'));
});

test('MIGRATE never exposes its AUTH argument', () => {
    const result = sanitizeCommand(['MIGRATE', '10.0.0.2', '6379', 'mykey', '0', '5000', 'AUTH', 'pw']);
    assert.ok(!result.command.includes('pw'));
    // Even the host and key are dropped: MIGRATE is treated as fully sensitive.
    assert.ok(!result.command.includes('10.0.0.2'));
});

test('RESTORE never ships the serialised payload', () => {
    const result = sanitizeCommand(['RESTORE', 'mykey', '0', '\\x00\\xc0\\n\\t\\x00best-payload']);
    assert.ok(!result.command.includes('best-payload'));
});

test('numeric arguments survive because range size is often the diagnosis', () => {
    // `LRANGE queue 0 -1` on a million-element list is the classic slow command;
    // hiding the bounds would remove the reason it was slow.
    const result = sanitizeCommand(['LRANGE', 'queue:jobs', '0', '-1']);
    assert.strictEqual(result.command, 'LRANGE queue:jobs 0 -1');
    assert.strictEqual(result.redactedCount, 0);
});

test('negative and float arguments are recognised as numeric', () => {
    const result = sanitizeCommand(['ZADD', 'scores', '-1.5', 'member-name']);
    assert.ok(result.command.startsWith('ZADD scores -1.5'));
    // The member value is user data and must not survive.
    assert.ok(!result.command.includes('member-name'));
});

test('multi-key commands keep every key because none of them are values', () => {
    const result = sanitizeCommand(['MGET', 'a:1', 'b:2', 'c:3']);
    assert.strictEqual(result.command, 'MGET a:1 b:2 c:3');
    assert.strictEqual(result.redactedCount, 0);
});

test('DEL keeps all keys', () => {
    const result = sanitizeCommand(['DEL', 'session:1', 'session:2']);
    assert.strictEqual(result.command, 'DEL session:1 session:2');
});

test('only the first argument of a normal write command is treated as the key', () => {
    const result = sanitizeCommand(['HSET', 'user:1', 'email', 'a@b.com', 'name', 'Alice']);
    assert.strictEqual(result.command, 'HSET user:1 [REDACTED] [REDACTED] [REDACTED] [REDACTED]');
    assert.ok(!result.command.includes('a@b.com'));
    assert.ok(!result.command.includes('Alice'));
    assert.strictEqual(result.redactedCount, 4);
});

test('an unknown command still has its values redacted', () => {
    // The allow-list shape means a command nobody anticipated defaults to safe.
    const result = sanitizeCommand(['SOMENEWCMD', 'thekey', 'sensitive-payload']);
    assert.strictEqual(result.command, 'SOMENEWCMD thekey [REDACTED]');
    assert.ok(!result.command.includes('sensitive-payload'));
});

test('long keys are truncated rather than shipped whole', () => {
    const longKey = 'k'.repeat(300);
    const result = sanitizeCommand(['GET', longKey]);
    assert.ok(result.command.length < 200);
    assert.ok(result.command.includes('…'));
});

test('argument lists are capped so a huge pipeline cannot bloat the payload', () => {
    const args = ['MGET'];
    for (let i = 0; i < 500; i++) args.push(`key:${i}`);
    const result = sanitizeCommand(args);

    assert.strictEqual(result.truncated, true);
    assert.ok(result.command.includes('more'));
    assert.ok(result.command.length <= 520);
});

test('structural range tokens survive', () => {
    const result = sanitizeCommand(['ZRANGEBYSCORE', 'leaderboard', '(5', '+inf']);
    assert.strictEqual(result.command, 'ZRANGEBYSCORE leaderboard (5 +inf');
});

test('empty and malformed input never throws', () => {
    assert.deepStrictEqual(sanitizeCommand([]), {
        commandName: '', command: '', redactedCount: 0, truncated: false
    });
    assert.deepStrictEqual(sanitizeCommand(null).command, '');
    assert.deepStrictEqual(sanitizeCommand(undefined).command, '');
});

test('the redaction marker is exactly what the UI documents', () => {
    assert.strictEqual(REDACTED, '[REDACTED]');
});
