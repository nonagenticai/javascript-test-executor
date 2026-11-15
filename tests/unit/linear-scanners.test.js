const {
    validateCodeSecurity,
    containsCryptoCreateHashRequire,
    resolveWithinRoot,
} = require('../../src/js_test_service_advanced');

// The matcher this replaced, kept here only to prove the linear scanner has the
// same accept/reject behaviour. It is js/polynomial-redos on adversarial input,
// which is why production code no longer uses it.
const OLD_CRYPTO_PATTERN = /require\s*\(\s*['"]crypto['"].*\.createHash/i;

describe('crypto CreateHash scan is a linear-pattern-equivalent', () => {
    const cases = [
        'require("crypto").createHash("sha256")',
        "require('crypto').createHash('sha256')",
        'REQUIRE ( "CRYPTO" ).CREATEFHASH("sha256")',
        'xrequire("crypto").createHash("sha256")',
        'require("crypto") .createHash',
        'require("crypto")/* comment */.createHash',
        'require("crypto").createhash("sha256")',
        'require\n(\n"crypto").createHash',
        'require ( "crypto".createHash',
        'require("crypto")\n.createHash',
        'require("crypto")\r.createHash',
        'require("crypto") .createHash',
        'require("crypto") .createHash',
        'require("fs").createHash',
        'require("crypto")',
        '.createHash("sha256")',
        '',
    ];

    test.each(cases)('parity with the old regex: %j', (code) => {
        expect(containsCryptoCreateHashRequire(code)).toBe(OLD_CRYPTO_PATTERN.test(code));
    });

    test('validateCodeSecurity rejects the crypto hash pattern', () => {
        expect(() => validateCodeSecurity('require("crypto").createHash("sha256")'))
            .toThrow('Security violation');
    });

    test('validateCodeSecurity still accepts benign crypto metadata access', () => {
        expect(() => validateCodeSecurity('const name = "crypto";'))
            .not.toThrow();
    });
});

describe('crypto CreateHash scan is linear time', () => {
    // The exact adversarial shape CodeQL named: `require("crypto"` repeated
    // with no `.createHash`. At ~187 KB the old regex re-scans the remaining
    // input from every occurrence (the sibling executors measured minutes at
    // this size); the single-pass scanner finishes in single-digit ms. The
    // budget is deliberately loose so a loaded CI box cannot flake.
    const LINEAR_TIME_BUDGET_MS = 2000;

    test('187 KB of `require("crypto")` repetitions with no hash call', () => {
        const code = 'require("crypto")'.repeat(11000);
        expect(code.length).toBeGreaterThan(180000);

        const started = process.hrtime.bigint();
        const found = containsCryptoCreateHashRequire(code);
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

        expect(found).toBe(false);
        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
    });

    test('187 KB of whitespace-separated require prefixes with no closing token', () => {
        const code = 'require '.repeat(20000) + '('.repeat(1000);
        const started = process.hrtime.bigint();
        const found = containsCryptoCreateHashRequire(code);
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

        expect(found).toBe(false);
        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
    });
});

describe('resolveWithinRoot enforces the component boundary', () => {
    const root = '/tmp/js-executor-workspace';

    test('a plain file name resolves beneath the root', () => {
        expect(resolveWithinRoot(root, 'test.js')).toBe(`${root}/test.js`);
    });

    test('a nested relative path inside the root is allowed', () => {
        expect(resolveWithinRoot(root, 'sub/test.js')).toBe(`${root}/sub/test.js`);
    });

    test('a ../ escape is refused', () => {
        expect(resolveWithinRoot(root, '../evil.js')).toBeNull();
    });

    test('a traversal through a nested segment is refused', () => {
        expect(resolveWithinRoot(root, 'sub/../../evil.js')).toBeNull();
    });

    test('a sibling sharing the root prefix is refused', () => {
        expect(resolveWithinRoot(root, '../js-executor-workspace-evil/x.js')).toBeNull();
    });

    test('an absolute path is refused', () => {
        expect(resolveWithinRoot(root, '/etc/passwd')).toBeNull();
    });
});
