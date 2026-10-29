// Who can open a PharmaBox. The box only checks the signature; this rule is the whole policy.
//
//   the regulator (RegMSP)                 always (audited like everything else)
//   box not monitoring a cargo             users of the org that registered the box
//   cargo OPEN                             users of the owner (packing it)
//   cargo IN_TRANSIT                       users of the recipient (PendingTo); not the sender,
//                                          not whoever carries it
//   cargo DELIVERED                        users of the owner, which after ReceiveCargo is the
//                                          org that received it (unloading)
//   cargo DISSOLVED                        users of the owner (undone before dispatch)
//
// Differs from the first draft in Pharmatrace-firmware/docs/unlock-protocol.md, which left
// DELIVERED and DISSOLVED to the regulator only: the receiver could not unload a box whose
// monitoring was still open. See iot/docs/BOX_UNLOCK.md.

const REGULATOR = "RegMSP";

// -> { allowed: true, reason } | { allowed: false, reason }
function canUnlock({ mspId, device, cargo }) {
    if (mspId === REGULATOR) return { allowed: true, reason: "regulator" };
    if (!device.activeCargo) {
        return device.org === mspId
            ? { allowed: true, reason: "box not in use, user of the org that registered it" }
            : { allowed: false, reason: `the box is not in use and belongs to ${device.org}` };
    }
    if (!cargo) return { allowed: false, reason: `cargo ${device.activeCargo} not found` };
    switch (cargo.state) {
        case "OPEN":
        case "DELIVERED":
        case "DISSOLVED":
            return cargo.owner === mspId
                ? { allowed: true, reason: `cargo ${cargo.state}, user of the owner` }
                : { allowed: false, reason: `cargo ${cargo.state}: only ${cargo.owner} can open it` };
        case "IN_TRANSIT":
            return cargo.pendingTo === mspId
                ? { allowed: true, reason: "cargo IN_TRANSIT, user of the recipient" }
                : { allowed: false, reason: `cargo IN_TRANSIT: only the recipient ${cargo.pendingTo} can open it` };
        default:
            return { allowed: false, reason: `unknown cargo state ${cargo.state}` };
    }
}

module.exports = { canUnlock, REGULATOR };
