require("dotenv").config();
const path = require("path");
const { createApp } = require("./app");
const { createLedger, parseActor, closeAll } = require("./services/fabric");
const { createPharmaService } = require("./services/pharmatrace");
const { createIotService } = require("./services/iotService");
const { ReadingStore } = require("./iot/store");

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

if (!env.API_KEY && env.AUTH_DISABLED !== "true") {
    console.warn("⚠️  API_KEY is not set: write endpoints will answer 503 (set AUTH_DISABLED=true for local development).");
}

const server = createApp({ pharma, iot, env }).listen(PORT, () => {
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
