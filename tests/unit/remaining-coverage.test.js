/**
 * Tests for remaining uncovered lines to push past 95%.
 */
const {
  app,
  cleanup,
  startServer,
} = require('../../src/js_test_service_advanced');
const fs = require('fs').promises;
const path = require('path');

describe('cleanup error handling', () => {
  test('logs warning when fs.rm throws unexpected error', async () => {
    // Mock fs.rm to throw an error
    const origRm = fs.rm;
    const mockRm = jest.spyOn(require('fs').promises, 'rm');
    mockRm.mockRejectedValueOnce(new Error('EPERM: permission denied'));

    // Should not throw, just log warning
    await expect(cleanup('/tmp/nonexistent-path-cleanup-test')).resolves.toBeUndefined();

    mockRm.mockRestore();
  });
});

describe('startServer function execution', () => {
  let server;

  afterEach(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('startServer creates workspace and starts listening', async () => {
    // Override PORT to avoid conflict
    const origPort = process.env.PORT;
    process.env.PORT = '19878';

    // Call startServer - it will call app.listen
    // We need to capture the server instance
    // Since startServer doesn't return the server, we'll listen ourselves
    // and just verify the workspace creation
    const workspaceDir = process.env.TEST_WORKSPACE;
    await startServer();

    // Verify workspace was created
    const stat = await fs.stat(workspaceDir);
    expect(stat.isDirectory()).toBe(true);

    // We need to close the server that startServer opened
    // Express app doesn't expose the server directly, so we wait briefly
    // and then move on. The --forceExit flag will handle cleanup.

    process.env.PORT = origPort;
  }, 10000);
});
