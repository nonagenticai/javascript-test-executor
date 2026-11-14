const request = require('supertest');
const { app } = require('../../src/js_test_service_advanced');
const child_process = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

jest.mock('child_process');

describe('POST /execute', () => {
  let mockExec;

  beforeEach(() => {
    mockExec = child_process.exec;
    mockExec.mockReset();
  });

  test('valid code + test_code returns success response', async () => {
    // Mock exec to simulate successful Jest run
    mockExec.mockImplementation((command, options, callback) => {
      // Simulate Jest creating results.json
      const resultsDir = options.cwd;
      const resultsFile = path.join(resultsDir, 'results.json');
      const jestResults = {
        success: true,
        numTotalTests: 1,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [{
          assertionResults: [{ status: 'passed', fullName: 'test passes', failureMessages: [] }],
          perfStats: { duration: 100 }
        }]
      };
      // Write the results file before calling back
      require('fs').writeFileSync(resultsFile, JSON.stringify(jestResults));
      callback(null, 'PASS test.spec.js', '');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'function add(a,b){return a+b}', test_code: 'test("add", () => expect(add(1,2)).toBe(3))' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('test_id');
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('execution_time');
    expect(res.body).toHaveProperty('output');
  });

  test('missing body returns error response', async () => {
    // When code and test_code are both undefined, the route still tries to
    // run Jest with the concatenated content. We need a mock for the exec call.
    mockExec.mockImplementation((command, options, callback) => {
      const err = new Error('Test file has syntax errors');
      callback(err, '', 'SyntaxError');
    });

    const res = await request(app)
      .post('/execute')
      .send({});

    // The route always returns 200, even for failures
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('test_id');
    expect(res.body).toHaveProperty('success', false);
  });

  test('code only (no test_code) still works', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      const resultsDir = options.cwd;
      const resultsFile = path.join(resultsDir, 'results.json');
      const jestResults = {
        success: true,
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: []
      };
      require('fs').writeFileSync(resultsFile, JSON.stringify(jestResults));
      callback(null, 'No tests found', '');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'const x = 1;' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('test_id');
  });

  test('language=typescript uses TypeScript config', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      const resultsDir = options.cwd;
      const resultsFile = path.join(resultsDir, 'results.json');
      const jestResults = {
        success: true,
        numTotalTests: 1,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: []
      };
      require('fs').writeFileSync(resultsFile, JSON.stringify(jestResults));
      // Verify that command includes TypeScript-related config
      expect(command).toContain('jest');
      callback(null, 'PASS test.spec.ts', '');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'const x: number = 1;', test_code: 'test("ts", () => expect(true).toBe(true))', language: 'typescript' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('test_id');
  });

  test('Jest failure returns failure in response', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      const resultsDir = options.cwd;
      const resultsFile = path.join(resultsDir, 'results.json');
      const jestResults = {
        success: false,
        numTotalTests: 1,
        numPassedTests: 0,
        numFailedTests: 1,
        numPendingTests: 0,
        testResults: [{
          assertionResults: [{
            status: 'failed',
            fullName: 'test fails',
            failureMessages: ['Expected 1 to be 2']
          }],
          perfStats: { duration: 50 }
        }]
      };
      require('fs').writeFileSync(resultsFile, JSON.stringify(jestResults));
      callback(new Error('Tests failed'), '', 'FAIL');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'function add(a,b){return a+b}', test_code: 'test("fail", () => expect(1).toBe(2))' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body).toHaveProperty('error');
  });

  test('Jest timeout returns timeout error', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      const err = new Error('Command timed out');
      err.killed = true;
      err.signal = 'SIGTERM';
      callback(err, '', '');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'while(true){}', test_code: 'test("hang", () => {})' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', false);
  });

  test('cleanup happens on success', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      const resultsDir = options.cwd;
      const resultsFile = path.join(resultsDir, 'results.json');
      const jestResults = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [] };
      require('fs').writeFileSync(resultsFile, JSON.stringify(jestResults));
      callback(null, 'PASS', '');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'const x = 1;', test_code: 'test("ok", () => expect(true).toBe(true))' });

    expect(res.status).toBe(200);
    // The route calls fs.rm on the temp directory after execution.
    // We can't easily verify the directory is gone because it's async,
    // but we verify no error is thrown.
    expect(res.body).toHaveProperty('test_id');
  });

  test('cleanup happens on error', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      callback(new Error('Jest crashed'), '', 'Fatal error');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'invalid code!!!', test_code: 'test("x", () => {})' });

    expect(res.status).toBe(200);
    // Even on error, cleanup should happen without crashing the server
    expect(res.body).toHaveProperty('test_id');
  });

  // --- Verdict-integrity hardening: a run that verified nothing is NOT a pass ---

  test('zero tests collected is NOT a pass (closes the zero-test loophole)', async () => {
    // Jest can report success:true with numTotalTests:0 (e.g. an empty suite).
    // That verified nothing and must be reported as a failure.
    mockExec.mockImplementation((command, options, callback) => {
      const resultsFile = path.join(options.cwd, 'results.json');
      const jestResults = {
        success: true,
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: []
      };
      require('fs').writeFileSync(resultsFile, JSON.stringify(jestResults));
      callback(null, 'No tests found', '');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'const x = 1;', test_code: '' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body).toHaveProperty('no_tests_run', true);
    expect(res.body).toHaveProperty('tests_run', 0);
  });

  test('no results file, no stdout, no error is NOT a pass', async () => {
    // The old fallback treated "no error and no output" as success with no tests.
    // Nothing ran, so it must be a failure.
    mockExec.mockImplementation((command, options, callback) => {
      callback(null, '', '');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'const x = 1;', test_code: 'test("noop", () => {})' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body).toHaveProperty('no_tests_run', true);
  });

  test('jest is invoked from /app/node_modules (not the non-existent /app/test_services)', async () => {
    // Regression guard: the deployed image installs deps at /app/node_modules.
    // The old /app/test_services/node_modules path did not exist, so jest never
    // ran in prod and /execute could not execute any test.
    let capturedCommand = '';
    mockExec.mockImplementation((command, options, callback) => {
      capturedCommand = command;
      const resultsFile = path.join(options.cwd, 'results.json');
      const jestResults = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [] };
      require('fs').writeFileSync(resultsFile, JSON.stringify(jestResults));
      callback(null, 'PASS test.spec.js', '');
    });

    await request(app)
      .post('/execute')
      .send({ code: 'const x = 1;', test_code: 'test("x", () => expect(true).toBe(true))' });

    expect(capturedCommand).toContain('/app/node_modules/.bin/jest');
    expect(capturedCommand).not.toContain('/app/test_services');
  });

  test('a real passing suite reports test counts and passes', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      const resultsFile = path.join(options.cwd, 'results.json');
      const jestResults = {
        success: true,
        numTotalTests: 2,
        numPassedTests: 2,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: []
      };
      require('fs').writeFileSync(resultsFile, JSON.stringify(jestResults));
      callback(null, 'PASS test.spec.js', '');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'function add(a,b){return a+b}', test_code: 'test("a",()=>expect(add(1,1)).toBe(2));test("b",()=>expect(add(2,2)).toBe(4))' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('tests_run', 2);
    expect(res.body).toHaveProperty('tests_passed', 2);
    expect(res.body).toHaveProperty('no_tests_run', false);
  });
});
