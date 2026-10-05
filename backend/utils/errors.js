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
    // CargoTracker
    "Cargo not found": 404,
    "Cargo does not exist": 404,
    "Only owner can transfer": 403,
    "Only current owner can mark delivered": 403,
    "Sender does not own all drugs": 403,
    "Cargo already exists": 409,
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
