// Loads the root .env and, for anything still missing, falls back to backend/.env.
// This way the scripts work right after `npm run deploy:all`, which writes the contract
// addresses and keys to backend/.env. Values already set are never overridden.
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();
dotenv.config({ path: path.join(__dirname, "../../backend/.env") });
