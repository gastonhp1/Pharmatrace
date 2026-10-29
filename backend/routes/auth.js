const express = require("express");
const { issueSession } = require("../auth/session");
const { requireUser } = require("../middleware/auth");
const { requireString } = require("../utils/validate");
const { ApiError, sendError } = require("../utils/errors");

// Failed logins per username and per client address, in a sliding window. In memory: enough for
// one API instance; behind several replicas this belongs in the ingress or a shared store.
class LoginThrottle {
    constructor({ max = 5, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
        Object.assign(this, { max, windowMs, now, fails: new Map() });
    }
    recent(key) {
        const since = this.now() - this.windowMs;
        const list = (this.fails.get(key) || []).filter((t) => t > since);
        if (list.length) this.fails.set(key, list);
        else this.fails.delete(key);
        return list;
    }
    blocked(keys) {
        return keys.some((k) => this.recent(k).length >= this.max);
    }
    fail(keys) {
        for (const k of keys) this.fails.set(k, [...this.recent(k), this.now()]);
    }
    clear(key) {
        this.fails.delete(key);
    }
}

// /api/auth
function authRoutes(users, env = process.env, throttle = new LoginThrottle()) {
    const router = express.Router();
    const ttlSeconds = Number(env.SESSION_TTL_SECONDS) || 8 * 3600;

    // { username, password } -> { token, expiresAt, user: { username, mspId } }
    router.post("/login", async (req, res) => {
        try {
            if (!env.SESSION_SECRET) throw new ApiError(503, "SESSION_SECRET is not configured on the server");
            const { username, password } = req.body || {};
            requireString(username, "username");
            requireString(password, "password");
            const keys = [`u:${username.toLowerCase()}`, `ip:${req.ip}`];
            if (throttle.blocked(keys)) throw new ApiError(429, "Too many failed logins, try again later");

            const user = await users.authenticate(username, password);
            if (!user) {
                throttle.fail(keys);
                throw new ApiError(401, "Invalid username or password");
            }
            throttle.clear(keys[0]);
            const session = issueSession(env.SESSION_SECRET, user, { ttlSeconds });
            res.json({ ...session, user });
        } catch (err) {
            sendError(res, err, "Error logging in");
        }
    });

    router.get("/me", requireUser(env), (req, res) => res.json(req.user));

    return router;
}

module.exports = { authRoutes, LoginThrottle };
