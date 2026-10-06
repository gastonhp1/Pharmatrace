const { ethers } = require("ethers");
const {
    FLAG_LID_OPENED,
    FLAG_SHOCK,
    FLAG_SEAL_BROKEN,
    decodeReading,
    leafHash,
} = require("./reading");
const { buildTree } = require("./merkle");

// EventKind enum of ColdChainMonitor.
const EVENT_KINDS = [
    { name: "LidOpened", index: 0, flag: FLAG_LID_OPENED },
    { name: "Shock", index: 1, flag: FLAG_SHOCK },
    { name: "SealBroken", index: 2, flag: FLAG_SEAL_BROKEN },
];

const payloadOf = (record) => Buffer.from(ethers.getBytes(record.payload));

// Builds the window ColdChainMonitor.anchorReadings expects from a run of stored readings.
//
// Time outside the range is measured sample-and-hold: a reading out of range counts until the
// next reading. The last reading of the window has no next one yet, so it counts
// `sampleSeconds` (the device's nominal period). That keeps every window self-contained, and
// guarantees that a window with a temperature outside the range always reports some time
// outside it, which is what the contract checks.
//
// policy: { minTemp, maxTemp } in hundredths of a degree, as numbers.
function buildWindow(records, policy, sampleSeconds) {
    if (records.length === 0) throw new Error("Cannot build a window without readings");

    const readings = records.map((record) => decodeReading(payloadOf(record)));
    const leaves = records.map((record) => leafHash(payloadOf(record)));
    const tree = buildTree(leaves);

    let minTemp = Infinity;
    let maxTemp = -Infinity;
    let excursionSeconds = 0;

    readings.forEach((reading, i) => {
        minTemp = Math.min(minTemp, reading.tempCenti);
        maxTemp = Math.max(maxTemp, reading.tempCenti);

        const outside = reading.tempCenti < policy.minTemp || reading.tempCenti > policy.maxTemp;
        if (outside) {
            const next = readings[i + 1];
            excursionSeconds += next ? next.ts - reading.ts : sampleSeconds;
        }
    });

    return {
        window: {
            root: tree.root,
            count: readings.length,
            from: readings[0].ts,
            to: readings[readings.length - 1].ts,
            minTemp,
            maxTemp,
            excursionSeconds,
        },
        leaves,
        tree,
    };
}

// Events in records[from, to): a flag that is set in a reading and was not in the previous one
// (the first reading of the cargo counts as having had no flags). Each rising edge is one event,
// so a lid that stays open does not produce an event per reading.
function findEvents(records, from, to) {
    const events = [];
    let previousFlags = from > 0 ? decodeReading(payloadOf(records[from - 1])).flags : 0;

    for (let i = from; i < to; i++) {
        const reading = decodeReading(payloadOf(records[i]));
        for (const kind of EVENT_KINDS) {
            if (reading.flags & kind.flag && !(previousFlags & kind.flag)) {
                events.push({
                    kind: kind.name,
                    kindIndex: kind.index,
                    ts: reading.ts,
                    payloadHash: leafHash(payloadOf(records[i])),
                });
            }
        }
        previousFlags = reading.flags;
    }
    return events;
}

module.exports = { buildWindow, findEvents, payloadOf, EVENT_KINDS };
