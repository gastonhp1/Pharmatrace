const { ethers } = require("ethers");

// Role enum of DrugTracker (see contracts/DrugTracker.sol).
const Role = { Manufacturer: 1, Distributor: 2, Warehouse: 3, Pharmacy: 4, Patient: 5 };

// Actor name -> [env var with its key, role, index of the default Hardhat account].
const ACTORS = {
    manufacturer: ["MANUFACTURER_KEY", Role.Manufacturer, 0],
    distributor: ["DISTRIBUTOR_KEY", Role.Distributor, 1],
    warehouse: ["WAREHOUSE_KEY", Role.Warehouse, 2],
    pharmacy: ["PHARMACY_KEY", Role.Pharmacy, 3],
    patient: ["PATIENT_KEY", Role.Patient, 4],
};

// Address of every actor: derived from its *_KEY in the environment when set (so the roles
// match the keys the backend and the scripts sign with), otherwise the default Hardhat account.
function actorAddresses(signers) {
    const addresses = {};
    for (const [name, [envName, , index]] of Object.entries(ACTORS)) {
        const key = process.env[envName];
        addresses[name] = key ? new ethers.Wallet(key).address : signers[index].address;
    }
    return addresses;
}

// Deploys DrugTracker and CargoTracker, registers the actors' roles and links the cargo tracker.
// The deployer (signers[0]) becomes the owner and the manufacturer.
async function deployAll(hre) {
    const signers = await hre.ethers.getSigners();
    const addresses = actorAddresses(signers);

    if (addresses.manufacturer !== signers[0].address) {
        throw new Error(
            `MANUFACTURER_KEY (${addresses.manufacturer}) is not the deployer account ` +
                `(${signers[0].address}): the deployer is the manufacturer and the contract owner.`
        );
    }

    const drug = await (await hre.ethers.getContractFactory("DrugTracker")).deploy();
    await drug.waitForDeployment();
    const drugAddress = await drug.getAddress();

    const cargo = await (await hre.ethers.getContractFactory("CargoTracker")).deploy(drugAddress);
    await cargo.waitForDeployment();
    const cargoAddress = await cargo.getAddress();

    for (const [name, [, role]] of Object.entries(ACTORS)) {
        if (role === Role.Manufacturer) continue; // already registered by the constructor
        await (await drug.registerActor(addresses[name], role)).wait();
    }
    await (await drug.setCargoTracker(cargoAddress)).wait();

    return { drug, cargo, drugAddress, cargoAddress, addresses, signers };
}

module.exports = { Role, ACTORS, actorAddresses, deployAll };
