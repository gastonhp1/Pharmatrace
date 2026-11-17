const crypto = require("crypto");

const sign = (secret, body) => "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

// Sends every notification to the configured URLs as a JSON POST. With a secret, the body is
// signed (HMAC-SHA256) in the x-pharmatrace-signature header so the receiver can check where it
// comes from.
//
// Delivery is best effort: a few attempts, then it is logged and dropped. The feed
// (GET /api/notifications) is the record; a webhook is only the doorbell.
function createWebhooks({ urls = [], secret = "", attempts = 3, backoffMs = 1000, timeoutMs = 5000, fetchImpl = fetch, log = console } = {}) {
    async function deliver(url, body, headers) {
        let last;
        for (let i = 0; i < attempts; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (i - 1)));
            try {
                const res = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
                if (res.ok) return true;
                last = `HTTP ${res.status}`;
            } catch (err) {
                last = err.message;
            }
        }
        log.warn(`⚠️  webhook ${new URL(url).host} failed after ${attempts} attempts: ${last}`);
        return false;
    }

    return {
        enabled: urls.length > 0,
        // Resolves with how many URLs got it. Never rejects.
        async send(notification) {
            if (urls.length === 0) return 0;
            const body = JSON.stringify(notification);
            const headers = { "content-type": "application/json", "x-pharmatrace-event": notification.event };
            if (secret) headers["x-pharmatrace-signature"] = sign(secret, body);
            const results = await Promise.all(urls.map((url) => deliver(url, body, headers)));
            return results.filter(Boolean).length;
        },
    };
}

module.exports = { createWebhooks, sign };
