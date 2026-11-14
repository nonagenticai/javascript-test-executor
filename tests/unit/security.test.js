const { validateCodeSecurity } = require('../../src/js_test_service_advanced');

describe('validateCodeSecurity', () => {
  test('detects require("fs")', () => {
    expect(() => validateCodeSecurity('const fs = require("fs")')).toThrow('Security violation');
  });

  test('detects require(\'fs\')', () => {
    expect(() => validateCodeSecurity("const fs = require('fs')")).toThrow('Security violation');
  });

  test('detects require("child_process")', () => {
    expect(() => validateCodeSecurity('const cp = require("child_process")')).toThrow('Security violation');
  });

  test('detects require(\'child_process\')', () => {
    expect(() => validateCodeSecurity("require('child_process')")).toThrow('Security violation');
  });

  test('detects eval(', () => {
    expect(() => validateCodeSecurity('eval("alert(1)")')).toThrow('Security violation');
  });

  test('detects process.exit', () => {
    expect(() => validateCodeSecurity('process.exit(1)')).toThrow('Security violation');
  });

  test('detects __dirname', () => {
    expect(() => validateCodeSecurity('console.log(__dirname)')).toThrow('Security violation');
  });

  test('detects process.kill', () => {
    expect(() => validateCodeSecurity('process.kill(process.pid)')).toThrow('Security violation');
  });

  test('detects require("net")', () => {
    expect(() => validateCodeSecurity('require("net")')).toThrow('Security violation');
  });

  test('detects require("http")', () => {
    expect(() => validateCodeSecurity('require("http")')).toThrow('Security violation');
  });

  test('detects Function()', () => {
    expect(() => validateCodeSecurity('new Function("return 1")')).toThrow('Security violation');
  });

  test('detects require.resolve', () => {
    expect(() => validateCodeSecurity('require.resolve("path")')).toThrow('Security violation');
  });

  test('clean code passes', () => {
    expect(() => validateCodeSecurity('const x = 1 + 2;\nconsole.log(x);')).not.toThrow();
  });

  test('simple math code passes', () => {
    expect(() => validateCodeSecurity('function add(a, b) { return a + b; }')).not.toThrow();
  });

  test('array operations pass', () => {
    expect(() => validateCodeSecurity('[1,2,3].map(x => x * 2).filter(x => x > 2)')).not.toThrow();
  });
});
