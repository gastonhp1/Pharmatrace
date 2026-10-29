const fs = require("fs");
const path = require("path");
const { hashPassword, verifyPassword } = require("./password");

// Users of the API, one org (MSP) each. Kept in a JSON file (USERS_FILE, outside the repo):
//   { "users": [ { "username": "ana", "mspId": "FarmaMSP", "passwordHash": "scrypt$..." } ] }
// Managed with `node scripts/user.js`. Each org running its own API (see services/fabric.js)
// would have only its own users here.

const MSP_IDS = new Set(["LabMSP", "DistMSP", "FarmaMSP", "RegMSP"]);
const USERNAME = /^[a-z0-9._-]{2,32}$/;

// Dummy hash checked when the user does not exist, so a login takes the same time either way.
let dummyHash = null;

class UserStore {
    constructor(file) {
        this.file = file;
    }

    load() {
        if (!this.file || !fs.existsSync(this.file)) return [];
        const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
        return Array.isArray(data.users) ? data.users : [];
    }

    find(username) {
        return this.load().find((u) => u.username === username) || null;
    }

    // { username, mspId } when the password matches, null otherwise.
    async authenticate(username, password) {
        const user = typeof username === "string" ? this.find(username.toLowerCase()) : null;
        if (!user) {
            dummyHash = dummyHash || (await hashPassword("not-a-real-password"));
            await verifyPassword(String(password), dummyHash);
            return null;
        }
        return (await verifyPassword(String(password), user.passwordHash)) ? { username: user.username, mspId: user.mspId } : null;
    }

    async upsert(username, mspId, password) {
        username = String(username).toLowerCase();
        if (!USERNAME.test(username)) throw new Error("username: 2 to 32 characters among a-z 0-9 . _ -");
        if (!MSP_IDS.has(mspId)) throw new Error(`mspId must be one of ${[...MSP_IDS].join(", ")}`);
        const users = this.load().filter((u) => u.username !== username);
        users.push({ username, mspId, passwordHash: await hashPassword(password) });
        users.sort((a, b) => a.username.localeCompare(b.username));
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify({ users }, null, 2) + "\n", { mode: 0o600 });
    }

    remove(username) {
        const users = this.load();
        const kept = users.filter((u) => u.username !== String(username).toLowerCase());
        fs.writeFileSync(this.file, JSON.stringify({ users: kept }, null, 2) + "\n", { mode: 0o600 });
        return kept.length !== users.length;
    }
}

module.exports = { UserStore, MSP_IDS };
