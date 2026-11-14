const request = require('supertest');
const { app } = require('../../src/js_test_service_advanced');
const child_process = require('child_process');

jest.mock('child_process');

// These tests pin the input contract of POST /validate: bad caller input must be
// a 400 that names the offending field, and must never reach the filesystem or
// the shell. Before the fix, a non-string `code` produced a 500
// ("code.trim is not a function") and an arbitrary `filename` was both joined
// onto the workspace path and interpolated into `node --check <filename>`.
describe('POST /validate input contract', () => {
  let mockExec;

  beforeEach(() => {
    mockExec = child_process.exec;
    mockExec.mockReset();
    // Default: pretend `node --check` succeeded, so any test that reaches the
    // checker gets a 200 and a test that must NOT reach it fails loudly.
    mockExec.mockImplementation((command, options, callback) => {
      callback(null, '', '');
    });
  });

  describe('code type guard', () => {
    test('object code returns 400 naming the field and the received type', async () => {
      const res = await request(app)
        .post('/validate')
        .send({ code: { some: 'object' } });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('valid', false);
      expect(res.body).toHaveProperty('validationId');
      expect(res.body).toHaveProperty('output', '');
      expect(res.body.errors).toContain('code must be a string, received object');
      expect(mockExec).not.toHaveBeenCalled();
    });

    test('array code returns 400 reported as "array", not "object"', async () => {
      const res = await request(app)
        .post('/validate')
        .send({ code: ['const x = 1;'] });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('valid', false);
      expect(res.body.errors).toContain('code must be a string, received array');
      expect(mockExec).not.toHaveBeenCalled();
    });

    test('number code returns 400 naming the field', async () => {
      const res = await request(app)
        .post('/validate')
        .send({ code: 42 });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('valid', false);
      expect(res.body.errors).toContain('code must be a string, received number');
      expect(mockExec).not.toHaveBeenCalled();
    });

    test('boolean code returns 400 naming the field', async () => {
      const res = await request(app)
        .post('/validate')
        .send({ code: true });

      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('code must be a string, received boolean');
      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  describe('pre-existing missing-code behaviour is unchanged', () => {
    test('missing code still returns the 400 "No code provided" shape', async () => {
      const res = await request(app)
        .post('/validate')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('valid', false);
      expect(res.body).toHaveProperty('output', '');
      expect(res.body.errors).toContain('No code provided');
      expect(mockExec).not.toHaveBeenCalled();
    });

    test('null code still returns "No code provided", not the type-guard error', async () => {
      // typeof null === 'object', so ordering matters: the null branch must win.
      const res = await request(app)
        .post('/validate')
        .send({ code: null });

      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('No code provided');
      expect(res.body.errors).not.toContain('code must be a string, received object');
      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  describe('filename allowlist', () => {
    test('traversing filename returns 400 and never runs the checker', async () => {
      const res = await request(app)
        .post('/validate')
        .send({ code: 'const x = 1;', filename: '../../etc/evil.js' });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('valid', false);
      expect(res.body.errors[0]).toMatch(/filename/);
      expect(mockExec).not.toHaveBeenCalled();
    });

    test('bare ".." filename returns 400', async () => {
      const res = await request(app)
        .post('/validate')
        .send({ code: 'const x = 1;', filename: '..' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0]).toMatch(/filename/);
      expect(mockExec).not.toHaveBeenCalled();
    });

    test('absolute-path filename returns 400', async () => {
      const res = await request(app)
        .post('/validate')
        .send({ code: 'const x = 1;', filename: '/tmp/evil.js' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0]).toMatch(/filename/);
      expect(mockExec).not.toHaveBeenCalled();
    });

    test('filename with a shell metacharacter returns 400', async () => {
      const res = await request(app)
        .post('/validate')
        .send({ code: 'const x = 1;', filename: 'a.js; id' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0]).toMatch(/filename/);
      expect(mockExec).not.toHaveBeenCalled();
    });

    test('filename with command substitution returns 400', async () => {
      const res = await request(app)
        .post('/validate')
        .send({ code: 'const x = 1;', filename: 'a$(id).js' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0]).toMatch(/filename/);
      expect(mockExec).not.toHaveBeenCalled();
    });

    test('non-string filename returns 400', async () => {
      const res = await request(app)
        .post('/validate')
        .send({ code: 'const x = 1;', filename: 123 });

      expect(res.status).toBe(400);
      expect(res.body.errors[0]).toMatch(/filename/);
      expect(mockExec).not.toHaveBeenCalled();
    });

    test('empty filename returns 400', async () => {
      const res = await request(app)
        .post('/validate')
        .send({ code: 'const x = 1;', filename: '' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0]).toMatch(/filename/);
      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  describe('valid requests still reach the checker', () => {
    test('string code with the default filename runs node --check', async () => {
      const res = await request(app)
        .post('/validate')
        .send({ code: 'const x = 1;' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('valid', true);
      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(mockExec.mock.calls[0][0]).toContain('test.js');
    });

    test('an allowlisted custom filename is accepted and used', async () => {
      const res = await request(app)
        .post('/validate')
        .send({ code: 'const x = 1;', filename: 'my-file_1.test.js' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('valid', true);
      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(mockExec.mock.calls[0][0]).toContain('my-file_1.test.js');
    });
  });
});
