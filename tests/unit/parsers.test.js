const { formatJestResults } = require('../../src/js_test_service_advanced');

describe('formatJestResults', () => {
  test('null input returns "No test results available"', () => {
    const result = formatJestResults(null);
    expect(result).toBe('No test results available');
  });

  test('undefined input returns "No test results available"', () => {
    const result = formatJestResults(undefined);
    expect(result).toBe('No test results available');
  });

  test('valid results show pass/fail counts', () => {
    const jestResults = {
      numTotalTests: 5,
      numPassedTests: 3,
      numFailedTests: 2,
      numPendingTests: 0,
      testResults: [{
        perfStats: { duration: 150 },
        assertionResults: []
      }]
    };

    const output = formatJestResults(jestResults);
    expect(output).toContain('Tests: 5 total');
    expect(output).toContain('Passed: 3');
    expect(output).toContain('Failed: 2');
    expect(output).toContain('Skipped: 0');
    expect(output).toContain('150ms');
  });

  test('results with assertion details', () => {
    const jestResults = {
      numTotalTests: 2,
      numPassedTests: 1,
      numFailedTests: 1,
      numPendingTests: 0,
      testResults: [{
        perfStats: { duration: 200 },
        assertionResults: [
          { status: 'passed', fullName: 'adds numbers correctly', failureMessages: [] },
          { status: 'failed', fullName: 'subtracts numbers', failureMessages: ['Expected 3 but got 5'] }
        ]
      }]
    };

    const output = formatJestResults(jestResults);
    expect(output).toContain('Test Details:');
    expect(output).toContain('adds numbers correctly');
    expect(output).toContain('subtracts numbers');
  });

  test('results with failure messages', () => {
    const jestResults = {
      numTotalTests: 1,
      numPassedTests: 0,
      numFailedTests: 1,
      numPendingTests: 0,
      testResults: [{
        perfStats: { duration: 50 },
        assertionResults: [
          {
            status: 'failed',
            fullName: 'broken test',
            failureMessages: ['TypeError: Cannot read property of undefined']
          }
        ]
      }]
    };

    const output = formatJestResults(jestResults);
    expect(output).toContain('Error: TypeError: Cannot read property of undefined');
  });

  test('results with no testResults array', () => {
    const jestResults = {
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
    };

    const output = formatJestResults(jestResults);
    expect(output).toContain('Tests: 0 total');
    expect(output).toContain('Passed: 0');
    expect(output).toContain('Failed: 0');
    // Should not contain Test Details since no testResults
    expect(output).not.toContain('Test Details:');
  });

  test('results with empty assertionResults', () => {
    const jestResults = {
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: [{
        perfStats: { duration: 10 },
      }]
    };

    const output = formatJestResults(jestResults);
    expect(output).toContain('Tests: 0 total');
    // No assertion results means no details section
    expect(output).not.toContain('Test Details:');
  });

  test('results use title when fullName is missing', () => {
    const jestResults = {
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: [{
        perfStats: { duration: 30 },
        assertionResults: [
          { status: 'passed', title: 'should work', failureMessages: [] }
        ]
      }]
    };

    const output = formatJestResults(jestResults);
    expect(output).toContain('should work');
  });
});
