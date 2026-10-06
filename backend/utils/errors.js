class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

// Revert reasons defined in the contracts -> HTTP status.
const REVERT_STATUS = {
    // DrugTracker
    "Drug does not exist.": 404,
    "You are not the current owner.": 403,
    "Only the contract owner can perform this action.": 403,
    "Drug already registered.": 409,
    "Invalid state transition.": 409,
    "Invalid recipient address.": 400,
    "Invalid recipient role": 409,
    "State does not match recipient role": 400,
    "Drug is in a cargo": 409,
    "Drug is already in a cargo": 409,
    "Drug is not in a cargo": 409,
    "Drug must be delivered first": 409,
    "Only patients can mark a drug as in use": 403,
    "Only the cargo tracker can perform this action.": 403,
    // CargoTracker
    "Cargo not found": 404,
    "Cargo does not exist": 404,
    "Only owner can transfer": 403,
    "Only current owner can mark delivered": 403,
    "Sender does not own all drugs": 403,
    "Cargo already exists": 409,
    "Cargo already delivered": 409,
    "Cargo must have at least one drug": 400,
    "Too many drugs in a cargo": 400,
    // DeviceRegistry
    "Device does not exist": 404,
    "Device already registered": 409,
    "Invalid device id": 400,
    "Public key must be 64 bytes": 400,
    "Calibration already expired": 400,
    "Invalid attestor address.": 400,
    // ColdChainMonitor
    "Monitoring not found": 404,
    "Monitoring already started": 409,
    "Monitoring already closed": 409,
    "Policy does not exist": 404,
    "Policy already exists": 409,
    "Invalid policy id": 400,
    "Invalid temperature range": 400,
    "Device is not operational": 409,
    "Device is already in use": 409,
    "Not authorized to monitor this cargo.": 403,
    "Only an attestor can perform this action.": 403,
    "Invalid root": 400,
    "Empty window": 400,
    "Invalid window": 400,
    "Window overlaps previous one": 409,
    "Window is in the future": 409,
    "Inconsistent excursion data": 409,
    "Event is in the future": 409,
    "Anchor not found": 404,
};

function revertReason(err) {
    if (!err) return null;
    if (typeof err.reason === "string") return err.reason;
    const arg = err.revert && err.revert.args && err.revert.args[0];
    return typeof arg === "string" ? arg : null;
}

// Returns an ApiError for errors the client can act on (validation, contract reverts),
// or null for unexpected ones (RPC down, bad configuration, bugs).
function toApiError(err) {
    if (err instanceof ApiError) return err;

    const reason = revertReason(err);
    if (reason && REVERT_STATUS[reason]) return new ApiError(REVERT_STATUS[reason], reason);
    if (err && err.code === "CALL_EXCEPTION") return new ApiError(400, reason || "Transaction reverted");

    return null;
}

function sendError(res, err, fallbackMessage) {
    const apiError = toApiError(err);
    if (apiError) {
        return res.status(apiError.status).json({ error: apiError.message });
    }
    console.error(`❌ ${fallbackMessage}:`, err);
    return res.status(500).json({ error: fallbackMessage });
}

module.exports = { ApiError, sendError, toApiError };
