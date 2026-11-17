const fs = require("fs");
const path = require("path");

const SEVERITIES = ["info", "warning", "critical"];

// Notifications, one JSON object per line. Like the IoT reading store it is a file read by a
// single process: enough for one API instance, not for several.
class NotificationStore {
    constructor(file) {
        this.file = file;
        this.items = [];
        this.ids = new Set();
        if (file && fs.existsSync(file)) {
            for (const line of fs.readFileSync(file, "utf8").split("\n")) {
                if (!line) continue;
                const n = JSON.parse(line);
                this.items.push(n);
                this.ids.add(n.id);
            }
        }
    }

    // Returns the stored notification, or null if it was already there: after a reconnection
    // the peer can deliver again the events of the last block.
    add(notification) {
        if (this.ids.has(notification.id)) return null;
        const n = { ...notification, at: notification.at || new Date().toISOString() };
        if (this.file) {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.appendFileSync(this.file, JSON.stringify(n) + "\n");
        }
        this.items.push(n);
        this.ids.add(n.id);
        return n;
    }

    // Newest first. org: only the ones addressed to that MSP. severity: that level or worse.
    list({ org, severity, limit = 50 } = {}) {
        const min = severity ? SEVERITIES.indexOf(severity) : 0;
        const out = [];
        for (let i = this.items.length - 1; i >= 0 && out.length < limit; i--) {
            const n = this.items[i];
            if (org && !n.orgs.includes(org)) continue;
            if (SEVERITIES.indexOf(n.severity) < min) continue;
            out.push(n);
        }
        return out;
    }
}

module.exports = { NotificationStore, SEVERITIES };
