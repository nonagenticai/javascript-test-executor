/**
 * Additional tests for /execute route branches that aren't covered by the main execute.test.js.
 * Covers: stdout fallback parsing, no output case, results file parse error, server error (500).
 */
const request = require('supertest');
const { app } = require('../../src/js_test_service_advanced');
const child_process = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

jest.mock('child_process');

describe('POST /execute additional branches', () => {
  let mockExec;

  beforeEach(() => {
    mockExec = child_process.exec;
    mockExec.mockReset();
  });

  test('falls back to stdout parsing when results.json does not exist', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      // Do NOT create a results.json file, but return stdout with PASS
      callback(null, 'PASS test.spec.js\nTests: 1 passed, 1 total', '');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'const x = 1;', test_code: 'test("x", () => expect(true).toBe(true))' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.output).toContain('PASS');
  });

  test('no error and no output is a failure (nothing ran, nothing verified)', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      callback(null, '', '');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'const x = 1;', test_code: 'test("x", () => {})' });

    expect(res.status).toBe(200);
    // Verdict-integrity: a run with no results, no stdout and no error collected
    // zero tests and must NOT be reported as a pass.
    expect(res.body.success).toBe(false);
    expect(res.body.no_tests_run).toBe(true);
  });

  test('results.json with parse error falls back to stdout', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      const resultsDir = options.cwd;
      const resultsFile = path.join(resultsDir, 'results.json');
      // Write invalid JSON to results.json
      fsSync.writeFileSync(resultsFile, 'NOT VALID JSON {{{');
      callback(null, 'PASS all tests', '');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'const x = 1;', test_code: 'test("x", () => expect(1).toBe(1))' });

    expect(res.status).toBe(200);
    // Falls back to the output from the catch block
    expect(res.body).toHaveProperty('test_id');
  });

  test('stdout without PASS when there is an error results in failure', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      // No results.json, stdout has content but no PASS, error present
      callback(new Error('exit code 1'), 'FAIL test.spec.js\nExpected 1 to be 2', '');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'const x = 1;', test_code: 'test("x", () => expect(1).toBe(2))' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
  });

  test('server error (500) path when fs operations fail', async () => {
    // Mock fs.mkdir to throw (simulating filesystem failure)
    const originalMkdir = fs.mkdir;
    const mockMkdir = jest.spyOn(require('fs').promises, 'mkdir');
    mockMkdir.mockRejectedValueOnce(new Error('Filesystem full'));

    const res = await request(app)
      .post('/execute')
      .send({ code: 'const x = 1;', test_code: 'test("x", () => {})' });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
    expect(res.body.success).toBe(false);

    mockMkdir.mockRestore();
  });
});
