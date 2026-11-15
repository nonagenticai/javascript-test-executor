const request = require('supertest');

// js/missing-rate-limiting (CodeQL) flagged /execute and /validate because each
// handler writes to disk and spawns work with no cap on how often it can be
// asked to do so. These tests load the service with a deliberately tiny bucket
// (RATE_LIMIT_MAX=2) and prove the third request is refused with 429 before the
// handler runs. The env is applied only for the synchronous require and then
// restored, so it cannot leak into other test files in the same worker.
function loadAppWithLimit(limit) {
    const previous = {
        max: process.env.RATE_LIMIT_MAX,
        windowMs: process.env.RATE_LIMIT_WINDOW_MS,
    };
    process.env.RATE_LIMIT_MAX = String(limit);
    process.env.RATE_LIMIT_WINDOW_MS = '60000';

    let app;
    jest.isolateModules(() => {
        ({ app } = require('../../src/js_test_service_advanced'));
    });

    if (previous.max === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = previous.max;
    if (previous.windowMs === undefined) delete process.env.RATE_LIMIT_WINDOW_MS;
    else process.env.RATE_LIMIT_WINDOW_MS = previous.windowMs;

    return app;
}

const TOO_MANY = { error: 'Too many requests', detail: 'This executor is rate-limited.' };

describe('/execute is rate-limited', () => {
    test('a cheap contract rejection succeeds until the bucket is empty, then 429', async () => {
        const app = loadAppWithLimit(2);
        const probe = () => request(app).post('/execute').send({ test_framework: 'mocha' });

        expect((await probe()).status).toBe(400);
        expect((await probe()).status).toBe(400);

        const blocked = await probe();
        expect(blocked.status).toBe(429);
        expect(blocked.body).toEqual(TOO_MANY);
        expect(blocked.headers['ratelimit-remaining']).toBe('0');
    });
});

describe('/validate is rate-limited', () => {
    test('a contract error (not a string) is a cheap 400 until the bucket is empty, then 429', async () => {
        const app = loadAppWithLimit(2);
        const invalid = () => request(app).post('/validate').send({ code: 42 });

        expect((await invalid()).status).toBe(400);
        expect((await invalid()).status).toBe(400);

        const blocked = await invalid();
        expect(blocked.status).toBe(429);
        expect(blocked.body).toEqual(TOO_MANY);
    });
});

describe('the limited routes share one bucket', () => {
    test('two /execute requests exhaust it for /validate too', async () => {
        // Deliberate: the cap is on total executor work (CPU + scratch disk),
        // not on one endpoint, so a caller cannot multiply the budget by
        // spreading requests across the expensive routes.
        const app = loadAppWithLimit(2);
        expect((await request(app).post('/execute').send({ test_framework: 'mocha' })).status).toBe(400);
        expect((await request(app).post('/execute').send({ test_framework: 'mocha' })).status).toBe(400);
        expect((await request(app).post('/validate').send({ code: 42 })).status).toBe(429);
    });
});
