#!/usr/bin/env node
// The ECDSA P-256 key that signs PharmaBox unlock tokens.
//
//   node scripts/unlock-key.js generate <file.pem>   creates the private key (mode 600) and prints
//                                                    the public key ready for the firmware
//   node scripts/unlock-key.js public <file.pem>     prints the public key again
//
// The private key stays with the backend (ideally a KMS/HSM later); the box gets only the public
// one, in Pharmatrace-firmware include/unlock_key.h.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { publicKeyXY, loadPrivateKey } = require("../box/token");

function printPublic(key) {
    const xy = publicKeyXY(key);
    console.log(`Public key (X||Y, hex):\n${xy.toString("hex")}\n`);
    const bytes = [...xy].map((b) => `0x${b.toString(16).padStart(2, "0")}`);
    const rows = [];
    for (let i = 0; i < bytes.length; i += 16) rows.push(`    ${bytes.slice(i, i + 16).join(", ")},`);
    console.log("Pharmatrace-firmware include/unlock_key.h:\n#pragma once\n#include <stdint.h>\n");
    console.log(`constexpr uint8_t UNLOCK_PUBKEY[64] = {\n${rows.join("\n")}\n};`);
}

const [cmd, file] = process.argv.slice(2);
if (cmd === "generate" && file) {
    if (fs.existsSync(file)) {
        console.error(`❌ ${file} already exists: not overwriting a signing key`);
        process.exit(1);
    }
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    console.log(`✅ Private key in ${file} (set UNLOCK_KEY_FILE to it)\n`);
    printPublic(privateKey);
} else if (cmd === "public" && file) {
    printPublic(loadPrivateKey(fs.readFileSync(file)));
} else {
    console.error("usage: unlock-key.js generate <file.pem> | public <file.pem>");
    process.exit(2);
}
