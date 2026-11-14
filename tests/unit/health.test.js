const request = require('supertest');
const { app } = require('../../src/js_test_service_advanced');
const pkg = require('../../src/package.json');

describe('GET /health', () => {
  test('returns 200 status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  test('response has required fields', async () => {
    const res = await request(app).get('/health');
    const body = res.body;
    expect(body).toHaveProperty('status', 'healthy');
    expect(body).toHaveProperty('service', 'javascript-test-executor-advanced');
    expect(body).toHaveProperty('version', pkg.version);
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('capabilities');
    expect(body).toHaveProperty('runtime');
  });

  // Was: "lists jest, mocha, custom". /execute only ever ran jest, so mocha and
  // custom were advertised capabilities the service could not deliver. Assert the
  // EXACT set rather than membership, so re-adding an unrunnable name fails here.
  test('capabilities.frameworks is exactly the runners /execute can spawn', async () => {
    const res = await request(app).get('/health');
    expect(res.body.capabilities.frameworks).toEqual(['jest']);
  });

  test('does not advertise coverage or build systems it never runs', async () => {
    const res = await request(app).get('/health');
    expect(res.body.capabilities.features.coverage).toBe(false);
    expect(res.body.capabilities.buildSystems).toEqual([]);
  });

  test('runtime.version matches process.version', async () => {
    const res = await request(app).get('/health');
    expect(res.body.runtime.version).toBe(process.version);
  });

  test('runtime includes memory and uptime', async () => {
    const res = await request(app).get('/health');
    expect(res.body.runtime).toHaveProperty('memory');
    expect(res.body.runtime.memory).toHaveProperty('used');
    expect(res.body.runtime.memory).toHaveProperty('total');
    expect(res.body.runtime).toHaveProperty('uptime');
  });
});
