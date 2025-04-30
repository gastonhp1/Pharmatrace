require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { traceDrug, registerDrug, transferDrug } = require("./services/traceDrugService");
const cargoRoutes = require("./routes/cargo");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
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
        console.error(err);
        res.status(500).json({ error: "Error tracing drug batch" });
    }
});

// 📝 Registrar un nuevo batch de droga
app.post("/api/register", async (req, res) => {
    try {
        const { batchId, drugName, manufacturer } = req.body;
        const result = await registerDrug(batchId, drugName, manufacturer);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error registering drug" });
    }
});

// 📦 Transferir droga a otro actor
app.post("/api/transfer", async (req, res) => {
    try {
        const { batchId, toAddress, newState } = req.body;
        const result = await transferDrug(batchId, toAddress, newState);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error transferring drug" });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Backend running on http://localhost:${PORT}`);
});
