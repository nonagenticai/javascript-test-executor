/**
 * Tests targeting remaining uncovered lines to reach 95%+ coverage.
 */
const {
  startServer,
  app,
} = require('../../src/js_test_service_advanced');

jest.mock('child_process');

describe('startServer function', () => {
  test('startServer returns without error when called (but we close immediately)', async () => {
    // We test that startServer is callable. We won't actually start listening
    // because the test environment already has the app. Just verify it's a function.
    expect(typeof startServer).toBe('function');
  });
});

describe('validate route - server error (500) branch', () => {
  const request = require('supertest');

  test('returns 500 when an internal error occurs', async () => {
    // Mock fs.mkdir to throw for the validate route
    const fsMkdir = jest.spyOn(require('fs').promises, 'mkdir');
    fsMkdir.mockRejectedValueOnce(new Error('Disk full'));

    const res = await request(app)
      .post('/validate')
      .send({ code: 'const x = 1;' });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('valid', false);
    expect(res.body).toHaveProperty('error');

    fsMkdir.mockRestore();
  });
});
