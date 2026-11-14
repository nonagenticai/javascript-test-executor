/**
 * Regression tests for "the API advertised capabilities it could not deliver".
 *
 * Three lies existed before this suite:
 *   1. /frameworks, /info and /health advertised mocha + a custom runner, but
 *      /execute only ever spawned jest.
 *   2. /execute did not even READ req.body.test_framework, so a caller asking
 *      for mocha silently got a jest run and no way to detect the substitution.
 *   3. /info claimed typescript.type_checking:true while the live path only
 *      runs babel-jest, which strips types without checking them.
 *
 * The assertions below are written as INVARIANTS (advertised set === executable
 * set) rather than as checks on the specific strings, so they keep biting if
 * someone re-adds an aspirational entry.
 */
const request = require('supertest');
const child_process = require('child_process');
const path = require('path');
const { app } = require('../../src/js_test_service_advanced');
const pkg = require('../../src/package.json');

jest.mock('child_process');

const PASSING_JEST_RUN = (command, options, callback) => {
  require('fs').writeFileSync(
    path.join(options.cwd, 'results.json'),
    JSON.stringify({ success: true, numTotalTests: 1, numPassedTests: 1, testResults: [] })
  );
  callback(null, 'PASS test.spec.js', '');
};

const BODY = { code: 'const add=(a,b)=>a+b;', test_code: 'test("add", () => expect(add(1,2)).toBe(3));' };

beforeEach(() => {
  child_process.exec.mockReset();
  child_process.exec.mockImplementation(PASSING_JEST_RUN);
});

describe('/execute honours or rejects the requested test_framework', () => {
  test('an unsupported framework is rejected with 400, not silently run as jest', async () => {
    const res = await request(app).post('/execute').send({ ...BODY, test_framework: 'mocha' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'unsupported_test_framework');
    expect(res.body).toHaveProperty('requested', 'mocha');
    expect(res.body.supported_frameworks).toEqual(['jest']);
    expect(res.body.message).toContain('mocha');
    // The decisive part: no runner was spawned at all. Before the fix this
    // request produced a full jest run reported as the caller's mocha result.
    expect(child_process.exec).not.toHaveBeenCalled();
  });

  test.each(['custom', 'vitest', 'ava', 'tap', ''])(
    'framework %p is rejected rather than substituted', async (framework) => {
      const res = await request(app).post('/execute').send({ ...BODY, test_framework: framework });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unsupported_test_framework');
      expect(child_process.exec).not.toHaveBeenCalled();
    });

  test('an explicit test_framework of jest is honoured and runs', async () => {
    const res = await request(app).post('/execute').send({ ...BODY, test_framework: 'jest' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(child_process.exec).toHaveBeenCalledTimes(1);
  });

  test('omitting test_framework still runs jest (no behaviour change for existing callers)', async () => {
    const res = await request(app).post('/execute').send(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(child_process.exec).toHaveBeenCalledTimes(1);
  });

  test('a non-string test_framework is rejected, not coerced', async () => {
    const res = await request(app).post('/execute').send({ ...BODY, test_framework: { name: 'jest' } });
    expect(res.status).toBe(400);
    expect(child_process.exec).not.toHaveBeenCalled();
  });

  test('prototype keys are not mistaken for supported frameworks', async () => {
    const res = await request(app).post('/execute').send({ ...BODY, test_framework: 'constructor' });
    expect(res.status).toBe(400);
    expect(child_process.exec).not.toHaveBeenCalled();
  });
});

describe('advertised frameworks === frameworks /execute will accept', () => {
  test('every framework named by /frameworks is actually accepted by /execute', async () => {
    const advertised = Object.keys((await request(app).get('/frameworks')).body.supported);
    expect(advertised.length).toBeGreaterThan(0);

    for (const framework of advertised) {
      child_process.exec.mockClear();
      const res = await request(app).post('/execute').send({ ...BODY, test_framework: framework });
      expect(res.status).not.toBe(400);
      expect(child_process.exec).toHaveBeenCalledTimes(1);
    }
  });

  test('/frameworks, /info and /health all name the same set', async () => {
    const frameworks = Object.keys((await request(app).get('/frameworks')).body.supported);
    const info = (await request(app).get('/info')).body;
    const health = (await request(app).get('/health')).body;

    expect(info.supported_frameworks).toEqual(frameworks);
    expect(health.capabilities.frameworks).toEqual(frameworks);
    // /info's boolean map must agree with its own list.
    for (const [name, claimed] of Object.entries(info.capabilities.testing_frameworks)) {
      if (typeof claimed !== 'boolean') continue;
      expect(claimed).toBe(frameworks.includes(name));
    }
  });
});

describe('/info does not claim type checking that nothing performs', () => {
  test('type_checking is false because the live path only transpiles via babel', async () => {
    const res = await request(app).get('/info');
    expect(res.body.capabilities.typescript.type_checking).toBe(false);
    expect(res.body.features).not.toContain('type_checking');
  });

  test('typescript is still transpiled and advertised as such', async () => {
    const res = await request(app).get('/info');
    expect(res.body.capabilities.typescript.compilation).toBe(true);
    expect(res.body.supported_languages).toContain('typescript');
    expect(res.body.features).toContain('typescript_transpilation');
  });
});

describe('version is not hardcoded away from package.json', () => {
  test('/info and /health report the shipped package version', async () => {
    expect((await request(app).get('/info')).body.version).toBe(pkg.version);
    expect((await request(app).get('/health')).body.version).toBe(pkg.version);
    // Guard the specific drift that existed: a literal '3.0.0' against a 1.0.0 package.
    expect(pkg.version).not.toBe('3.0.0');
  });
});

describe('the dead mocha/custom/tsc execution path is gone, not merely unadvertised', () => {
  test('module no longer exports the unreachable framework dispatcher or its helpers', () => {
    const mod = require('../../src/js_test_service_advanced');
    for (const gone of ['executeTestWithFramework', 'continueTestExecution', 'createMochaConfig',
                        'createCustomTestRunner', 'compileTypeScript', 'installDependencies',
                        'TYPESCRIPT_CONFIGS']) {
      expect(mod).not.toHaveProperty(gone);
    }
  });
});
