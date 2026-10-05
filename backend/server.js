require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { traceDrug, registerDrug, transferDrug, markInUse } = require("./services/traceDrugService");
const cargoRoutes = require("./routes/cargo");
const { requireApiKey } = require("./middleware/auth");
const { sendError } = require("./utils/errors");
const { requireString, requireAddress, requireState } = require("./utils/validate");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
// Reads are public; anything that signs a transaction needs the x-api-key header.
app.use("/api", requireApiKey());
app.use("/api/cargo", cargoRoutes);

app.get("/", (req, res) => {
    res.send("PharmaTrace Backend is running 🚀");
});

// 🔍 Obtener información de un batch
app.get("/api/drug/:batchId", async (req, res) => {
    try {
        const batchId = req.params.batchId;
        const result = await traceDrug(batchId);
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error tracing drug batch");
    }
});

// 📝 Registrar un nuevo batch de droga
app.post("/api/register", async (req, res) => {
    try {
        const { batchId, drugName, manufacturer } = req.body || {};
        const result = await registerDrug(
            requireString(batchId, "batchId"),
            requireString(drugName, "drugName"),
            requireString(manufacturer, "manufacturer")
        );
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error registering drug");
    }
});

// 📦 Transferir droga a otro actor
app.post("/api/transfer", async (req, res) => {
    try {
        const { batchId, toAddress, newState } = req.body || {};
        const result = await transferDrug(
            requireString(batchId, "batchId"),
            requireAddress(toAddress, "toAddress"),
            requireState(newState)
        );
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error transferring drug");
    }
});

// 💊 Marcar un batch entregado como en uso (lo hace el paciente)
app.post("/api/mark-in-use", async (req, res) => {
    try {
        const { batchId } = req.body || {};
        const result = await markInUse(requireString(batchId, "batchId"));
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error marking drug as in use");
    }
});

if (!process.env.API_KEY && process.env.AUTH_DISABLED !== "true") {
    console.warn("⚠️  API_KEY is not set: write endpoints will answer 503 (set AUTH_DISABLED=true for local development).");
}

app.listen(PORT, () => {
    console.log(`✅ Backend running on http://localhost:${PORT}`);
});
