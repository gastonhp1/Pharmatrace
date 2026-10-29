const crypto = require("crypto");

// Session tokens: compact JWTs signed with HS256 (HMAC-SHA256) and SESSION_SECRET.
// Claims: sub (username), msp (MSP ID of the user's org), iat, exp. Hand-rolled on purpose: the
// algorithm is fixed here and never read from the token header, which rules out the "alg: none"
// and algorithm-confusion attacks of generic JWT libraries.

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

const sign = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest();

function issueSession(secret, { username, mspId }, { ttlSeconds = 8 * 3600, now = Math.floor(Date.now() / 1000) } = {}) {
    if (!secret) throw new Error("SESSION_SECRET is not set");
    const payload = Buffer.from(JSON.stringify({ sub: username, msp: mspId, iat: now, exp: now + ttlSeconds })).toString("base64url");
    const body = `${HEADER}.${payload}`;
    return { token: `${body}.${sign(secret, body).toString("base64url")}`, expiresAt: new Date((now + ttlSeconds) * 1000).toISOString() };
}

// Returns { username, mspId } or null. Never throws on bad input.
function verifySession(secret, token, { now = Math.floor(Date.now() / 1000) } = {}) {
    if (!secret || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== HEADER) return null;
    const expected = sign(secret, `${parts[0]}.${parts[1]}`);
    const given = Buffer.from(parts[2], "base64url");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let claims;
    try {
        claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
        return null;
    }
    if (typeof claims.sub !== "string" || typeof claims.msp !== "string" || !Number.isInteger(claims.exp)) return null;
    if (claims.exp <= now) return null;
    return { username: claims.sub, mspId: claims.msp };
}

module.exports = { issueSession, verifySession };
