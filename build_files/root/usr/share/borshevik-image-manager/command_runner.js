// Command execution with optional pkexec and live output.
// Uses chunk-based reading (read_bytes_async) for real-time output including
// carriage-return progress updates from tools like rpm-ostree.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function _prependPkexec(argv) {
  return ['pkexec', ...argv];
}

export class CommandRunner {
  constructor({ onStdout, onStderr, onExit } = {}) {
    this._onStdout = onStdout || (() => { });
    this._onStderr = onStderr || (() => { });
    this._onExit = onExit || (() => { });
  }

  async run(argv, { root = false } = {}) {
    const finalArgv = root ? _prependPkexec(argv) : argv;

    const proc = new Gio.Subprocess({
      argv: finalArgv,
      flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    });
    proc.init(null);

    const stdout = proc.get_stdout_pipe();
    const stderr = proc.get_stderr_pipe();

    // Each stream gets its own decoder so that multi-byte UTF-8 characters
    // split across chunk boundaries are handled correctly.
    const stdoutDecoder = new TextDecoder('utf-8', { fatal: false });
    const stderrDecoder = new TextDecoder('utf-8', { fatal: false });

    // Read raw byte chunks instead of lines. This delivers partial output
    // immediately, including mid-line \r progress updates from rpm-ostree.
    const readChunk = (stream, size) => new Promise((resolve, reject) => {
      stream.read_bytes_async(size, GLib.PRIORITY_DEFAULT, null, (s, res) => {
        try {
          const gbytes = s.read_bytes_finish(res);
          resolve(gbytes);
        } catch (e) {
          reject(e);
        }
      });
    });

    const readLoop = async (stream, dec, cb) => {
      while (true) {
        let gbytes;
        try {
          gbytes = await readChunk(stream, 4096);
        } catch (_e) {
          break;
        }
        if (gbytes === null || gbytes.get_size() === 0) break;
        try {
          cb(dec.decode(gbytes.get_data(), { stream: true }));
        } catch (_e) {
          // Ignore consumer errors to keep draining the stream.
        }
      }
      // Flush any remaining bytes in the decoder's internal buffer.
      try {
        const tail = dec.decode(new Uint8Array(), { stream: false });
        if (tail) cb(tail);
      } catch (_e) { /* ignore */ }
    };

    // Read both streams concurrently.
    const p1 = readLoop(stdout, stdoutDecoder, this._onStdout);
    const p2 = readLoop(stderr, stderrDecoder, this._onStderr);

    // NOTE: We intentionally do NOT rely on GJS' implicit promisification for
    // Gio.Subprocess.wait_async(). In practice it may resolve before the child
    // has fully transitioned to an exited state, which makes get_exit_status()
    // trigger: g_subprocess_get_exit_status: assertion 'pid == 0' failed.
    // Wrapping the async/finish pair explicitly avoids that race.
    const waitForExit = () => new Promise((resolve, reject) => {
      proc.wait_async(null, (p, res) => {
        try {
          p.wait_finish(res);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    let success = false;
    let status = 1;

    try {
      await waitForExit();
      success = proc.get_successful();
      status = proc.get_exit_status();
    } catch (_e) {
      // Process may have been killed or failed to launch.
      success = false;
    }

    // Drain remaining stream data BEFORE signaling completion.
    await Promise.allSettled([p1, p2]);

    // Re-read status after streams are fully drained (safe now).
    // Re-derive success too, so they stay consistent.
    try {
      status = proc.get_exit_status();
      success = proc.get_successful();
    } catch (_) {
      status = 1;
      success = false;
    }

    this._onExit({ success, status });
    return { success, status };
  }
}
