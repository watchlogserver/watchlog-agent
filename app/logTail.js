// Incremental log file reader shared by every part of the agent that follows a
// file on the customer's host.
//
// This is the tailing algorithm that already lived inside log-agent.js, lifted
// out so the Elasticsearch slow-log collector reuses it instead of growing a
// second, subtly different implementation. log-agent.js now delegates here, so
// there is exactly one place that knows how Watchlog follows a file.
//
// What it guarantees:
//   * Bounded reads. At most `maxReadBytes` per call, whatever the file did —
//     a log rotated into by a 2 GB append must not be read into the agent's heap.
//   * Rotation survival. A changed inode or a file that shrank means the file
//     was rotated or truncated; reading resumes from the start of the new file.
//   * No mangled lines. The byte offset only advances past *complete* lines, so
//     a write caught mid-line is re-read on the next pass rather than being
//     split across two events or dropped.
//     (log-agent.js previously advanced the offset past the incomplete tail,
//     which silently lost one line at every 64 KB boundary.)
//   * Start at the end. A newly watched file is seeded at its current size, so
//     enabling a watcher never replays months of history in one burst.

'use strict';

const fs = require('fs');

const DEFAULTS = {
    maxReadBytes: 64 * 1024,
    maxLineLength: 8192,
    // A single read that produced more lines than this is almost certainly a
    // rotation replay or a runaway logger; the excess is dropped and reported.
    maxLinesPerRead: 5000
};

/**
 * Creates an independent tail reader with its own offset table.
 *
 * Separate readers keep separate state, so the Elasticsearch slowlog reader and
 * the log watchlist can follow the same path without fighting over an offset.
 */
function createTailReader(options = {}) {
    const maxReadBytes = Number(options.maxReadBytes) > 0
        ? Number(options.maxReadBytes) : DEFAULTS.maxReadBytes;
    const maxLineLength = Number(options.maxLineLength) > 0
        ? Number(options.maxLineLength) : DEFAULTS.maxLineLength;
    const maxLinesPerRead = Number(options.maxLinesPerRead) > 0
        ? Number(options.maxLinesPerRead) : DEFAULTS.maxLinesPerRead;

    // path → { inode, offset }
    const offsets = new Map();

    /**
     * Positions the reader at the current end of the file without reading it.
     * Call once when a file starts being watched.
     */
    function seek(filePath, position = 'end') {
        try {
            const stats = fs.statSync(filePath);
            offsets.set(filePath, {
                inode: stats.ino,
                offset: position === 'start' ? 0 : stats.size
            });
            return true;
        } catch (err) {
            offsets.set(filePath, { inode: 0, offset: 0 });
            return false;
        }
    }

    function forget(filePath) {
        offsets.delete(filePath);
    }

    function reset() {
        offsets.clear();
    }

    function isTracked(filePath) {
        return offsets.has(filePath);
    }

    /**
     * Reads whatever was appended since the previous call.
     *
     * @returns {{ lines: string[], rotated: boolean, truncatedLines: number,
     *             bytesRead: number, more: boolean, error: string|null }}
     *          `more` is true when the file still has unread bytes beyond this
     *          call's ceiling, so a caller draining a backlog can loop.
     */
    function read(filePath) {
        const result = {
            lines: [], rotated: false, truncatedLines: 0,
            bytesRead: 0, more: false, error: null
        };

        let stats;
        try {
            stats = fs.statSync(filePath);
        } catch (err) {
            result.error = err.code || 'STAT_FAILED';
            return result;
        }

        if (!stats.isFile()) {
            result.error = 'NOT_A_FILE';
            return result;
        }

        let state = offsets.get(filePath);
        if (!state) {
            // First sighting: start at the end so history is not replayed.
            offsets.set(filePath, { inode: stats.ino, offset: stats.size });
            return result;
        }

        // A new inode means the file was rotated out; a smaller size means it was
        // truncated in place. Either way the old offset is meaningless.
        if (state.inode !== stats.ino || stats.size < state.offset) {
            state = { inode: stats.ino, offset: 0 };
            offsets.set(filePath, state);
            result.rotated = true;
        }

        if (state.offset >= stats.size) return result;

        const available = stats.size - state.offset;
        const toRead = Math.min(available, maxReadBytes);
        result.more = available > toRead;

        let fd;
        let buffer;
        try {
            fd = fs.openSync(filePath, 'r');
            buffer = Buffer.allocUnsafe(toRead);
            const bytesRead = fs.readSync(fd, buffer, 0, toRead, state.offset);
            if (bytesRead < toRead) buffer = buffer.subarray(0, bytesRead);
            result.bytesRead = bytesRead;
        } catch (err) {
            result.error = err.code || 'READ_FAILED';
            return result;
        } finally {
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch (e) { /* already closed */ }
            }
        }

        if (!result.bytesRead) return result;

        // Only advance past bytes that end in a newline. The remainder stays
        // unread so the next call sees the whole line.
        const lastNewline = buffer.lastIndexOf(0x0a);

        if (lastNewline === -1) {
            // No complete line in this window. If the window is already at the
            // ceiling the line is pathologically long — skip it rather than
            // stalling on it forever.
            if (result.bytesRead >= maxReadBytes) {
                state.offset += result.bytesRead;
                offsets.set(filePath, state);
                result.truncatedLines++;
            }
            return result;
        }

        const complete = buffer.subarray(0, lastNewline).toString('utf8');
        state.offset += lastNewline + 1;
        offsets.set(filePath, state);

        const rawLines = complete.split('\n');
        for (const raw of rawLines) {
            if (result.lines.length >= maxLinesPerRead) {
                result.truncatedLines += rawLines.length - result.lines.length;
                break;
            }
            // Windows-written logs carry \r; strip it so parsers never have to.
            const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
            if (!line.trim()) continue;
            if (line.length > maxLineLength) {
                result.lines.push(line.slice(0, maxLineLength));
                result.truncatedLines++;
            } else {
                result.lines.push(line);
            }
        }

        return result;
    }

    /**
     * Drains up to `maxPasses` read windows in one go.
     *
     * Used by pull-based callers (the Elasticsearch collector runs on a timer
     * rather than a filesystem watcher) so a minute's worth of slow-log output
     * larger than one window is still collected in that minute.
     */
    function drain(filePath, maxPasses = 8) {
        const lines = [];
        let rotated = false;
        let truncatedLines = 0;
        let bytesRead = 0;
        let error = null;

        for (let pass = 0; pass < maxPasses; pass++) {
            const result = read(filePath);
            if (result.error) { error = result.error; break; }
            rotated = rotated || result.rotated;
            truncatedLines += result.truncatedLines;
            bytesRead += result.bytesRead;
            for (const line of result.lines) lines.push(line);
            if (!result.more) break;
        }

        return { lines, rotated, truncatedLines, bytesRead, error };
    }

    return { read, drain, seek, forget, reset, isTracked, offsets };
}

module.exports = { createTailReader, DEFAULTS };
