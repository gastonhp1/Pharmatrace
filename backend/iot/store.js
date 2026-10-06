const fs = require("fs");
const path = require("path");

// File-backed log of the readings the gateway accepted, one folder entry per cargo:
//
//   <dir>/<cargoId>.readings.jsonl   one accepted reading per line, in arrival order
//   <dir>/<cargoId>.state.json       which readings are already anchored (the windows)
//
// It is deliberately simple (sync fs, no locking): enough for a prototype with a single
// backend process. A real deployment needs a database; the interface below is what to replace.
class ReadingStore {
    constructor(dir) {
        this.dir = dir;
        fs.mkdirSync(dir, { recursive: true });
    }

    // Cargo ids are free text, so they are encoded before being used as a file name.
    _file(cargoId, kind) {
        return path.join(this.dir, `${encodeURIComponent(cargoId)}.${kind}`);
    }

    append(cargoId, record) {
        fs.appendFileSync(this._file(cargoId, "readings.jsonl"), JSON.stringify(record) + "\n");
    }

    readAll(cargoId) {
        const file = this._file(cargoId, "readings.jsonl");
        if (!fs.existsSync(file)) return [];
        return fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line));
    }

    // windows: [{ start, end, root, anchorIndex }] with start/end as indexes into readAll()
    // (end exclusive). reportedEvents: how many readings were already scanned for events.
    getState(cargoId) {
        const file = this._file(cargoId, "state.json");
        if (!fs.existsSync(file)) return { windows: [], eventsScanned: 0 };
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }

    setState(cargoId, state) {
        fs.writeFileSync(this._file(cargoId, "state.json"), JSON.stringify(state, null, 2));
    }

    // Cargos that have at least one reading on disk.
    listCargos() {
        return fs
            .readdirSync(this.dir)
            .filter((name) => name.endsWith(".readings.jsonl"))
            .map((name) => decodeURIComponent(name.slice(0, -".readings.jsonl".length)));
    }
}

module.exports = { ReadingStore };
