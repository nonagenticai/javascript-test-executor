const { generateTestId, createTempDir, cleanup, runCommand } = require('../../src/js_test_service_advanced');
const child_process = require('child_process');
const fs = require('fs').promises;
const path = require('path');

jest.mock('child_process');

describe('generateTestId', () => {
  test('returns a hex string', () => {
    const id = generateTestId();
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[a-f0-9]+$/);
  });

  test('returns 32-character hex string (16 bytes)', () => {
    const id = generateTestId();
    expect(id).toHaveLength(32);
  });

  test('generates unique IDs', () => {
    const id1 = generateTestId();
    const id2 = generateTestId();
    expect(id1).not.toBe(id2);
  });
});

describe('createTempDir', () => {
  test('creates directory and returns path', async () => {
    const testId = 'test-create-dir-' + Date.now();
    const tempPath = await createTempDir(testId);
    expect(typeof tempPath).toBe('string');
    expect(tempPath).toContain(testId);
    // Check that directory exists
    const stat = await fs.stat(tempPath);
    expect(stat.isDirectory()).toBe(true);
    // Cleanup
    await fs.rm(tempPath, { recursive: true, force: true });
  });
});

describe('cleanup', () => {
  test('removes directory', async () => {
    const testDir = path.join('/tmp', 'cleanup-test-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(path.join(testDir, 'file.txt'), 'test');

    await cleanup(testDir);

    // Directory should be gone
    await expect(fs.stat(testDir)).rejects.toThrow();
  });

  test('handles missing directory without throwing', async () => {
    const nonExistentDir = path.join('/tmp', 'does-not-exist-' + Date.now());
    // Should not throw
    await expect(cleanup(nonExistentDir)).resolves.toBeUndefined();
  });
});

describe('runCommand', () => {
  let mockSpawn;

  beforeEach(() => {
    mockSpawn = child_process.spawn;
    mockSpawn.mockReset();
  });

  function createMockProcess({ stdout = '', stderr = '', exitCode = 0, errorEvent = null }) {
    const proc = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
      killed: false,
    };

    // When spawn is called, set up event handlers and fire them
    mockSpawn.mockReturnValue(proc);

    // After the function is called, we need to trigger events
    // Use process.nextTick to ensure the event handlers are registered first
    setTimeout(() => {
      // Fire stdout data
      if (stdout) {
        const stdoutHandler = proc.stdout.on.mock.calls.find(c => c[0] === 'data');
        if (stdoutHandler) stdoutHandler[1](Buffer.from(stdout));
      }

      // Fire stderr data
      if (stderr) {
        const stderrHandler = proc.stderr.on.mock.calls.find(c => c[0] === 'data');
        if (stderrHandler) stderrHandler[1](Buffer.from(stderr));
      }

      if (errorEvent) {
        const errorHandler = proc.on.mock.calls.find(c => c[0] === 'error');
        if (errorHandler) errorHandler[1](errorEvent);
      } else {
        // Fire close event
        const closeHandler = proc.on.mock.calls.find(c => c[0] === 'close');
        if (closeHandler) closeHandler[1](exitCode, null);
      }
    }, 10);

    return proc;
  }

  test('captures stdout and stderr', async () => {
    createMockProcess({ stdout: 'hello world', stderr: 'some warning', exitCode: 0 });

    const result = await runCommand(['echo', 'hello'], '/tmp', 5000);

    expect(result.success).toBe(true);
    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('some warning');
    expect(result.exitCode).toBe(0);
  });

  test('handles non-zero exit code', async () => {
    createMockProcess({ stdout: '', stderr: 'error occurred', exitCode: 1 });

    const result = await runCommand(['false'], '/tmp', 5000);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  test('handles spawn error', async () => {
    createMockProcess({ errorEvent: new Error('spawn ENOENT') });

    const result = await runCommand(['nonexistent-cmd'], '/tmp', 5000);

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('spawn ENOENT');
  });

  test('handles timeout by killing process', async () => {
    // Use a very short timeout and a process that never closes
    const proc = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(() => { proc.killed = true; }),
      killed: false,
    };
    mockSpawn.mockReturnValue(proc);

    // Start the command with very short timeout
    const resultPromise = runCommand(['sleep', '100'], '/tmp', 50);

    // Wait for timeout to trigger, then fire close
    await new Promise(resolve => setTimeout(resolve, 100));

    // The timeout should have called kill
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    // Now fire the close event
    const closeHandler = proc.on.mock.calls.find(c => c[0] === 'close');
    if (closeHandler) closeHandler[1](null, 'SIGTERM');

    const result = await resultPromise;
    expect(result.killed).toBe(true);
    expect(result.success).toBe(false);
  });
});
