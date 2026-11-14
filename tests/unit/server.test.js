const { app, startServer, executeCommand, log } = require('../../src/js_test_service_advanced');
const child_process = require('child_process');

jest.mock('child_process');

describe('executeCommand', () => {
  let mockExec;

  beforeEach(() => {
    mockExec = child_process.exec;
    mockExec.mockReset();
  });

  test('resolves with success on no error', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      callback(null, 'output', '');
    });

    const result = await executeCommand('echo hello', { cwd: '/tmp' });
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('output');
  });

  test('resolves with success:false on error', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      const err = new Error('command failed');
      callback(err, '', 'error output');
    });

    const result = await executeCommand('bad-cmd', { cwd: '/tmp' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('command failed');
    expect(result.stderr).toBe('error output');
  });
});

describe('log utility', () => {
  test('log.info is a function', () => {
    expect(typeof log.info).toBe('function');
  });

  test('log.error is a function', () => {
    expect(typeof log.error).toBe('function');
  });

  test('log.warn is a function', () => {
    expect(typeof log.warn).toBe('function');
  });

  test('log.debug is a function', () => {
    expect(typeof log.debug).toBe('function');
  });
});

describe('startServer', () => {
  test('is a function', () => {
    expect(typeof startServer).toBe('function');
  });
});

describe('error handling middleware', () => {
  const request = require('supertest');

  test('404 for unknown route returns JSON', async () => {
    const res = await request(app).get('/totally-unknown-path-xyz');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  test('404 for DELETE on known route', async () => {
    const res = await request(app).delete('/health');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});
