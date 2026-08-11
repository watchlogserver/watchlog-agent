// sanitize.js — redacts Redis command arguments before they leave the customer's
// server.
//
// SLOWLOG entries contain the literal arguments of real production commands:
// passwords from AUTH, tokens from SET, session payloads, personal data. None of
// that may reach Watchlog's storage, so redaction happens here on the agent —
// the earliest possible point — rather than downstream.
//
// The rule is allow-list shaped, not deny-list shaped: an argument is redacted
// unless there is a positive reason to keep it. A deny-list of "sensitive
// commands" would leak every command nobody thought of.
//
// What survives redaction is chosen to keep the slowlog diagnostic:
//   * the command name, always — you need to know what was slow
//   * numeric arguments, always — `LRANGE mylist 0 -1` versus
//     `LRANGE mylist 0 500000` is frequently the entire diagnosis, and a bare
//     number carries no secret
//   * the key, for most commands — knowing *which* key was slow is the point
// Everything else becomes [REDACTED].

'use strict';

const REDACTED = '[REDACTED]';

// Commands where even the "key" position is a credential or otherwise unsafe.
// Nothing but the command (and subcommand) survives.
const FULLY_SENSITIVE = new Set([
    'AUTH',
    'HELLO',        // HELLO 3 AUTH <user> <pass>
    'MIGRATE',      // MIGRATE host port key db timeout AUTH <pass>
    'CONFIG',       // CONFIG SET requirepass <pass>
    'ACL',          // ACL SETUSER <user> >password
    'RESTORE',      // serialised value payload
    'RESTORE-ASKING'
]);

// Container commands whose second token is a subcommand, not data. Keeping it
// makes the entry readable (`CLIENT KILL` rather than a bare `CLIENT`).
const CONTAINER_COMMANDS = new Set([
    'ACL', 'CLIENT', 'CLUSTER', 'COMMAND', 'CONFIG', 'FUNCTION', 'LATENCY',
    'MEMORY', 'OBJECT', 'PUBSUB', 'SCRIPT', 'SLOWLOG', 'XGROUP', 'XINFO'
]);

// Commands whose arguments are *all* keys — no values are ever present, so
// keeping them is safe and makes a slow multi-key command interpretable.
const ALL_ARGS_ARE_KEYS = new Set([
    'DEL', 'UNLINK', 'EXISTS', 'TOUCH', 'MGET', 'WATCH', 'TYPE', 'TTL', 'PTTL',
    'PERSIST', 'DUMP', 'SUNION', 'SINTER', 'SDIFF', 'SUNIONSTORE', 'SINTERSTORE',
    'SDIFFSTORE', 'PFCOUNT', 'PFMERGE', 'RENAME', 'RENAMENX', 'COPY', 'SMOVE',
    'ZUNIONSTORE', 'ZINTERSTORE', 'ZDIFFSTORE', 'LMOVE', 'RPOPLPUSH', 'LCS'
]);

const MAX_KEY_LENGTH = 96;
const MAX_ARGS = 24;
const MAX_RENDERED_LENGTH = 512;

function isNumericArgument(value) {
    // Covers integers, floats, negatives and Redis's -1/+inf range bounds.
    return /^[+-]?(\d+(\.\d+)?|inf|infinity)$/i.test(String(value).trim());
}

// Redis range/score syntax such as `(5`, `[a`, `-`, `+`, `*`, `$4`, `>` are
// structural tokens carrying no user data.
function isStructuralToken(value) {
    return /^[-+*$>=<]$|^[([][^\s]{0,32}$|^\$\d+$/.test(String(value).trim());
}

function truncateKey(value) {
    const str = String(value);
    return str.length > MAX_KEY_LENGTH ? `${str.slice(0, MAX_KEY_LENGTH)}…` : str;
}

/**
 * Redacts a Redis command represented as an argument array.
 *
 * @param {string[]} args raw SLOWLOG arguments, args[0] being the command
 * @returns {{commandName: string, command: string, redactedCount: number, truncated: boolean}}
 */
function sanitizeCommand(args) {
    const list = Array.isArray(args) ? args.map((a) => String(a)) : [];

    if (list.length === 0) {
        return { commandName: '', command: '', redactedCount: 0, truncated: false };
    }

    const commandName = String(list[0]).toUpperCase();
    const out = [commandName];
    let redactedCount = 0;

    const isContainer = CONTAINER_COMMANDS.has(commandName);
    const subcommand = isContainer && list.length > 1 ? String(list[1]).toUpperCase() : '';
    if (subcommand) out.push(subcommand);

    const rest = list.slice(subcommand ? 2 : 1);
    const truncated = rest.length > MAX_ARGS;
    const considered = truncated ? rest.slice(0, MAX_ARGS) : rest;

    // How many non-numeric arguments may be preserved as keys.
    let keyBudget;
    if (FULLY_SENSITIVE.has(commandName)) {
        keyBudget = 0;
    } else if (ALL_ARGS_ARE_KEYS.has(commandName)) {
        keyBudget = Infinity;
    } else {
        keyBudget = 1;
    }

    for (const arg of considered) {
        if (FULLY_SENSITIVE.has(commandName)) {
            out.push(REDACTED);
            redactedCount++;
            continue;
        }
        if (isNumericArgument(arg) || isStructuralToken(arg)) {
            out.push(String(arg));
            continue;
        }
        if (keyBudget > 0) {
            out.push(truncateKey(arg));
            keyBudget--;
            continue;
        }
        out.push(REDACTED);
        redactedCount++;
    }

    if (truncated) out.push(`…+${rest.length - MAX_ARGS} more`);

    let command = out.join(' ');
    if (command.length > MAX_RENDERED_LENGTH) {
        command = `${command.slice(0, MAX_RENDERED_LENGTH)}…`;
    }

    return { commandName, command, redactedCount, truncated };
}

module.exports = {
    sanitizeCommand,
    REDACTED,
    FULLY_SENSITIVE,
    ALL_ARGS_ARE_KEYS,
    CONTAINER_COMMANDS
};
