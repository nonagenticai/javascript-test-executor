const request = require('supertest');
const { app, SUPPORTED_FRAMEWORKS } = require('../../src/js_test_service_advanced');
const pkg = require('../../src/package.json');

describe('GET /frameworks', () => {
  // Was: asserted supported.mocha and supported.custom existed. /execute has only
  // ever spawned jest, so those keys were the API lying about its own capability.
  // Exact-keys assertion, not membership: adding a name back must fail here.
  test('advertises exactly the frameworks /execute can run', async () => {
    const res = await request(app).get('/frameworks');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('supported');
    expect(Object.keys(res.body.supported)).toEqual(['jest']);
  });

  // Was: default 'custom' — a default that /execute could not honour.
  test('default and recommended are both the only runner that exists', async () => {
    const res = await request(app).get('/frameworks');
    expect(res.body).toHaveProperty('default', 'jest');
    expect(res.body).toHaveProperty('recommended', 'jest');
  });

  test('returns capabilities', async () => {
    const res = await request(app).get('/frameworks');
    expect(res.body).toHaveProperty('capabilities');
    expect(res.body.capabilities.testExecution).toBe(true);
    expect(res.body.capabilities.mocking).toBe(true);
  });

  // Was: coverage/codeCoverage true and multipleFrameworks true. /execute hardcodes
  // collectCoverage:false with no knob, and spawns only jest.
  test('does not claim coverage or multi-framework support', async () => {
    const res = await request(app).get('/frameworks');
    expect(res.body.capabilities.coverage).toBe(false);
    expect(res.body.capabilities.codeCoverage).toBe(false);
    expect(res.body.capabilities.multipleFrameworks).toBe(false);
  });
});

describe('GET /info', () => {
  test('returns service info', async () => {
    const res = await request(app).get('/info');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('service', 'javascript-test-executor-advanced');
    expect(res.body).toHaveProperty('version', pkg.version);
    expect(res.body).toHaveProperty('node_version', process.version);
  });

  test('returns supported languages', async () => {
    const res = await request(app).get('/info');
    expect(res.body.supported_languages).toContain('javascript');
    expect(res.body.supported_languages).toContain('typescript');
  });

  // Was: toContain('mocha') and toContain('custom').
  test('supported_frameworks is exactly what /execute runs', async () => {
    const res = await request(app).get('/info');
    expect(res.body.supported_frameworks).toEqual(['jest']);
  });

  // Was: expected strict/moderate/permissive. Those came from TYPESCRIPT_CONFIGS,
  // which only the deleted tsc path read. /execute uses one fixed Babel transform.
  test('advertises no typescript strictness levels', async () => {
    const res = await request(app).get('/info');
    expect(res.body.typescript_strictness_levels).toEqual([]);
  });

  // Was: expected multiple_test_frameworks + security_validation + the misleading
  // 'typescript_compilation' name. Every removed feature was implemented only in
  // the deleted executeTestWithFramework path.
  test('features list contains no capability the service cannot perform', async () => {
    const res = await request(app).get('/info');
    expect(res.body.features).toContain('typescript_transpilation');
    for (const lie of ['multiple_test_frameworks', 'type_checking', 'security_validation',
                       'dependency_management', 'custom_assertions', 'test_lifecycle_hooks']) {
      expect(res.body.features).not.toContain(lie);
    }
  });

  test('returns capabilities object', async () => {
    const res = await request(app).get('/info');
    expect(res.body.capabilities.typescript.compilation).toBe(true);
    expect(res.body.capabilities.testing_frameworks.jest).toBe(true);
  });

  // Was: type_checking true and testing_frameworks.mocha true. Nothing invokes
  // tsc anywhere on the live path — babel-jest strips types without checking them.
  test('does not claim type checking or non-jest runners', async () => {
    const res = await request(app).get('/info');
    expect(res.body.capabilities.typescript.type_checking).toBe(false);
    expect(res.body.capabilities.typescript.strictness_control).toBe(false);
    expect(res.body.capabilities.testing_frameworks.mocha).toBe(false);
    expect(res.body.capabilities.testing_frameworks.custom).toBe(false);
  });
});

describe('404 handler', () => {
  test('unknown GET route returns 404', async () => {
    const res = await request(app).get('/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'Not found');
    expect(res.body.message).toContain('/nonexistent');
  });

  test('unknown POST route returns 404', async () => {
    const res = await request(app).post('/unknown-endpoint');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'Not found');
  });

  test('404 message includes method and path', async () => {
    const res = await request(app).get('/does/not/exist');
    expect(res.body.message).toContain('GET');
    expect(res.body.message).toContain('/does/not/exist');
  });
});

describe('SUPPORTED_FRAMEWORKS constant', () => {
  test('jest framework has expected structure', () => {
    expect(SUPPORTED_FRAMEWORKS.jest).toHaveProperty('name', 'Jest');
    expect(SUPPORTED_FRAMEWORKS.jest.dependencies).toContain('jest');
    expect(SUPPORTED_FRAMEWORKS.jest.testExtensions).toContain('.test.js');
    expect(SUPPORTED_FRAMEWORKS.jest).toHaveProperty('configFile', 'jest.config.js');
  });

  // Was: two tests asserting mocha and custom entries exist. No code could run
  // either; the entries existed only to be advertised.
  test('holds jest and nothing else', () => {
    expect(Object.keys(SUPPORTED_FRAMEWORKS)).toEqual(['jest']);
  });
});
