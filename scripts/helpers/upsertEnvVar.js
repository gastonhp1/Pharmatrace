const fs = require("fs");

// Sets KEY=value in an env file: replaces the existing KEY line, or appends a new one.
// Creates the file if it does not exist.
function upsertEnvVar(filePath, key, value) {
    const line = `${key}=${value}`;
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const pattern = new RegExp(`^${key}=.*$`, "m");

    let next;
    if (pattern.test(current)) {
        next = current.replace(pattern, () => line);
    } else {
        const separator = current === "" || current.endsWith("\n") ? "" : "\n";
        next = `${current}${separator}${line}\n`;
    }

    fs.writeFileSync(filePath, next);
}

module.exports = { upsertEnvVar };
