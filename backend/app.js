const express = require("express");
const cors = require("cors");
const { requireApiKey } = require("./middleware/auth");
const { batchRoutes, orgRoutes } = require("./routes/batches");
const { cargoRoutes } = require("./routes/cargo");
const { iotRoutes } = require("./routes/iot");

// The HTTP API. Services are passed in so the tests can run it against a fake ledger.
function createApp({ pharma, iot, env = process.env }) {
    const app = express();
    app.use(cors());
    app.use(express.json());

    // Reads are public; anything else submits a transaction and needs the x-api-key header
    // (API_KEY). /api/iot has its own rules (readings are validated by their device signature,
    // the admin routes by IOT_API_KEY), so it is left out of this check.
    const writeGuard = requireApiKey(env);
    app.use("/api", (req, res, next) => (req.path.startsWith("/iot") ? next() : writeGuard(req, res, next)));

    app.use("/api/batches", batchRoutes(pharma, env));
    app.use("/api/orgs", orgRoutes(pharma));
    app.use("/api/cargo", cargoRoutes(pharma));
    app.use("/api/iot", iotRoutes(iot, env));

    app.get("/", (req, res) => res.send("PharmaTrace API on Hyperledger Fabric 🚀"));
    app.get("/healthz", (req, res) => res.json({ ok: true }));
    return app;
}

module.exports = { createApp };
