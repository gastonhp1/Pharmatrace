const fs = require("fs");
const path = require("path");

// Append-only log of every unlock decision, granted or denied, one JSON object per line.
// Off-chain on purpose for now: anchoring UNLOCK_GRANTED / UNLOCK_DENIED events in the chaincode
// is a later step. The box also reports FLAG_UNLOCK_GRANTED (0x08) inside its next signed reading,
// so a granted unlock does leave evidence in the ledger through the readings.
class UnlockAudit {
    constructor(file) {
        this.file = file;
    }

    record(entry) {
        const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
        if (!this.file) {
            console.log(`🔐 unlock ${line.trim()}`);
            return;
        }
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.appendFileSync(this.file, line, { mode: 0o600 });
    }

    // Most recent entries first, optionally only one box.
    recent({ deviceId, limit = 50 } = {}) {
        if (!this.file || !fs.existsSync(this.file)) return [];
        const out = [];
        const lines = fs.readFileSync(this.file, "utf8").trim().split("\n").reverse();
        for (const line of lines) {
            if (!line) continue;
            const e = JSON.parse(line);
            if (deviceId && e.deviceId !== deviceId) continue;
            out.push(e);
            if (out.length >= limit) break;
        }
        return out;
    }
}

module.exports = { UnlockAudit };
