require("dotenv").config();
const path = require("path");
const { createApp } = require("./app");
const { createLedger, parseActor, closeAll } = require("./services/fabric");
const { createPharmaService } = require("./services/pharmatrace");
const { createIotService } = require("./services/iotService");
const { ReadingStore } = require("./iot/store");
const { UserStore } = require("./auth/users");
const { createBoxService } = require("./services/boxService");
const { loadPrivateKey } = require("./box/token");
const { UnlockAudit } = require("./box/audit");
const fs = require("fs");

const env = process.env;
const PORT = env.PORT || 3001;

// Connections to Fabric open on first use, so the API starts (and answers 503 on ledger calls)
// even while the network is down.
const ledger = createLedger(env);
const pharma = createPharmaService({ ledger, manufacturer: parseActor(env.MANUFACTURER_ORG || "lab").mspId });
const iot = createIotService({
    ledger,
    store: new ReadingStore(env.IOT_DATA_DIR || path.join(__dirname, "data/iot")),
    gateway: parseActor(env.IOT_GATEWAY_IDENTITY || "dist:IotGateway"),
    sampleSeconds: Number(env.IOT_SAMPLE_SECONDS) || 60,
    maxClockSkewSeconds: env.IOT_MAX_CLOCK_SKEW_SECONDS !== undefined ? Number(env.IOT_MAX_CLOCK_SKEW_SECONDS) : 30,
});

// People using the mobile app, and the key that signs PharmaBox unlock tokens (both optional:
// without them /api/auth and /api/box answer 503). See iot/docs/BOX_UNLOCK.md.
const users = new UserStore(env.USERS_FILE || path.join(__dirname, "data/users.json"));
const box = createBoxService({
    iot,
    pharma,
    privateKey: env.UNLOCK_KEY_FILE ? loadPrivateKey(fs.readFileSync(env.UNLOCK_KEY_FILE)) : null,
    audit: new UnlockAudit(env.UNLOCK_AUDIT_FILE || path.join(__dirname, "data/unlock-audit.jsonl")),
    ttlSeconds: Number(env.UNLOCK_TOKEN_TTL_SECONDS) || 120,
});

if (!env.SESSION_SECRET) console.warn("⚠️  SESSION_SECRET is not set: /api/auth and /api/box will answer 503.");
if (!env.UNLOCK_KEY_FILE) console.warn("⚠️  UNLOCK_KEY_FILE is not set: PharmaBox unlock tokens cannot be issued.");

if (!env.API_KEY && env.AUTH_DISABLED !== "true") {
    console.warn("⚠️  API_KEY is not set: write endpoints will answer 503 (set AUTH_DISABLED=true for local development).");
}

const server = createApp({ pharma, iot, users, box, env }).listen(PORT, () => {
    console.log(`✅ PharmaTrace API running on http://localhost:${PORT}`);

    // Optional: anchor the IoT readings of every monitored cargo on a timer.
    const anchorEvery = Number(env.IOT_ANCHOR_INTERVAL_SECONDS);
    if (anchorEvery > 0) {
        iot.startAnchorLoop(anchorEvery);
        console.log(`⚓ Anchoring IoT readings every ${anchorEvery}s`);
    }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        closeAll();
        server.close(() => process.exit(0));
    });
}
