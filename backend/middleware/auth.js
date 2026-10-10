const crypto = require("crypto");

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Constant-time comparison. Hashing first makes both buffers the same length.
function safeEqual(a, b) {
    const ha = crypto.createHash("sha256").update(String(a)).digest();
    const hb = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// Protects every route that is not a read (the ones that sign transactions with the actors'
// keys) with a shared API key sent in the `x-api-key` header.
//
// It fails closed: with no API_KEY configured, writes are refused (503) unless
// AUTH_DISABLED=true is set explicitly (local development).
function requireApiKey(env = process.env) {
    return function apiKeyMiddleware(req, res, next) {
        if (READ_METHODS.has(req.method)) return next();
        if (env.AUTH_DISABLED === "true") return next();

        if (!env.API_KEY) {
            return res
                .status(503)
                .json({ error: "API_KEY is not configured on the server (or set AUTH_DISABLED=true for local development)" });
        }

        const provided = req.get("x-api-key");
        if (!provided || !safeEqual(provided, env.API_KEY)) {
            return res.status(401).json({ error: "Missing or invalid API key" });
        }

        next();
    };
}

module.exports = { requireApiKey };
