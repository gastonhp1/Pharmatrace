const fs = require("fs");
const path = require("path");

const abiPath = path.join(__dirname, "../artifacts/contracts/DrugTracker.sol/DrugTracker.json");
const outputPath = path.join(__dirname, "../../pharmatrace-ui/src/abi/DrugTracker.json"); // UI route path

function exportAbi() {
    if (!fs.existsSync(abiPath)) {
        console.error("❌ ABI not found. Have you compiled the contract?");
        process.exit(1);
    }

    const contractJson = JSON.parse(fs.readFileSync(abiPath, "utf8"));

    const abiOnly = {
        abi: contractJson.abi,
    };

    fs.writeFileSync(outputPath, JSON.stringify(abiOnly, null, 2));
    console.log("✅ ABI exported to React project:", outputPath);
}

exportAbi();
