# javascript-test-executor

Sandboxed JavaScript and TypeScript test execution service. Part of the `code_graph_helper` microservice system.

The `coding-testing` orchestrator (port 8689) dispatches JS/TS test requests here. This service writes submitted code and tests to an isolated temp directory, runs them with Jest, and returns structured results.

## Architecture

Single Express.js process (Node 18). No database. No persistent state. No authentication.

**Execution flow (`/execute`):**
1. Receive code + test code via HTTP POST
2. Create a temp directory under the OS temp dir (`os.tmpdir()`)
3. Concatenate code and test code into a single `.spec.js` or `.spec.ts` file
4. For TypeScript: configure Babel transpilation via babel-jest
5. Generate `jest.config.js` in the temp directory
6. Execute Jest with a configurable timeout (child process)
7. Parse Jest JSON output from `results.json`
8. Clean up temp directory
9. Return structured JSON response

**Test framework:** Jest only. `/execute` spawns Jest and nothing else, and now REJECTS any other `test_framework` with `400 unsupported_test_framework` rather than silently substituting Jest. The dead `executeTestWithFramework` path (Mocha, custom runner, `tsc` type checking, configurable TypeScript strictness) was deleted -- no route called it, and the global `mocha`/`tsc`/`ts-node` binaries it shelled out to are being removed from the base image.

**Security validation:** A `validateCodeSecurity` function exists that blocks `fs`, `child_process`, `net`, `http`, `eval`, `Function()`, `process.exit`, `process.kill`, `__dirname`, `__filename`, and `require.resolve`. However, nothing calls it: it was only ever reached from the deleted `executeTestWithFramework` path. The active `/execute` route does NOT perform security validation. The function is retained (still exported and tested) because reinstating it on `/execute` is a security fix, not a truth-in-advertising fix -- but `/info` no longer advertises `security_validation`.

**TypeScript support:** Babel transpilation via `babel-jest` with `@babel/preset-typescript`. The codebase defines three strictness levels (`strict`, `moderate`, `permissive`) in `TYPESCRIPT_CONFIGS`, but these are only referenced in dead code. The `/execute` route uses a hardcoded Babel config.

## API

All routes are unversioned per project convention.

### `GET /health`

Health check. Returns service status, supported frameworks, runtime memory/uptime.

**Response:**
```json
{
  "status": "healthy",
  "service": "javascript-test-executor-advanced",
  "version": "1.0.0",
  "capabilities": {
    "frameworks": ["jest"],
    "buildSystems": [],
    "features": { "parallelExecution": false, "coverage": false, "debugging": false, "typescript": true }
  },
  "runtime": { "version": "v18.x.x", "memory": { "used": 0, "total": 0 }, "uptime": 123.4 }
}
```

### `POST /execute`

Execute JavaScript or TypeScript tests. Primary endpoint.

**Request body:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `code` | string | `""` | Source code under test |
| `test_code` | string | `""` | Test code (concatenated with `code` into one file) |
| `language` | string | `"javascript"` | `"javascript"` or `"typescript"` |
| `timeout` | number | `30000` | Execution timeout in ms (unused -- actual timeout comes from `EXECUTION_TIMEOUT` env var) |

Code and test code are concatenated into a single test file. Jest runs with `--maxWorkers=1`, `--no-cache`, `--detectOpenHandles`, `--passWithNoTests`.

**Response (success -- HTTP 200):**
```json
{
  "success": true,
  "test_id": "uuid",
  "execution_time": "1.234",
  "output": "Test Results:\nTests: 3 total\nPassed: 3\n..."
}
```

**Response (test failure -- HTTP 200):**
```json
{
  "success": false,
  "test_id": "uuid",
  "execution_time": "0.567",
  "error": "Test execution failed or timed out.",
  "details": "Test Results:\nTests: 3 total\nFailed: 1\n..."
}
```

**Response (server error -- HTTP 500):**
```json
{
  "success": false,
  "test_id": "uuid",
  "error": "An internal server error occurred during test setup."
}
```

### `POST /validate`

Check JavaScript or TypeScript syntax without executing. Uses `node --check`.

**Request body:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `code` | string | required | Code to validate |
| `filename` | string | `"test.js"` | Filename (use `.ts` extension for TypeScript) |

Temp files are written to `/app/test_workspace/`.

**Response (HTTP 200):**
```json
{
  "validationId": "uuid",
  "valid": true,
  "errors": [],
  "output": ""
}
```

**Response (missing code -- HTTP 400):**
```json
{
  "validationId": "uuid",
  "valid": false,
  "errors": ["No code provided"],
  "output": ""
}
```

### `GET /frameworks`

List supported test frameworks and capabilities.

**Response:**
```json
{
  "supported": { "jest": {...} },
  "default": "jest",
  "recommended": "jest",
  "capabilities": {
    "testExecution": true,
    "parallelTests": false,
    "coverage": false,
    "codeCoverage": true,
    "mocking": true,
    "multipleFrameworks": true,
    "assertions": ["chai", "jest", "assert"]
  }
}
```

### `GET /info`

Extended service metadata: Node version, platform, supported languages, TypeScript strictness levels, feature list, capability matrix.

### Catch-all

Any unmatched route returns HTTP 404:
```json
{
  "error": "Not found",
  "message": "Endpoint GET /foo not found"
}
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8085` | HTTP listen port |
| `EXECUTION_TIMEOUT` | `30` | Test timeout in seconds (converted to ms internally) |
| `TEMP_DIR` | `/tmp` | Base temp directory (read but not used -- `/execute` uses `os.tmpdir()`, `/validate` uses hardcoded `/app/test_workspace/`) |

Dockerfile also sets:
| Variable | Value | Description |
|----------|-------|-------------|
| `NODE_ENV` | `test` | Node environment |
| `NODE_OPTIONS` | `--max-old-space-size=256` | V8 heap limit |
| `TEST_MODE` | `true` | Test mode flag |

## Dependencies

**Upstream caller:** `coding-testing` (port 8689) routes JS/TS test requests here via `JAVASCRIPT_TEST_SERVICE_URL`.

**No downstream service dependencies.** All execution is local (child processes).

**Dead dependency:** `redis` is listed in `package.json` but never imported or used in the code.

**Test tooling is app-local.** `jest` and its babel transforms are installed by the image's `npm ci` into `/app/node_modules` and invoked by absolute path — the image carries no npm globals (a ratchet test asserts that and explains why).

## Docker

```bash
docker compose up -d
docker compose -f ../../docker-compose.yml up javascript-test-executor  # from code_graph_helper root
```

Image: `ghcr.io/nonagenticai/javascript-test-executor:latest`
Port: `8085`
Health check: `GET /health` every 30s, 10s timeout, 3 retries
Base image: `node:26-alpine` plus the node-gyp build deps, folded into the `toolchain` stage of the Dockerfile.

## CI/CD

GitHub Actions on `nonagenticai/javascript-test-executor`, via the public `ci-workflows` archetype on GitHub-hosted runners. On every PR and on `main`:
1. Secret scan and private-infrastructure scan
2. `npm ci`, eslint, the jest suite
3. Build the image and smoke `/health` against it
4. From `main`: push `sha-<commit>` + `latest` to `ghcr.io/nonagenticai/javascript-test-executor` with a SLSA provenance attestation

There is no deploy job: this service is retired from the estate's cluster, and the repository is published so its tests, image build and job contract stay reproducible.

## Known Issues

- **Security validation not applied to /execute** — `validateCodeSecurity` exists and blocks dangerous imports (`fs`, `child_process`, `eval`, etc.) but no route calls it. This is a real gap, tracked here rather than papered over; `/info` no longer claims `security_validation`.
- **No TypeScript type checking** — `/execute` transpiles TS with babel-jest (`@babel/preset-typescript`), which STRIPS types without checking them. Nothing runs `tsc`. `TYPESCRIPT_CONFIGS` and its strict/moderate/permissive levels were deleted with the dead path; `/info` reports `type_checking: false` and an empty `typescript_strictness_levels`.
- **Unused redis dependency** — `redis` is listed in `package.json` but never imported or used in the code.

## Licensing

The code in this repository is Apache-2.0 and needs no licence key to build, test or run.
It contains no licence-enforcement code: the Apache-2.0 licence in [`LICENSE`](LICENSE) is the
only licence that applies, and no licence server is involved.

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
