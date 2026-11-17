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
const { checkpointers } = require("@hyperledger/fabric-gateway");
const { NotificationStore } = require("./notifications/store");
const { createWebhooks } = require("./notifications/webhook");
const { createEventListener } = require("./notifications/listener");

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

// Notifications: the API listens to the chaincode events (as the regulator, who sees the whole
// channel), keeps the ones that matter in a feed and rings the configured webhooks.
const notificationsDir = env.NOTIFICATIONS_DIR || path.join(__dirname, "data/notifications");
const notifications = new NotificationStore(path.join(notificationsDir, "notifications.jsonl"));
let listener = null;
async function startNotifications() {
    fs.mkdirSync(notificationsDir, { recursive: true });
    const webhooks = createWebhooks({
        urls: (env.WEBHOOK_URLS || "").split(",").map((u) => u.trim()).filter(Boolean),
        secret: env.WEBHOOK_SECRET || "",
    });
    listener = createEventListener({
        source: (opts) => ledger.events(parseActor(env.NOTIFICATIONS_IDENTITY || "reg"), opts),
        checkpointer: await checkpointers.file(path.join(notificationsDir, "checkpoint.json")),
        store: notifications,
        webhooks,
    });
    listener.start();
    if (webhooks.enabled) console.log("🪝 Webhooks enabled");
}

const server = createApp({ pharma, iot, users, box, notifications, env }).listen(PORT, () => {
    console.log(`✅ PharmaTrace API running on http://localhost:${PORT}`);

    if (env.NOTIFICATIONS !== "off") {
        startNotifications().catch((err) => console.error("❌ Notifications could not start:", err.message));
    }

    // Optional: anchor the IoT readings of every monitored cargo on a timer.
    const anchorEvery = Number(env.IOT_ANCHOR_INTERVAL_SECONDS);
    if (anchorEvery > 0) {
        iot.startAnchorLoop(anchorEvery);
        console.log(`⚓ Anchoring IoT readings every ${anchorEvery}s`);
    }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
        if (listener) await listener.stop();
        closeAll();
        server.close(() => process.exit(0));
    });
}
