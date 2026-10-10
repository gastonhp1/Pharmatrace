const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const express = require("express");
const { requireApiKey } = require("../middleware/auth");

async function withServer(env, fn) {
    const app = express();
    app.use("/api", requireApiKey(env));
    app.get("/api/read", (req, res) => res.json({ ok: true }));
    app.post("/api/write", (req, res) => res.json({ ok: true }));

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await fn(base);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

const post = (base, headers = {}) => fetch(`${base}/api/write`, { method: "POST", headers });

test("reads are public", async () => {
    await withServer({ API_KEY: "secret" }, async (base) => {
        assert.strictEqual((await fetch(`${base}/api/read`)).status, 200);
    });
});

test("writes without a key are rejected", async () => {
    await withServer({ API_KEY: "secret" }, async (base) => {
        assert.strictEqual((await post(base)).status, 401);
    });
});

test("writes with a wrong key are rejected", async () => {
    await withServer({ API_KEY: "secret" }, async (base) => {
        assert.strictEqual((await post(base, { "x-api-key": "nope" })).status, 401);
        assert.strictEqual((await post(base, { "x-api-key": "secre" })).status, 401);
    });
});

test("writes with the right key go through", async () => {
    await withServer({ API_KEY: "secret" }, async (base) => {
        assert.strictEqual((await post(base, { "x-api-key": "secret" })).status, 200);
    });
});

test("fails closed when no API_KEY is configured", async () => {
    await withServer({}, async (base) => {
        assert.strictEqual((await post(base)).status, 503);
        assert.strictEqual((await post(base, { "x-api-key": "" })).status, 503);
        assert.strictEqual((await fetch(`${base}/api/read`)).status, 200);
    });
});

test("AUTH_DISABLED=true opens writes explicitly", async () => {
    await withServer({ AUTH_DISABLED: "true" }, async (base) => {
        assert.strictEqual((await post(base)).status, 200);
    });
});

// ---- IoT admin routes -------------------------------------------------------------------------
const { requireAdminKey } = require("../middleware/auth");

async function withAdminServer(env, fn) {
    const app = express();
    app.post("/admin", requireAdminKey(env), (req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
        await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}
const admin = (base, key) =>
    fetch(`${base}/admin`, { method: "POST", headers: key ? { "x-api-key": key } : {} });

test("admin routes use IOT_API_KEY when set", async () => {
    await withAdminServer({ IOT_API_KEY: "iot", API_KEY: "main" }, async (base) => {
        assert.strictEqual((await admin(base, "iot")).status, 200);
        assert.strictEqual((await admin(base, "main")).status, 401);
        assert.strictEqual((await admin(base)).status, 401);
    });
});

test("admin routes fall back to API_KEY", async () => {
    await withAdminServer({ API_KEY: "main" }, async (base) => {
        assert.strictEqual((await admin(base, "main")).status, 200);
        assert.strictEqual((await admin(base)).status, 401);
    });
});

test("admin routes fail closed with no key, unless AUTH_DISABLED=true", async () => {
    await withAdminServer({}, async (base) => {
        assert.strictEqual((await admin(base)).status, 503);
    });
    await withAdminServer({ AUTH_DISABLED: "true" }, async (base) => {
        assert.strictEqual((await admin(base)).status, 200);
    });
});
