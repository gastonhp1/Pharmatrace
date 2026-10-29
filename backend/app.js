const express = require("express");
const cors = require("cors");
const { requireApiKey } = require("./middleware/auth");
const { batchRoutes, orgRoutes } = require("./routes/batches");
const { cargoRoutes } = require("./routes/cargo");
const { iotRoutes } = require("./routes/iot");
const { authRoutes } = require("./routes/auth");
const { boxRoutes } = require("./routes/box");

// The HTTP API. Services are passed in so the tests can run it against a fake ledger.
function createApp({ pharma, iot, users, box, env = process.env }) {
    const app = express();
    app.use(cors());
    app.use(express.json());

    // Reads are public; anything else submits a transaction and needs the x-api-key header
    // (API_KEY). These have their own rules and are left out of this check:
    //   /api/iot   readings are validated by their device signature, admin routes by IOT_API_KEY
    //   /api/auth  login of the people using the mobile app
    //   /api/box   PharmaBox unlock: a user session (Authorization: Bearer)
    const writeGuard = requireApiKey(env);
    const ownRules = ["/iot", "/auth", "/box"];
    app.use("/api", (req, res, next) =>
        ownRules.some((p) => req.path === p || req.path.startsWith(p + "/")) ? next() : writeGuard(req, res, next)
    );

    app.use("/api/batches", batchRoutes(pharma, env));
    app.use("/api/orgs", orgRoutes(pharma));
    app.use("/api/cargo", cargoRoutes(pharma));
    app.use("/api/iot", iotRoutes(iot, env));
    if (users) app.use("/api/auth", authRoutes(users, env));
    if (box) app.use("/api/box", boxRoutes(box, env));

    app.get("/", (req, res) => res.send("PharmaTrace API on Hyperledger Fabric 🚀"));
    app.get("/healthz", (req, res) => res.json({ ok: true }));
    return app;
}

module.exports = { createApp };
