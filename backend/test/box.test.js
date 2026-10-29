const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createApp } = require("../app");
const { createPharmaService } = require("../services/pharmatrace");
const { createBoxService } = require("../services/boxService");
const { UserStore } = require("../auth/users");
const { UnlockAudit } = require("../box/audit");
const { hashPassword, verifyPassword } = require("../auth/password");
const { issueSession, verifySession } = require("../auth/session");
const { LoginThrottle } = require("../routes/auth");
const { canUnlock } = require("../box/policy");
const token = require("../box/token");
const { ApiError } = require("../utils/errors");

const SECRET = "test-session-secret";
const NONCE = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const NONCE_TEXT = NONCE.toString("base64url"); // AAECAwQFBgcICQoLDA0ODw
const { privateKey: KEY } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

// ---------------------------------------------------------------- passwords and sessions

describe("passwords", () => {
    test("hash and verify", async () => {
        const h = await hashPassword("correct horse");
        assert.match(h, /^scrypt\$32768\$8\$1\$/);
        assert.equal(await verifyPassword("correct horse", h), true);
        assert.equal(await verifyPassword("correct hors", h), false);
        assert.equal(await verifyPassword("x", "garbage"), false);
    });
    test("short passwords are refused", async () => {
        await assert.rejects(hashPassword("short"), /at least 8/);
    });
});

describe("sessions", () => {
    const user = { username: "ana", mspId: "FarmaMSP" };
    test("round trip", () => {
        const { token: t } = issueSession(SECRET, user);
        assert.deepEqual(verifySession(SECRET, t), user);
    });
    test("expired, tampered, other secret and alg none are rejected", () => {
        const { token: t } = issueSession(SECRET, user, { ttlSeconds: 10, now: 1000 });
        assert.equal(verifySession(SECRET, t, { now: 1010 }), null);
        assert.deepEqual(verifySession(SECRET, t, { now: 1009 }), user);
        assert.equal(verifySession("other", t, { now: 1000 }), null);

        const [h, , s] = t.split(".");
        const forged = Buffer.from(JSON.stringify({ sub: "ana", msp: "RegMSP", iat: 1000, exp: 9e9 })).toString("base64url");
        assert.equal(verifySession(SECRET, `${h}.${forged}.${s}`, { now: 1000 }), null);

        const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
        assert.equal(verifySession(SECRET, `${none}.${forged}.`, { now: 1000 }), null);
        assert.equal(verifySession(SECRET, "not.a.token"), null);
        assert.equal(verifySession(SECRET, undefined), null);
    });
});

describe("login throttle", () => {
    test("blocks after max failures inside the window and recovers after it", () => {
        let now = 0;
        const t = new LoginThrottle({ max: 2, windowMs: 1000, now: () => now });
        t.fail(["u:ana"]);
        assert.equal(t.blocked(["u:ana"]), false);
        t.fail(["u:ana"]);
        assert.equal(t.blocked(["u:ana"]), true);
        now = 1001;
        assert.equal(t.blocked(["u:ana"]), false);
    });
});

// ---------------------------------------------------------------- token format

describe("unlock token", () => {
    test("layout matches pharma_unlock.h", () => {
        const { token: t, iat, exp } = token.buildToken({ deviceId: "VAL-001", nonce: NONCE, mspId: "FarmaMSP", username: "ana", privateKey: KEY, ttlSeconds: 120, now: 1_700_000_000 });
        assert.equal(t.length, 106);
        assert.equal(t[0], 1);
        assert.equal(t[1], 1);
        assert.deepEqual(t.subarray(2, 10), crypto.createHash("sha256").update("VAL-001").digest().subarray(0, 8));
        assert.deepEqual(t.subarray(10, 26), NONCE);
        assert.equal(t.readUInt32BE(26), 1_700_000_000);
        assert.equal(t.readUInt32BE(30), 1_700_000_120);
        assert.deepEqual(t.subarray(34, 42), crypto.createHash("sha256").update("FarmaMSP:ana").digest().subarray(0, 8));
        assert.equal(iat, 1_700_000_000);
        assert.equal(exp, 1_700_000_120);

        // The signature is ECDSA P-256 over SHA-256(bytes 0..41), raw r || s: check it with a
        // DER re-encoding, independently of the helper under test.
        const r = t.subarray(42, 74), s = t.subarray(74, 106);
        const derInt = (b) => {
            let i = 0;
            while (i < b.length - 1 && b[i] === 0) i++;
            b = b.subarray(i);
            if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
            return Buffer.concat([Buffer.from([0x02, b.length]), b]);
        };
        const seq = Buffer.concat([derInt(r), derInt(s)]);
        const der = Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
        assert.equal(crypto.verify("sha256", t.subarray(0, 42), { key: crypto.createPublicKey(KEY), dsaEncoding: "der" }, der), true);
    });

    test("verifyToken mirrors the checks of the box", () => {
        const pub = crypto.createPublicKey(KEY);
        const { token: t } = token.buildToken({ deviceId: "VAL-001", nonce: NONCE, mspId: "RegMSP", username: "r", privateKey: KEY });
        assert.equal(token.verifyToken(t, { deviceId: "VAL-001", nonce: NONCE, publicKey: pub }), "Ok");
        assert.equal(token.verifyToken(t, { deviceId: "VAL-002", nonce: NONCE, publicKey: pub }), "WrongBox");
        assert.equal(token.verifyToken(t, { deviceId: "VAL-001", nonce: Buffer.alloc(16), publicKey: pub }), "BadNonce");
        const bad = Buffer.from(t);
        bad[50] ^= 1;
        assert.equal(token.verifyToken(bad, { deviceId: "VAL-001", nonce: NONCE, publicKey: pub }), "BadSignature");
        const other = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
        assert.equal(token.verifyToken(t, { deviceId: "VAL-001", nonce: NONCE, publicKey: other }), "BadSignature");
        assert.equal(token.verifyToken(t.subarray(0, 105), { deviceId: "VAL-001", nonce: NONCE, publicKey: pub }), "BadFormat");
    });

    test("ttl is bounded by what the box accepts", () => {
        assert.throws(() => token.buildToken({ deviceId: "V", nonce: NONCE, mspId: "RegMSP", username: "r", privateKey: KEY, ttlSeconds: 301 }), /ttl/);
    });

    test("QR parsing", () => {
        assert.deepEqual(token.parseQr(`PB1:VAL-001:${NONCE_TEXT}`), { deviceId: "VAL-001", nonce: NONCE });
        assert.equal(NONCE_TEXT, "AAECAwQFBgcICQoLDA0ODw");
        for (const bad of ["", "PB2:VAL-001:" + NONCE_TEXT, "PB1:VAL 001:" + NONCE_TEXT, "PB1:VAL-001:AAEC", "PB1:" + "x".repeat(25) + ":" + NONCE_TEXT, `PB1:VAL-001:${NONCE_TEXT}:x`, "PB1:VAL-001:AAECAwQFBgcICQoLDA0ODx"]) {
            assert.throws(() => token.parseQr(bad), ApiError, bad);
        }
    });

    test("public key X||Y matches the JWK", () => {
        const xy = token.publicKeyXY(KEY);
        assert.equal(xy.length, 64);
        const jwk = crypto.createPublicKey(KEY).export({ format: "jwk" });
        assert.equal(xy.subarray(0, 32).toString("base64url"), jwk.x);
    });

    test("only P-256 keys are accepted", () => {
        const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" });
        assert.throws(() => token.loadPrivateKey(rsa), /P-256/);
        const k1 = crypto.generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey.export({ type: "pkcs8", format: "pem" });
        assert.throws(() => token.loadPrivateKey(k1), /P-256/);
    });
});

// ---------------------------------------------------------------- who can open

describe("unlock policy", () => {
    const device = { org: "LabMSP", active: true, activeCargo: "C1" };
    const cargo = (state, owner, pendingTo = "") => ({ state, owner, pendingTo });
    const allowed = (mspId, d, c) => canUnlock({ mspId, device: d, cargo: c }).allowed;

    test("regulator always", () => {
        assert.equal(allowed("RegMSP", device, cargo("IN_TRANSIT", "LabMSP", "DistMSP")), true);
        assert.equal(allowed("RegMSP", { ...device, activeCargo: "" }, null), true);
    });
    test("free box: the org that registered it", () => {
        const free = { ...device, activeCargo: "" };
        assert.equal(allowed("LabMSP", free, null), true);
        assert.equal(allowed("DistMSP", free, null), false);
    });
    test("OPEN: owner only", () => {
        assert.equal(allowed("LabMSP", device, cargo("OPEN", "LabMSP")), true);
        assert.equal(allowed("DistMSP", device, cargo("OPEN", "LabMSP")), false);
    });
    test("IN_TRANSIT: recipient only, not the sender", () => {
        const c = cargo("IN_TRANSIT", "LabMSP", "DistMSP");
        assert.equal(allowed("DistMSP", device, c), true);
        assert.equal(allowed("LabMSP", device, c), false);
        assert.equal(allowed("FarmaMSP", device, c), false);
    });
    test("DELIVERED and DISSOLVED: owner", () => {
        assert.equal(allowed("DistMSP", device, cargo("DELIVERED", "DistMSP")), true);
        assert.equal(allowed("LabMSP", device, cargo("DELIVERED", "DistMSP")), false);
        assert.equal(allowed("LabMSP", device, cargo("DISSOLVED", "LabMSP")), true);
    });
    test("missing cargo or unknown state: denied", () => {
        assert.equal(allowed("LabMSP", device, null), false);
        assert.equal(allowed("LabMSP", device, cargo("WEIRD", "LabMSP")), false);
    });
});

// ---------------------------------------------------------------- HTTP

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "box-"));

function ledgerWith({ device, cargo }) {
    const answer = (fn, args) => {
        if (fn === "GetDevice") {
            if (!device || args[0] !== device.id) throw new ApiError(404, `device ${args[0]} not found`);
            return device;
        }
        if (fn === "ReadCargo") {
            if (!cargo || args[0] !== cargo.id) throw new ApiError(404, `cargo ${args[0]} not found`);
            return cargo;
        }
        return null;
    };
    return { evaluate: async (actor, fn, args) => answer(fn, args), submit: async () => assert.fail("no writes expected") };
}

async function withServer({ device, cargo, env = { SESSION_SECRET: SECRET, API_KEY: "k" }, privateKey = KEY }, fn) {
    const dir = tmp();
    const users = new UserStore(path.join(dir, "users.json"));
    await users.upsert("ana", "FarmaMSP", "password-ana");
    await users.upsert("dario", "DistMSP", "password-dario");
    await users.upsert("rita", "RegMSP", "password-rita");
    const audit = new UnlockAudit(path.join(dir, "audit.jsonl"));

    const ledger = ledgerWith({ device, cargo });
    const pharma = createPharmaService({ ledger });
    const iot = { getDevice: (id) => ledger.evaluate({ mspId: "RegMSP" }, "GetDevice", [id]) };
    const box = createBoxService({ iot, pharma, privateKey, audit, now: () => 1_700_000_000 });
    const server = createApp({ pharma, iot, users, box, env }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;

    const call = async (method, url, body, headers = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: { "content-type": "application/json", ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };
    const login = async (username) => {
        const res = await call("POST", "/api/auth/login", { username, password: `password-${username}` });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return { authorization: `Bearer ${res.body.token}` };
    };
    try {
        await fn({ call, login, audit });
    } finally {
        server.close();
    }
}

const DEVICE = { id: "VAL-001", org: "LabMSP", active: true, activeCargo: "C1" };
const IN_TRANSIT = { id: "C1", owner: "LabMSP", pendingTo: "DistMSP", state: "IN_TRANSIT" };
const QR = `PB1:VAL-001:${NONCE_TEXT}`;

describe("POST /api/auth/login", () => {
    test("issues a session for valid credentials, without the API key", async () => {
        await withServer({ device: DEVICE }, async ({ call }) => {
            const res = await call("POST", "/api/auth/login", { username: "Ana", password: "password-ana" });
            assert.equal(res.status, 200);
            assert.deepEqual(res.body.user, { username: "ana", mspId: "FarmaMSP" });
            const me = await call("GET", "/api/auth/me", undefined, { authorization: `Bearer ${res.body.token}` });
            assert.deepEqual(me.body, { username: "ana", mspId: "FarmaMSP" });
        });
    });
    test("wrong password and unknown user answer the same 401", async () => {
        await withServer({ device: DEVICE }, async ({ call }) => {
            const a = await call("POST", "/api/auth/login", { username: "ana", password: "nope-nope" });
            const b = await call("POST", "/api/auth/login", { username: "ghost", password: "nope-nope" });
            assert.equal(a.status, 401);
            assert.deepEqual(a.body, b.body);
        });
    });
    test("throttles after repeated failures", async () => {
        await withServer({ device: DEVICE }, async ({ call }) => {
            for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/auth/login", { username: "ana", password: "wrong-wrong" })).status, 401);
            assert.equal((await call("POST", "/api/auth/login", { username: "ana", password: "password-ana" })).status, 429);
        });
    });
    test("fails closed without SESSION_SECRET", async () => {
        await withServer({ device: DEVICE, env: { API_KEY: "k" } }, async ({ call }) => {
            assert.equal((await call("POST", "/api/auth/login", { username: "ana", password: "password-ana" })).status, 503);
            assert.equal((await call("POST", "/api/box/unlock", { qr: QR })).status, 503);
        });
    });
});

describe("POST /api/box/unlock", () => {
    test("needs a session (the API key is not enough)", async () => {
        await withServer({ device: DEVICE, cargo: IN_TRANSIT }, async ({ call }) => {
            assert.equal((await call("POST", "/api/box/unlock", { qr: QR })).status, 401);
            assert.equal((await call("POST", "/api/box/unlock", { qr: QR }, { "x-api-key": "k" })).status, 401);
        });
    });

    test("the recipient of a cargo in transit gets a token the box would accept", async () => {
        await withServer({ device: DEVICE, cargo: IN_TRANSIT }, async ({ call, login, audit }) => {
            const res = await call("POST", "/api/box/unlock", { qr: QR }, await login("dario"));
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.cargoId, "C1");
            assert.equal(res.body.cargoState, "IN_TRANSIT");
            assert.equal(res.body.expiresAt, new Date((1_700_000_000 + 120) * 1000).toISOString());
            const t = Buffer.from(res.body.token, "hex");
            assert.equal(token.verifyToken(t, { deviceId: "VAL-001", nonce: NONCE, publicKey: crypto.createPublicKey(KEY) }), "Ok");
            assert.deepEqual(t.subarray(34, 42), token.actorTag("DistMSP", "dario"));

            const [entry] = audit.recent();
            assert.equal(entry.granted, true);
            assert.equal(entry.username, "dario");
            assert.equal(entry.cargoId, "C1");
        });
    });

    test("{ deviceId, nonce } works as well as { qr }", async () => {
        await withServer({ device: DEVICE, cargo: IN_TRANSIT }, async ({ call, login }) => {
            const res = await call("POST", "/api/box/unlock", { deviceId: "VAL-001", nonce: NONCE_TEXT }, await login("dario"));
            assert.equal(res.status, 200);
        });
    });

    test("anyone else is denied with 403, and the denial is audited", async () => {
        await withServer({ device: DEVICE, cargo: IN_TRANSIT }, async ({ call, login, audit }) => {
            const res = await call("POST", "/api/box/unlock", { qr: QR }, await login("ana"));
            assert.equal(res.status, 403);
            assert.match(res.body.error, /recipient DistMSP/);
            assert.equal(res.body.token, undefined);
            const [entry] = audit.recent();
            assert.equal(entry.granted, false);
            assert.equal(entry.mspId, "FarmaMSP");
        });
    });

    test("the regulator can always open", async () => {
        await withServer({ device: DEVICE, cargo: IN_TRANSIT }, async ({ call, login }) => {
            assert.equal((await call("POST", "/api/box/unlock", { qr: QR }, await login("rita"))).status, 200);
        });
    });

    test("a deactivated box: only the regulator", async () => {
        const off = { ...DEVICE, active: false };
        await withServer({ device: off, cargo: IN_TRANSIT }, async ({ call, login }) => {
            assert.equal((await call("POST", "/api/box/unlock", { qr: QR }, await login("dario"))).status, 403);
            assert.equal((await call("POST", "/api/box/unlock", { qr: QR }, await login("rita"))).status, 200);
        });
    });

    test("unknown box is 404 and a malformed QR is 400", async () => {
        await withServer({ device: DEVICE, cargo: IN_TRANSIT }, async ({ call, login }) => {
            const auth = await login("rita");
            assert.equal((await call("POST", "/api/box/unlock", { qr: `PB1:VAL-999:${NONCE_TEXT}` }, auth)).status, 404);
            assert.equal((await call("POST", "/api/box/unlock", { qr: "PB1:VAL-001:short" }, auth)).status, 400);
            assert.equal((await call("POST", "/api/box/unlock", {}, auth)).status, 400);
        });
    });

    test("without an unlock key it answers 503", async () => {
        await withServer({ device: DEVICE, cargo: IN_TRANSIT, privateKey: null }, async ({ call, login }) => {
            assert.equal((await call("POST", "/api/box/unlock", { qr: QR }, await login("rita"))).status, 503);
            assert.equal((await call("GET", "/api/box/unlock-key")).status, 503);
        });
    });
});

describe("GET /api/box/unlock-key and /api/box/audit", () => {
    test("public key is public, audit is for the regulator", async () => {
        await withServer({ device: DEVICE, cargo: IN_TRANSIT }, async ({ call, login }) => {
            const key = await call("GET", "/api/box/unlock-key");
            assert.equal(key.body.publicKey, token.publicKeyXY(KEY).toString("hex"));

            await call("POST", "/api/box/unlock", { qr: QR }, await login("dario"));
            assert.equal((await call("GET", "/api/box/audit", undefined, await login("dario"))).status, 403);
            const audit = await call("GET", "/api/box/audit?deviceId=VAL-001", undefined, await login("rita"));
            assert.equal(audit.status, 200);
            assert.equal(audit.body.length, 1);
        });
    });
});
