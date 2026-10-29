#!/usr/bin/env node
// Manage the users of the API (the people who log in from the mobile app).
//
//   node scripts/user.js add <username> <MSP>     asks for the password (or reads USER_PASSWORD)
//   node scripts/user.js remove <username>
//   node scripts/user.js list
//
// Writes USERS_FILE (default backend/data/users.json).
require("dotenv").config();
const path = require("path");
const readline = require("readline");
const { UserStore } = require("../auth/users");

const store = new UserStore(process.env.USERS_FILE || path.join(__dirname, "../data/users.json"));

function askHidden(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? s : "");
        rl.question(question, (answer) => {
            rl.close();
            process.stdout.write("\n");
            resolve(answer);
        });
    });
}

async function main([cmd, username, mspId]) {
    if (cmd === "add" && username && mspId) {
        let password = process.env.USER_PASSWORD;
        if (!password) {
            password = await askHidden("Password: ");
            if ((await askHidden("Repeat: ")) !== password) throw new Error("passwords do not match");
        }
        await store.upsert(username, mspId, password);
        console.log(`✅ ${username.toLowerCase()} (${mspId}) saved in ${store.file}`);
    } else if (cmd === "remove" && username) {
        console.log(store.remove(username) ? `🗑️  ${username} removed` : `${username} was not there`);
    } else if (cmd === "list") {
        for (const u of store.load()) console.log(`${u.username}\t${u.mspId}`);
    } else {
        console.error("usage: user.js add <username> <LabMSP|DistMSP|FarmaMSP|RegMSP> | remove <username> | list");
        process.exit(2);
    }
}

main(process.argv.slice(2)).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
});
