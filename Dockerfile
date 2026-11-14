# syntax=docker/dockerfile:1.7
#
# JavaScript Test Executor — ONE image, two stages.
#
# This was a two-image chain: Dockerfile.base built `javascript-test-executor-base` into the
# estate's private registry and the app pinned it by digest. For the public repository the chain is
# folded into a single build — `toolchain` is the old base (node:26-alpine + node-gyp deps), `app`
# is the service. One artefact to publish, nothing to pin, no private registry anywhere.
#
# The TEST TOOLCHAIN IS NOT IN THE TOOLCHAIN STAGE: jest and its babel transforms come from the
# `npm ci` in the app stage, against src/package.json, and /execute invokes them by absolute
# /app/node_modules/... path. Do not re-add npm globals to the toolchain stage (see the scope note
# below the assert).
ARG NODE_VERSION=26

FROM docker.io/library/node:${NODE_VERSION}-alpine AS toolchain


# python3/make/g++ are here for node-gyp: a submitted test that pulls a native
# dependency fails at `npm install` without them, at runtime, inside /execute.
# curl is here for the app image's HEALTHCHECK.
RUN apk add --no-cache python3 make g++ curl git ca-certificates bash

# Fail the BASE build rather than shipping an image that cannot do its one job.
# This asserts exactly what the base is still responsible for — a working
# node/npm and the node-gyp build deps — and nothing it no longer provides.
# Without an assert here a broken toolchain builds green and only fails at
# runtime inside /execute, which is the failure mode this repo has paid for once.
RUN node --version && npm --version \
 && node -e "console.log(require('os').platform())" \
 && python3 --version && make --version && g++ --version \
 && curl --version && git --version \
 && printf 'int main(void){return 0;}\n' > /tmp/gyp-probe.c \
 && g++ -x c++ /tmp/gyp-probe.c -o /tmp/gyp-probe && /tmp/gyp-probe \
 && rm -f /tmp/gyp-probe.c /tmp/gyp-probe

# ⚠️ SCOPE OF THE ASSERT ABOVE — it is NOT proof that node-gyp works.
# node-gyp also needs the Node headers tarball, which it fetches from
# nodejs.org. This image caches none (no `node-gyp install`, no
# npm_config_nodedir), and the runtime namespace has ZERO egress — so a native
# `npm install` inside /execute would still fail at header download, with a
# green base build. Asserting the compiler is the honest limit of what can be
# checked here; caching the headers is a separate change with its own proof.

# ── Application ──────────────────────────────────────────────────────────────
FROM toolchain AS app


WORKDIR /app

RUN mkdir -p /app/test /app/config /app/logs /app/temp_js && \
    chmod -R 755 /app

COPY src/ ./src/
COPY src/package.json src/package-lock.json ./

RUN npm ci && npm cache clean --force

ENV NODE_ENV=test \
    NODE_OPTIONS="--max-old-space-size=256" \
    TEST_MODE=true

EXPOSE 8085

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:8085/health || exit 1

CMD ["node", "src/js_test_service_advanced.js"]
