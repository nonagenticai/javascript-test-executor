const fs = require('fs');
const path = require('path');

// Dockerfile.base used to `npm install -g` 15 test tools (~250 MiB on disk).
// Nothing executed them: /execute spawns the ABSOLUTE app-local path
// /app/node_modules/.bin/jest with absolute /app/node_modules/... babel
// transforms, /validate only runs `node --check`, and the mocha/tsc/ts-node
// branches live in the dead executeTestWithFramework(). They were deleted.
//
// This suite is the ratchet: it fails the moment a global install reappears, and
// it fails if the base loses the build deps or the assert it IS responsible for.
const repoRoot = path.resolve(__dirname, '..', '..');

// The base used to be its own file. The public repository folds it into the
// `toolchain` stage of the single Dockerfile, so these assertions follow it —
// the invariant ("no global npm installs in the toolchain, but its build deps
// and its build-time assert stay") did not change with the fold.
const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
const base = dockerfile.split(/^FROM toolchain AS app$/m)[0];

// Directive lines only — the prose above them deliberately mentions the tools by
// name so nobody re-adds them, and must not trip these assertions.
const instructions = base
    .split('\n')
    .filter((line) => !line.trim().startsWith('#') && line.trim() !== '')
    .join('\n');

describe('the toolchain stage carries no global npm installs', () => {
    it('has no `npm install -g` / `npm i -g` / `npm add -g` instruction', () => {
        expect(instructions).not.toMatch(/npm\s+(install|i|add)\b[^\n]*\s-g\b/);
        expect(instructions).not.toMatch(/npm\s+(install|i|add)\b[^\n]*--global\b/);
    });

    it('does not install any of the 15 removed tools globally', () => {
        const removed = [
            'jest', 'mocha', 'vitest', 'typescript', 'ts-jest', 'ts-node',
            '@babel/core', '@babel/preset-env', '@babel/preset-typescript',
            'babel-jest', 'eslint', '@typescript-eslint/eslint-plugin',
            '@typescript-eslint/parser', 'prettier', 'nyc',
        ];
        const npmLines = instructions
            .split('\n')
            .filter((line) => /\bnpm\b/.test(line) || /@\d+\.\d+\.\d+/.test(line));
        for (const tool of removed) {
            expect(npmLines.join('\n')).not.toContain(`${tool}@`);
        }
    });

    it('does not write into the global node_modules prefix', () => {
        expect(instructions).not.toContain('/usr/local/lib/node_modules');
    });

    it('still installs the node-gyp build deps the base is responsible for', () => {
        expect(instructions).toMatch(/apk add[^\n]*python3/);
        expect(instructions).toMatch(/apk add[^\n]*make/);
        expect(instructions).toMatch(/apk add[^\n]*g\+\+/);
        expect(instructions).toMatch(/apk add[^\n]*curl/);
    });

    it('still asserts its own toolchain at build time (never ships unverified)', () => {
        expect(instructions).toMatch(/node --version/);
        expect(instructions).toMatch(/npm --version/);
        expect(instructions).toMatch(/python3 --version/);
        expect(instructions).toMatch(/g\+\+ --version/);
    });

    it('records WHY the globals are gone so they are not re-added', () => {
        expect(base).toMatch(/\/app\/node_modules/);
        expect(base).toMatch(/DO NOT RE-ADD/i);
    });
});

describe('/execute resolves jest app-locally, not from a global', () => {
    const service = fs.readFileSync(
        path.join(repoRoot, 'src', 'js_test_service_advanced.js'),
        'utf8'
    );

    it('spawns jest by absolute app-local path', () => {
        expect(service).toContain("'/app/node_modules/.bin/jest'");
    });

    // ⚠️ THIS TEST WAS VACUOUS AND IS REWRITTEN.
    //
    // It used to regex for a STRING LITERAL argv[0] — `spawn('mocha', ...)`.
    // No call site in this service looks like that: they pass arrays and
    // variables, e.g. `runCommand(['npx','tsc'], ...)` at :677 and
    // `spawn(command[0], ...)` at :175. A genuine bare-name invocation walked
    // straight through the old assertion.
    //
    // The real risk is an ARRAY LITERAL whose first element is a bare tool name,
    // because runCommand passes it to spawn as argv[0] and PATH resolves it.
    // `node`, `npm` and `npx` are allowed: they ship with the base image itself.
    it('no child-process argv[0] is a bare global tool name', () => {
        const BANNED = ['jest', 'mocha', 'vitest', 'tsc', 'nyc', 'eslint', 'prettier', 'ts-node', 'ts-jest', 'babel'];
        const offenders = [];

        // Array literals ONLY where they are an argv, i.e. passed to a
        // child-process helper. A bare `['jest', '@types/jest']` elsewhere is an
        // npm DEPENDENCY LIST, not a command — an earlier version of this
        // regex matched those and produced two false positives.
        for (const m of service.matchAll(/(?:runCommand|spawn|execFile\w*)\(\s*\[\s*['"`]([\w.@/-]+)['"`]/g)) {
            if (BANNED.includes(m[1])) offenders.push(`array argv[0] '${m[1]}'`);
        }
        // direct literals: spawn('tsc', ...) / exec('mocha ...')
        for (const m of service.matchAll(/(?:spawn|exec|execSync|execFile)\w*\(\s*['"`]([\w.@/-]+)/g)) {
            if (BANNED.includes(m[1])) offenders.push(`direct argv[0] '${m[1]}'`);
        }

        expect(offenders).toEqual([]);
    });
});
