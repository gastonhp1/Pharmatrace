const crypto = require("crypto");
const { ApiError } = require("../utils/errors");

// Unlock token for the PharmaBox, byte for byte what the firmware checks
// (gastonhp1/Pharmatrace-firmware, lib/pharma_proto/src/pharma_unlock.h, docs/unlock-protocol.md).
//
// 106 bytes, big-endian:
//   off  size  field
//     0     1  version   = 1
//     1     1  action    = 1 (open)
//     2     8  dev       first 8 bytes of SHA-256(deviceId): binds the token to ONE box
//    10    16  nonce     the one the box shows in its QR
//    26     4  iat       issued at (unix seconds)
//    30     4  exp       expires (unix seconds)
//    34     8  actor     first 8 bytes of SHA-256("<mspId>:<username>"): audit without personal data
//    42    64  signature ECDSA P-256 over SHA-256(bytes 0..41), raw r || s

const VERSION = 1;
const ACTION_OPEN = 1;
const NONCE_SIZE = 16;
const BODY_SIZE = 42;
const TOKEN_SIZE = 106;
const MAX_LIFETIME_S = 300; // the box rejects anything longer
const DEVICE_ID = /^[A-Za-z0-9_-]{1,24}$/;

const sha256 = (data) => crypto.createHash("sha256").update(data).digest();
const deviceTag = (deviceId) => sha256(Buffer.from(deviceId, "utf8")).subarray(0, 8);
const actorTag = (mspId, username) => sha256(Buffer.from(`${mspId}:${username}`, "utf8")).subarray(0, 8);

// "PB1:<deviceId>:<nonce base64url>" -> { deviceId, nonce }
function parseQr(text) {
    const parts = typeof text === "string" ? text.trim().split(":") : [];
    if (parts.length !== 3 || parts[0] !== "PB1") throw new ApiError(400, "qr must be PB1:<deviceId>:<nonce>");
    const [, deviceId, nonceText] = parts;
    return { deviceId: requireDeviceId(deviceId), nonce: decodeNonce(nonceText) };
}

function requireDeviceId(value) {
    if (typeof value !== "string" || !DEVICE_ID.test(value)) throw new ApiError(400, "deviceId: 1 to 24 characters among A-Z a-z 0-9 _ -");
    return value;
}

// base64url, no padding, exactly 16 bytes (22 characters).
function decodeNonce(text) {
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(text)) throw new ApiError(400, "nonce must be 16 bytes in base64url");
    const nonce = Buffer.from(text, "base64url");
    if (nonce.length !== NONCE_SIZE || nonce.toString("base64url") !== text) throw new ApiError(400, "nonce must be 16 bytes in base64url");
    return nonce;
}

function buildToken({ deviceId, nonce, mspId, username, privateKey, ttlSeconds = 120, now = Math.floor(Date.now() / 1000) }) {
    if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_SIZE) throw new Error("nonce must be 16 bytes");
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_LIFETIME_S) throw new Error(`ttl must be 1..${MAX_LIFETIME_S} s`);
    const body = Buffer.alloc(BODY_SIZE);
    body[0] = VERSION;
    body[1] = ACTION_OPEN;
    deviceTag(deviceId).copy(body, 2);
    nonce.copy(body, 10);
    body.writeUInt32BE(now, 26);
    body.writeUInt32BE(now + ttlSeconds, 30);
    actorTag(mspId, username).copy(body, 34);
    // Node hashes `body` with SHA-256 and signs the digest; ieee-p1363 gives the raw r || s.
    const signature = crypto.sign("sha256", body, { key: privateKey, dsaEncoding: "ieee-p1363" });
    return { token: Buffer.concat([body, signature]), iat: now, exp: now + ttlSeconds };
}

// Checks a token the way the box does (format, box, nonce, signature). Used by the tests and by
// `scripts/unlock-key.js check`; the box does not need it.
function verifyToken(token, { deviceId, nonce, publicKey }) {
    if (!Buffer.isBuffer(token) || token.length !== TOKEN_SIZE) return "BadFormat";
    if (token[0] !== VERSION || token[1] !== ACTION_OPEN) return "BadFormat";
    const iat = token.readUInt32BE(26);
    const exp = token.readUInt32BE(30);
    if (exp <= iat || exp - iat > MAX_LIFETIME_S) return "BadFormat";
    if (!token.subarray(2, 10).equals(deviceTag(deviceId))) return "WrongBox";
    if (!token.subarray(10, 26).equals(nonce)) return "BadNonce";
    const ok = crypto.verify("sha256", token.subarray(0, BODY_SIZE), { key: publicKey, dsaEncoding: "ieee-p1363" }, token.subarray(BODY_SIZE));
    return ok ? "Ok" : "BadSignature";
}

// Public key as the firmware wants it (include/unlock_key.h): X || Y, 64 bytes.
function publicKeyXY(key) {
    const jwk = crypto.createPublicKey(key).export({ format: "jwk" });
    if (jwk.crv !== "P-256") throw new Error("the unlock key must be ECDSA P-256");
    return Buffer.concat([Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
}

function loadPrivateKey(pem) {
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails.namedCurve !== "prime256v1") {
        throw new Error("the unlock key must be ECDSA P-256 (prime256v1)");
    }
    return key;
}

module.exports = {
    TOKEN_SIZE,
    MAX_LIFETIME_S,
    parseQr,
    requireDeviceId,
    decodeNonce,
    buildToken,
    verifyToken,
    publicKeyXY,
    loadPrivateKey,
    deviceTag,
    actorTag,
};
