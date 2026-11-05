import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Use the same kernel flock as older controllers. Keeping the pipe open holds the
// lock for one operation; kernel cleanup and pipe EOF also work after SIGKILL.
export async function withReleaseLock(instance, operation, lockFile = 'release.lock') {
  const file = join(instance, '.local', lockFile);
  const holder = [process.execPath, '-e', 'process.stdout.write("locked\\n");process.stdin.resume()'];
  const bsd = ['darwin', 'freebsd', 'openbsd', 'netbsd', 'dragonfly'].includes(process.platform);
  const child = spawn(
    bsd ? 'lockf' : 'flock',
    bsd ? ['-kst', '0', file, ...holder] : ['-n', '-E', '75', file, ...holder],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  let stderr = '',
    held = false;
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr = (stderr + data).slice(-500);
  });
  const closed = new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', (code) => {
      // Continuing an operation after losing its lock would corrupt the journal.
      if (held) process.exit(75);
      done(code);
    });
  });
  try {
    await Promise.race([
      new Promise((done) => child.stdout.once('data', done)),
      closed.then((code) => {
        throw new Error(
          code === 75
            ? 'Another release operation owns this instance'
            : 'Release lock failed: ' + (stderr.trim() || code)
        );
      })
    ]);
    held = true;
    return await operation();
  } finally {
    held = false;
    child.stdin.end();
    await closed;
  }
}
