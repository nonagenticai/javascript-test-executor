#!/usr/bin/env node

/**
 * JavaScript/TypeScript Test Execution Service
 *
 * Sandboxed test runner for the code_graph_helper system. Receives source code
 * and test code over HTTP, executes tests in isolated temp directories, and
 * returns structured results. Called by the coding-testing orchestrator.
 *
 * Active capabilities — this is the WHOLE list, and /frameworks, /info and
 * /health must not advertise anything beyond it:
 * - Jest test execution via /execute (code + test_code concatenated, run with Jest).
 *   Jest is the ONLY runner; a request for any other test_framework is rejected 400.
 * - TypeScript TRANSPILATION via Babel (babel-jest + @babel/preset-typescript).
 *   Babel strips types; it does NOT type-check. Nothing here runs `tsc`.
 * - Syntax validation via node --check (/validate endpoint)
 *
 * The Mocha / custom-runner / tsc-type-checking path (executeTestWithFramework and
 * its ~750 lines of helpers) was deleted: no route ever called it, and the globals
 * it shelled out to (mocha, tsc, ts-node) are being removed from the base image.
 *
 * No authentication. No database. No persistent state.
 * Port: 8085 (default)
 */

const {
    createLogger,
    setupExpress,
    tenantGuard,
    installGracefulShutdown,
} = require('./common');
const { spawn, exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Configuration
const PORT = process.env.PORT || 8085;
const EXECUTION_TIMEOUT = parseInt(process.env.EXECUTION_TIMEOUT || '30') * 1000;
const TEMP_DIR = process.env.TEMP_DIR || '/tmp';
const TEST_WORKSPACE = process.env.TEST_WORKSPACE || '/app/test_workspace';

// Initialize Express app with shared setup + orchestrator-only tenant guard
const app = setupExpress({ jsonLimit: '10mb' });
app.use(tenantGuard());

// Enhanced logging utility
const log = createLogger();

// Service version. Single source of truth is the package.json that ships in the
// image next to this file — a hardcoded literal here drifted to '3.0.0' against
// a package.json that has always said 1.0.0.
const SERVICE_VERSION = require('./package.json').version;

// Supported testing frameworks.
// ONLY add an entry here when /execute can actually run it. This object is what
// /frameworks, /info and /health advertise, and what /execute validates against,
// so an aspirational entry becomes a lie on four surfaces at once.
const SUPPORTED_FRAMEWORKS = {
    'jest': {
        name: 'Jest',
        dependencies: ['jest', '@types/jest'],
        testExtensions: ['.test.js', '.test.ts', '.spec.js', '.spec.ts'],
        configFile: 'jest.config.js'
    }
};

// The framework /execute uses when the caller does not name one.
const DEFAULT_FRAMEWORK = 'jest';

// Security validation
function validateCodeSecurity(code) {
    const dangerousPatterns = [
        /require\s*\(\s*['"]fs['"]|fs\./i,
        /require\s*\(\s*['"]child_process['"]|child_process\./i,
        /require\s*\(\s*['"]net['"]|net\./i,
        /require\s*\(\s*['"]http['"]|http\./i,
        /require\s*\(\s*['"]crypto['"].*\.createHash/i,
        /eval\s*\(/i,
        /Function\s*\(/i,
        /process\.exit/i,
        /process\.kill/i,
        /\.\.\/|__dirname|__filename/i,
        /require\.resolve/i
    ];

    for (const pattern of dangerousPatterns) {
        if (pattern.test(code)) {
            throw new Error(`Security violation: Potentially dangerous code pattern detected`);
        }
    }
}

// Generate unique test ID
function generateTestId() {
    return crypto.randomBytes(16).toString('hex');
}

// Create secure temporary directory
async function createTempDir(testId) {
    const tempPath = path.join(TEST_WORKSPACE, testId);
    await fs.mkdir(tempPath, { recursive: true });
    return tempPath;
}

// Cleanup temporary files
async function cleanup(tempPath) {
    try {
        await fs.rm(tempPath, { recursive: true, force: true });
        log.debug(`Cleaned up temporary directory: ${tempPath}`);
    } catch (error) {
        log.warn(`Failed to cleanup ${tempPath}:`, { error: error.message });
    }
}

// Enhanced command runner
function runCommand(command, cwd, timeout = EXECUTION_TIMEOUT, options = {}) {
    return new Promise((resolve) => {
        log.debug(`Running command: ${command.join(' ')}`, { cwd, timeout });
        
        const childProcess = spawn(command[0], command.slice(1), {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { 
                ...process.env, 
                NODE_ENV: 'test',
                NPM_CONFIG_CACHE: '/tmp/.npm',
                NPM_CONFIG_FUND: 'false',
                NPM_CONFIG_AUDIT: 'false',
                NPM_CONFIG_UPDATE_NOTIFIER: 'false',
                ...options.env
            },
            shell: false
        });

        let stdout = '';
        let stderr = '';
        let timeoutHandle;
        let killed = false;

        timeoutHandle = setTimeout(() => {
            log.warn(`Command timed out after ${timeout}ms: ${command.join(' ')}`);
            killed = true;
            childProcess.kill('SIGTERM');
            setTimeout(() => {
                if (!childProcess.killed) {
                    childProcess.kill('SIGKILL');
                }
            }, 2000);
        }, timeout);

        childProcess.stdout.on('data', (data) => {
            const output = data.toString();
            stdout += output;
            if (options.logOutput) log.debug(`STDOUT: ${output.trim()}`);
        });

        childProcess.stderr.on('data', (data) => {
            const output = data.toString();
            stderr += output;
            if (options.logOutput) log.debug(`STDERR: ${output.trim()}`);
        });

        childProcess.on('close', (code, signal) => {
            clearTimeout(timeoutHandle);
            
            const result = {
                success: code === 0 && !killed,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                exitCode: code,
                signal,
                killed,
                command: command.join(' ')
            };
            
            log.debug(`Command completed:`, result);
            resolve(result);
        });

        childProcess.on('error', (error) => {
            clearTimeout(timeoutHandle);
            log.error(`Command error: ${error.message}`, { command: command.join(' ') });
            
            resolve({
                success: false,
                stdout: stdout.trim(),
                stderr: (stderr + '\n' + error.message).trim(),
                exitCode: 1,
                error: error.message,
                command: command.join(' ')
            });
        });
    });
}

// Helper function to format Jest results
function formatJestResults(jestResults) {
    if (!jestResults) return 'No test results available';
    
    let output = `Test Results:\n`;
    output += `Tests: ${jestResults.numTotalTests || 0} total\n`;
    output += `Passed: ${jestResults.numPassedTests || 0}\n`;
    output += `Failed: ${jestResults.numFailedTests || 0}\n`;
    output += `Skipped: ${jestResults.numPendingTests || 0}\n`;
    output += `Time: ${jestResults.testResults?.[0]?.perfStats?.duration || 'N/A'}ms\n`;
    
    if (jestResults.testResults && jestResults.testResults.length > 0) {
        const testResult = jestResults.testResults[0];
        if (testResult.assertionResults) {
            output += `\nTest Details:\n`;
            testResult.assertionResults.forEach((test, index) => {
                const status = test.status === 'passed' ? '✅' : '❌';
                output += `  ${status} ${test.fullName || test.title}\n`;
                if (test.failureMessages && test.failureMessages.length > 0) {
                    output += `    Error: ${test.failureMessages[0]}\n`;
                }
            });
        }
    }
    
    return output;
}

// REST API Endpoints

// Health check with enhanced info
app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
        status: 'healthy',
        service: 'javascript-test-executor-advanced',
        version: SERVICE_VERSION,
        timestamp: new Date().toISOString(),
        capabilities: {
            frameworks: Object.keys(SUPPORTED_FRAMEWORKS),
            // /execute never invokes a package manager: it writes the files and
            // spawns Jest. Nothing here builds or installs anything.
            buildSystems: [],
            features: {
                parallelExecution: false,
                // /execute hardcodes collectCoverage:false and exposes no knob.
                coverage: false,
                debugging: false,
                typescript: true
            }
        },
        runtime: {
            version: process.version,
            memory: {
                used: memUsage.heapUsed,
                total: memUsage.heapTotal
            },
            uptime: process.uptime()
        }
    });
});

// Execute test with advanced features
app.post('/execute', async (req, res) => {
    const { code, test_code, language, timeout = 30000, test_framework } = req.body;
    const testId = crypto.randomUUID();
    const tempDir = path.join(os.tmpdir(), `test-${testId}`);

    // This route runs Jest and nothing else. Previously test_framework was not even
    // read, so a caller asking for mocha got a silent Jest run and no way to tell:
    // mocha-style `describe`/`it` happen to be Jest globals too, so the suite would
    // "pass" while chai assertions or mocha-only APIs failed for reasons the caller
    // could not attribute. Reject instead of substituting.
    const requestedFramework = test_framework ?? DEFAULT_FRAMEWORK;
    if (!Object.prototype.hasOwnProperty.call(SUPPORTED_FRAMEWORKS, requestedFramework)) {
        const supported = Object.keys(SUPPORTED_FRAMEWORKS);
        log.warn(`Rejected unsupported test_framework: ${String(requestedFramework)}`, { testId });
        return res.status(400).json({
            test_id: testId,
            error: 'unsupported_test_framework',
            message: `test_framework '${String(requestedFramework)}' is not supported. `
                + `This service executes only: ${supported.join(', ')}.`,
            requested: requestedFramework,
            supported_frameworks: supported
        });
    }

    try {
        // 1. Create a temporary directory for the test files
        await fs.mkdir(tempDir, { recursive: true });

        const isTypeScript = language === 'typescript';
        const codeFileName = isTypeScript ? 'code.ts' : 'code.js';
        const testFileName = isTypeScript ? 'test.spec.ts' : 'test.spec.js';

        const codeFilePath = path.join(tempDir, codeFileName);
        const testFilePath = path.join(tempDir, testFileName);

        // 2. Write the code and test files
        // A simple approach for this example is to merge them, as Jest can handle it.
        // For more complex scenarios, you might keep them separate and configure Jest.
        const testContent = `${code}\n\n${test_code}`;
        await fs.writeFile(testFilePath, testContent);
        
        // 3. Run Jest using a child process from the local node_modules.
        // This is the most robust method.
        const jestExecutable = '/app/node_modules/.bin/jest';
        
        // Create Jest config with TypeScript support
        const jestConfig = {
            testEnvironment: 'node',
            verbose: true,
            collectCoverage: false,
            testMatch: [
                '**/test.spec.js',
                '**/test.spec.ts',
                '**/*.test.js',
                '**/*.test.ts'
            ],
            testTimeout: 10000,
            forceExit: false,
            detectOpenHandles: true,
            maxWorkers: 1,
            clearMocks: true,
            resetMocks: true,
            restoreMocks: true,
            bail: false,
            watchman: false,
            roots: ['<rootDir>'],
            rootDir: tempDir
        };

        // Add TypeScript support if needed
        if (isTypeScript) {
            jestConfig.transform = {
                '^.+\\.(ts|tsx)$': ['/app/node_modules/babel-jest', {
                    presets: [
                        ['/app/node_modules/@babel/preset-env', { 
                            targets: { node: 'current' },
                            modules: 'commonjs'
                        }],
                        ['/app/node_modules/@babel/preset-typescript', {
                            allowDeclareFields: true,
                            allowNamespaces: true,
                            allExtensions: true,
                            isTSX: false,
                            onlyRemoveTypeImports: true,
                            allowSyntheticDefaultImports: true,
                            isolatedModules: true
                        }]
                    ],
                    babelrc: false,
                    configFile: false
                }],
                '^.+\\.(js|jsx)$': ['/app/node_modules/babel-jest', {
                    presets: [
                        ['/app/node_modules/@babel/preset-env', { 
                            targets: { node: 'current' },
                            modules: 'commonjs'
                        }]
                    ],
                    babelrc: false,
                    configFile: false
                }]
            };
            jestConfig.moduleFileExtensions = ['ts', 'tsx', 'js', 'jsx', 'json'];
            jestConfig.transformIgnorePatterns = ['node_modules/(?!(.*\\.mjs$))'];
            jestConfig.extensionsToTreatAsEsm = [];
        }
        
        const configPath = path.join(tempDir, 'jest.config.js');
        await fs.writeFile(configPath, `module.exports = ${JSON.stringify(jestConfig, null, 2)};`);


        
        // Debug: List files in temp directory
        console.log(`[${testId}] Temp directory contents:`);
        const files = await fs.readdir(tempDir);
        files.forEach(file => console.log(`[${testId}]   - ${file}`));
        
        // Use Jest with explicit config and JSON output
        const resultsFile = path.join(tempDir, 'results.json');
        const jestCommand = `${jestExecutable} --config ${configPath} --json --outputFile=${resultsFile} --verbose --no-cache --detectOpenHandles --maxWorkers=1`;

        console.log(`[${testId}] Executing command: ${jestCommand}`);
        
        const startTime = Date.now();
        const result = await new Promise((resolve) => {
            exec(jestCommand, { 
                cwd: tempDir,
                timeout: EXECUTION_TIMEOUT,
                maxBuffer: 1024 * 1024 // 1MB buffer
            }, async (error, stdout, stderr) => {
                const executionTime = ((Date.now() - startTime) / 1000).toFixed(3);
                
                console.log(`[${testId}] --- JEST EXECUTION COMPLETE ---`);
                console.log(`[${testId}] STDOUT: ${stdout}`);
                console.log(`[${testId}] STDERR: ${stderr}`);
                
                let testResults = {
                    success: false,
                    output: '',
                    error: null,
                    execution_time: executionTime
                };
                
                try {
                    // Try to read Jest JSON results first
                    if (await fs.access(resultsFile).then(() => true).catch(() => false)) {
                        const resultsData = await fs.readFile(resultsFile, 'utf8');
                        const jestResults = JSON.parse(resultsData);
                        
                        const numTotal = jestResults.numTotalTests || 0;
                        const numFailed = jestResults.numFailedTests || 0;
                        // A green verdict requires Jest's own success flag AND at least one
                        // test actually collected AND zero failures. A run that collected zero
                        // tests verified nothing and is NOT a pass (closes the zero-test
                        // loophole — aligns JS with the go/csharp/java/cpp/rust executors).
                        testResults.success =
                            (jestResults.success === true) && (numTotal > 0) && (numFailed === 0);
                        testResults.output = formatJestResults(jestResults);
                        testResults.tests_run = numTotal;
                        testResults.tests_passed = jestResults.numPassedTests || 0;
                        testResults.tests_failed = numFailed;
                        testResults.no_tests_run = numTotal === 0;

                        console.log(`[${testId}] Jest results: ${testResults.success ? 'PASSED' : 'FAILED'}`);
                        console.log(`[${testId}] Tests run: ${numTotal}`);
                        console.log(`[${testId}] Tests passed: ${jestResults.numPassedTests || 0}`);
                    } else if (stdout && stdout.trim()) {
                        // Fallback to stdout parsing: require an explicit PASS marker AND no
                        // error. A run with no parseable results never counts as a pass.
                        testResults.success = !error && stdout.includes('PASS');
                        testResults.output = stdout;
                        testResults.no_tests_run = !testResults.success;
                    } else {
                        // No results file and no output: nothing ran, nothing was verified.
                        // This is a FAILURE, not a silent pass (was the zero-test loophole).
                        testResults.success = false;
                        testResults.no_tests_run = true;
                        testResults.output = 'No tests were collected — treated as failure.';
                    }
                } catch (parseError) {
                    console.log(`[${testId}] Failed to parse Jest results: ${parseError.message}`);
                    testResults.output = stdout || stderr || 'No output captured';
                }
                
                if (error) {
                    console.log(`[${testId}] ERROR OBJECT: ${error}`);
                    if (!testResults.success) {
                        testResults.error = error.message;
                    }
                }
                
                console.log(`[${testId}] --- END JEST LOG ---`);
                resolve(testResults);
            });
        });

        // Cleanup temp directory
        await fs.rm(tempDir, { recursive: true, force: true }).catch(console.error);

        if (result.success) {
            res.json({
                success: true,
                test_id: testId,
                execution_time: result.execution_time,
                output: result.output,
                tests_run: result.tests_run || 0,
                tests_passed: result.tests_passed || 0,
                tests_failed: result.tests_failed || 0,
                no_tests_run: result.no_tests_run || false
            });
        } else {
            res.status(200).json({  // Return 200 for handled test failures
                success: false,
                test_id: testId,
                execution_time: result.execution_time,
                error: result.error || "Test execution failed or timed out.",
                details: result.output,
                tests_run: result.tests_run || 0,
                tests_passed: result.tests_passed || 0,
                tests_failed: result.tests_failed || 0,
                no_tests_run: result.no_tests_run || false
            });
        }

    } catch (err) {
        console.error(`[${testId}] Server error:`, err);
        // Ensure cleanup happens even if the setup fails
        if (await fs.stat(tempDir).catch(() => false)) {
             await fs.rm(tempDir, { recursive: true, force: true });
        }
        res.status(500).json({
            success: false,
            test_id: testId,
            error: "An internal server error occurred during test setup."
        });
    }
});

// Get supported frameworks and features
app.get('/frameworks', (req, res) => {
    res.json({
        supported: SUPPORTED_FRAMEWORKS,
        default: DEFAULT_FRAMEWORK,
        recommended: DEFAULT_FRAMEWORK,
        capabilities: {
            testExecution: true,
            parallelTests: false,
            // /execute sets collectCoverage:false and offers no way to enable it.
            coverage: false,
            codeCoverage: false,
            mocking: true,
            // Jest is the only runner /execute can spawn.
            multipleFrameworks: false,
            // chai is not resolvable from the temp dir /execute runs tests in.
            assertions: ['jest', 'assert']
        }
    });
});

// Get system info with enhanced capabilities
app.get('/info', (req, res) => {
    res.json({
        service: 'javascript-test-executor-advanced',
        version: SERVICE_VERSION,
        node_version: process.version,
        platform: os.platform(),
        arch: os.arch(),
        supported_languages: ['javascript', 'typescript'],
        supported_frameworks: Object.keys(SUPPORTED_FRAMEWORKS),
        // No strictness levels: /execute has a single fixed Babel transform and
        // reads no tsconfig, so there is nothing to select between.
        typescript_strictness_levels: [],
        // Every entry below must be traceable to code /execute or /validate runs.
        // Removed: multiple_test_frameworks, type_checking, dependency_management,
        // custom_assertions, test_lifecycle_hooks, security_validation — all of
        // them lived only in the deleted executeTestWithFramework path.
        features: [
            'enhanced_logging',
            // Babel transpiles TS; it does not type-check it.
            'typescript_transpilation',
            'es6_module_support',
            'resource_monitoring',
            'timeout_management'
        ],
        capabilities: {
            typescript: {
                // Transpiled by babel-jest + @babel/preset-typescript.
                compilation: true,
                // Babel strips types without checking them. Nothing runs tsc.
                type_checking: false,
                es6_modules: true,
                strictness_control: false
            },
            testing_frameworks: {
                jest: true,
                mocha: false,
                custom: false,
                // Jest's own `expect`. chai is not resolvable from the temp dir
                // the spawned Jest runs in, and there is no custom runner.
                assertion_libraries: ['expect']
            },
            performance: {
                // Nothing installs dependencies, so nothing caches them.
                dependency_caching: false,
                parallel_execution: false,
                result_caching: false
            }
        }
    });
});

// Simple command executor for validation
function executeCommand(command, options = {}) {
    return new Promise((resolve, reject) => {
        exec(command, options, (error, stdout, stderr) => {
            if (error) {
                resolve({
                    success: false,
                    stdout,
                    stderr,
                    error: error.message
                });
            } else {
                resolve({
                    success: true,
                    stdout,
                    stderr
                });
            }
        });
    });
}

// Filenames supplied by the caller end up in two dangerous places: path.join()
// against the workspace dir, and an interpolated shell string ("node --check X").
// An allowlist of basename-safe characters closes both holes with one rule.
// We deliberately do NOT use path.basename() to sanitise: basename() silently
// rewrites "../../etc/passwd" to "passwd" (the caller never learns its input was
// rejected) and it leaves shell metacharacters like ";", "|", "$(" and spaces
// completely intact, so the command-injection half of the problem would survive.
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

function isSafeFilename(filename) {
    if (typeof filename !== 'string' || filename.length === 0) {
        return false;
    }
    // "." and ".." pass the character class above but are directory references,
    // not files - reject anything that starts a dot-dot traversal segment.
    if (filename === '.' || filename.startsWith('..')) {
        return false;
    }
    return SAFE_FILENAME.test(filename);
}

// Validate JavaScript/TypeScript code syntax
app.post('/validate', async (req, res) => {
    const validationId = crypto.randomUUID();
    
    try {
        const { code, filename = 'test.js' } = req.body;
        
        if (code === undefined || code === null) {
            return res.status(400).json({
                validationId,
                valid: false,
                errors: ['No code provided'],
                output: ''
            });
        }
        
        // Everything below treats `code` as a string (.trim(), fs.writeFile).
        // Without this guard a JSON object/array/number body reaches code.trim()
        // and the request dies as a 500 "code.trim is not a function" - a caller
        // input error reported as a server fault. Name the field and the type we
        // actually received so the client can fix its payload.
        if (typeof code !== 'string') {
            const receivedType = Array.isArray(code) ? 'array' : typeof code;
            return res.status(400).json({
                validationId,
                valid: false,
                errors: [`code must be a string, received ${receivedType}`],
                output: ''
            });
        }

        // Reject unsafe filenames before they touch the filesystem or the shell.
        if (!isSafeFilename(filename)) {
            return res.status(400).json({
                validationId,
                valid: false,
                errors: ['filename must be a plain file name matching [A-Za-z0-9._-]+'],
                output: ''
            });
        }

        // Empty code is valid JavaScript
        if (code.trim() === '') {
            return res.json({
                validationId,
                valid: true,
                errors: [],
                output: ''
            });
        }
        
        // Create temporary file for validation
        const tempPath = path.join(TEST_WORKSPACE, validationId);
        await fs.mkdir(tempPath, { recursive: true });
        
        const jsFile = path.join(tempPath, filename);
        await fs.writeFile(jsFile, code);
        
        // Try to parse the file with Node.js syntax checker
        const checkResult = await executeCommand(`node --check ${filename}`, { cwd: tempPath });
        
        // Clean up
        await fs.rm(tempPath, { recursive: true, force: true });
        
        res.json({
            validationId,
            valid: checkResult.success,
            errors: checkResult.success ? [] : [checkResult.stderr],
            output: checkResult.stdout
        });
        
    } catch (error) {
        log.error(`JavaScript validation error: ${validationId}`, { error: error.message });
        res.status(500).json({
            validationId,
            valid: false,
            error: error.message
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    log.error('Unhandled error', { 
        error: error.message, 
        stack: error.stack 
    });
    res.status(500).json({
        error: 'Internal server error',
        message: error.message
    });
});

// Express 5 rejects bare "*" path patterns, so use a final catch-all middleware.
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        message: `Endpoint ${req.method} ${req.originalUrl} not found`
    });
});

// Start server
async function startServer() {
    try {
        // Ensure test workspace exists
        await fs.mkdir(TEST_WORKSPACE, { recursive: true });
        log.info(`Test workspace ready: ${TEST_WORKSPACE}`);

        app.listen(PORT, '0.0.0.0', () => {
            log.info(`🚀 Advanced JavaScript/TypeScript Test Executor started`, {
                port: PORT,
                timeout: EXECUTION_TIMEOUT,
                workspace: TEST_WORKSPACE,
                node_version: process.version,
                supported_frameworks: Object.keys(SUPPORTED_FRAMEWORKS),
                typescript_support: true
            });
        });

        // Graceful shutdown
        installGracefulShutdown({ log });

    } catch (error) {
        log.error('Failed to start server', { 
            error: error.message, 
            stack: error.stack 
        });
        process.exit(1);
    }
}

// Start the service
if (require.main === module) {
    startServer();
}

// Export for testing
module.exports = {
    app,
    validateCodeSecurity,
    generateTestId,
    createTempDir,
    cleanup,
    runCommand,
    formatJestResults,
    executeCommand,
    startServer,
    SUPPORTED_FRAMEWORKS,
    DEFAULT_FRAMEWORK,
    SERVICE_VERSION,
    log,
    PORT,
    EXECUTION_TIMEOUT,
    TEMP_DIR,
    TEST_WORKSPACE,
};
