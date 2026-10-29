class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

// Errors the client can act on are ApiErrors: validation here, or the coded errors of the
// chaincode, which services/fabric.js turns into ApiErrors. Anything else is unexpected
// (network down, bad configuration, bugs): it is logged and answered with a generic 500.
function sendError(res, err, fallbackMessage) {
    if (err instanceof ApiError) {
        if (err.status >= 500) console.error(`❌ ${fallbackMessage}: ${err.message}`);
        return res.status(err.status).json({ error: err.message });
    }
    console.error(`❌ ${fallbackMessage}:`, err);
    return res.status(500).json({ error: fallbackMessage });
}

module.exports = { ApiError, sendError };
