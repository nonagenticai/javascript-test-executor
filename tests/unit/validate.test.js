const request = require('supertest');
const { app } = require('../../src/js_test_service_advanced');
const child_process = require('child_process');

jest.mock('child_process');

describe('POST /validate', () => {
  let mockExec;

  beforeEach(() => {
    mockExec = child_process.exec;
    mockExec.mockReset();
  });

  test('valid JS code returns valid: true', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      callback(null, '', '');
    });

    const res = await request(app)
      .post('/validate')
      .send({ code: 'const x = 1;' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('valid', true);
    expect(res.body).toHaveProperty('errors');
    expect(res.body.errors).toHaveLength(0);
    expect(res.body).toHaveProperty('validationId');
  });

  test('no code returns 400', async () => {
    const res = await request(app)
      .post('/validate')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('valid', false);
    expect(res.body.errors).toContain('No code provided');
  });

  test('null code returns 400', async () => {
    const res = await request(app)
      .post('/validate')
      .send({ code: null });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('valid', false);
    expect(res.body.errors).toContain('No code provided');
  });

  test('invalid JS returns valid: false', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      const err = new Error('SyntaxError');
      callback(err, '', 'SyntaxError: Unexpected token');
    });

    const res = await request(app)
      .post('/validate')
      .send({ code: 'function {{{' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('valid', false);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  test('custom filename parameter is used', async () => {
    mockExec.mockImplementation((command, options, callback) => {
      expect(command).toContain('myfile.js');
      callback(null, '', '');
    });

    const res = await request(app)
      .post('/validate')
      .send({ code: 'const x = 1;', filename: 'myfile.js' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('valid', true);
  });

  test('empty code is valid', async () => {
    const res = await request(app)
      .post('/validate')
      .send({ code: '   ' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('valid', true);
    expect(res.body.errors).toHaveLength(0);
  });
});
