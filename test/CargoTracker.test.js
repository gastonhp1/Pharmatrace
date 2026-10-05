const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const State = { Registered: 0, InDistribution: 1, InTransit: 2, InPharmacy: 3, Delivered: 4, InUse: 5 };
const Role = { None: 0, Manufacturer: 1, Distributor: 2, Warehouse: 3, Pharmacy: 4, Patient: 5 };

describe("CargoTracker", function () {
    async function deployFixture() {
        const [laboratory, distributor, warehouse, pharmacy, patient, stranger] =
            await ethers.getSigners();

        const drug = await (await ethers.getContractFactory("DrugTracker")).deploy();
        const cargo = await (await ethers.getContractFactory("CargoTracker")).deploy(
            await drug.getAddress()
        );

        await drug.registerActor(distributor.address, Role.Distributor);
        await drug.registerActor(warehouse.address, Role.Warehouse);
        await drug.registerActor(pharmacy.address, Role.Pharmacy);
        await drug.registerActor(patient.address, Role.Patient);
        await drug.setCargoTracker(await cargo.getAddress());

        for (const id of ["B-1", "B-2", "B-3"]) {
            await drug.registerDrug(id, `Drug ${id}`, "Test Labs", 1700000000);
        }

        return { drug, cargo, laboratory, distributor, warehouse, pharmacy, patient, stranger };
    }

    async function cargoFixture() {
        const ctx = await deployFixture();
        await ctx.cargo.createCargo("C-1", ["B-1", "B-2"]);
        return ctx;
    }

    describe("createCargo", function () {
        it("stores the cargo and locks its batches", async function () {
            const { drug, cargo, laboratory } = await loadFixture(deployFixture);
            await expect(cargo.createCargo("C-1", ["B-1", "B-2"]))
                .to.emit(cargo, "CargoCreated")
                .withArgs("C-1", laboratory.address, ["B-1", "B-2"]);

            const info = await cargo.getCargoInfo("C-1");
            expect(info.batchIds).to.deep.equal(["B-1", "B-2"]);
            expect(info.createdBy).to.equal(laboratory.address);
            expect(info.currentOwner).to.equal(laboratory.address);
            expect(info.delivered).to.equal(false);
            expect(await drug.inCargo("B-1")).to.equal(true);
            expect(await drug.inCargo("B-2")).to.equal(true);
            expect(await drug.inCargo("B-3")).to.equal(false);
        });

        it("rejects a duplicate cargo id", async function () {
            const { cargo } = await loadFixture(cargoFixture);
            await expect(cargo.createCargo("C-1", ["B-3"])).to.be.revertedWith("Cargo already exists");
        });

        it("rejects an empty cargo", async function () {
            const { cargo } = await loadFixture(deployFixture);
            await expect(cargo.createCargo("C-1", [])).to.be.revertedWith(
                "Cargo must have at least one drug"
            );
        });

        it("rejects unknown batches", async function () {
            const { cargo } = await loadFixture(deployFixture);
            await expect(cargo.createCargo("C-1", ["B-1", "NOPE"])).to.be.revertedWith(
                "Drug does not exist."
            );
        });

        it("rejects batches the sender does not own", async function () {
            const { cargo, distributor } = await loadFixture(deployFixture);
            await expect(cargo.connect(distributor).createCargo("C-1", ["B-1"])).to.be.revertedWith(
                "Sender does not own all drugs"
            );
        });

        it("rejects a batch that is already in another cargo", async function () {
            const { cargo } = await loadFixture(cargoFixture);
            await expect(cargo.createCargo("C-2", ["B-2", "B-3"])).to.be.revertedWith(
                "Drug is already in a cargo"
            );
        });

        it("rejects a batch listed twice", async function () {
            const { cargo } = await loadFixture(deployFixture);
            await expect(cargo.createCargo("C-1", ["B-1", "B-1"])).to.be.revertedWith(
                "Drug is already in a cargo"
            );
        });

        it("limits the number of batches", async function () {
            const { cargo } = await loadFixture(deployFixture);
            const max = Number(await cargo.MAX_BATCHES_PER_CARGO());
            const tooMany = Array.from({ length: max + 1 }, (_, i) => `X-${i}`);
            await expect(cargo.createCargo("C-1", tooMany)).to.be.revertedWith(
                "Too many drugs in a cargo"
            );
        });

        it("reverts when DrugTracker does not point to the cargo tracker", async function () {
            const { drug, cargo, stranger } = await loadFixture(deployFixture);
            await drug.setCargoTracker(stranger.address);
            await expect(cargo.createCargo("C-1", ["B-1"])).to.be.revertedWith(
                "Only the cargo tracker can perform this action."
            );
        });
    });

    describe("batches inside a cargo", function () {
        it("cannot be transferred on their own", async function () {
            const { drug, distributor } = await loadFixture(cargoFixture);
            await expect(
                drug.transferDrug("B-1", distributor.address, State.InDistribution)
            ).to.be.revertedWith("Drug is in a cargo");
        });
    });

    describe("transferCargo", function () {
        it("moves the cargo and all its batches together", async function () {
            const { drug, cargo, laboratory, distributor } = await loadFixture(cargoFixture);
            await expect(cargo.transferCargo("C-1", distributor.address, State.InDistribution))
                .to.emit(cargo, "CargoTransferred")
                .withArgs("C-1", laboratory.address, distributor.address);

            expect((await cargo.getCargoInfo("C-1")).currentOwner).to.equal(distributor.address);
            for (const id of ["B-1", "B-2"]) {
                const info = await drug.getDrugInfo(id);
                expect(info.currentOwner).to.equal(distributor.address);
                expect(info.currentState).to.equal(State.InDistribution);
                expect(await drug.getDrugHistory(id)).to.deep.equal([
                    laboratory.address,
                    distributor.address,
                ]);
            }
            // A batch outside the cargo is untouched.
            expect((await drug.getDrugInfo("B-3")).currentOwner).to.equal(laboratory.address);
        });

        it("only lets the current owner transfer", async function () {
            const { cargo, distributor, stranger } = await loadFixture(cargoFixture);
            await expect(
                cargo.connect(stranger).transferCargo("C-1", distributor.address, State.InDistribution)
            ).to.be.revertedWith("Only owner can transfer");
        });

        it("rejects unknown cargos", async function () {
            const { cargo, distributor } = await loadFixture(cargoFixture);
            await expect(
                cargo.transferCargo("NOPE", distributor.address, State.InDistribution)
            ).to.be.revertedWith("Cargo does not exist");
        });

        it("rejects the zero address", async function () {
            const { cargo } = await loadFixture(cargoFixture);
            await expect(
                cargo.transferCargo("C-1", ethers.ZeroAddress, State.InDistribution)
            ).to.be.revertedWith("Invalid recipient address.");
        });

        it("applies the role rules of DrugTracker, atomically", async function () {
            const { drug, cargo, warehouse, stranger, distributor } = await loadFixture(cargoFixture);
            // Skipping a role.
            await expect(
                cargo.transferCargo("C-1", warehouse.address, State.InTransit)
            ).to.be.revertedWith("Invalid recipient role");
            // No role.
            await expect(
                cargo.transferCargo("C-1", stranger.address, State.InDistribution)
            ).to.be.revertedWith("Invalid recipient role");
            // State that does not match the role.
            await expect(
                cargo.transferCargo("C-1", distributor.address, State.InTransit)
            ).to.be.revertedWith("State does not match recipient role");

            // Nothing moved.
            expect((await cargo.getCargoInfo("C-1")).currentOwner).to.not.equal(distributor.address);
            expect((await drug.getDrugInfo("B-1")).currentState).to.equal(State.Registered);
        });

        it("lets the cargo travel down the whole chain", async function () {
            const { drug, cargo, distributor, warehouse, pharmacy } = await loadFixture(cargoFixture);
            await cargo.transferCargo("C-1", distributor.address, State.InDistribution);
            await cargo.connect(distributor).transferCargo("C-1", warehouse.address, State.InTransit);
            await cargo.connect(warehouse).transferCargo("C-1", pharmacy.address, State.InPharmacy);

            for (const id of ["B-1", "B-2"]) {
                const info = await drug.getDrugInfo(id);
                expect(info.currentOwner).to.equal(pharmacy.address);
                expect(info.currentState).to.equal(State.InPharmacy);
            }
        });

        it("does not let the previous owner transfer again", async function () {
            const { cargo, distributor, warehouse } = await loadFixture(cargoFixture);
            await cargo.transferCargo("C-1", distributor.address, State.InDistribution);
            await expect(
                cargo.transferCargo("C-1", warehouse.address, State.InTransit)
            ).to.be.revertedWith("Only owner can transfer");
        });
    });

    describe("markDelivered", function () {
        it("closes the cargo, unlocks its batches and emits CargoDelivered", async function () {
            const { drug, cargo, distributor, pharmacy, warehouse } = await loadFixture(cargoFixture);
            await cargo.transferCargo("C-1", distributor.address, State.InDistribution);
            await cargo.connect(distributor).transferCargo("C-1", warehouse.address, State.InTransit);
            await cargo.connect(warehouse).transferCargo("C-1", pharmacy.address, State.InPharmacy);

            await expect(cargo.connect(pharmacy).markDelivered("C-1"))
                .to.emit(cargo, "CargoDelivered")
                .withArgs("C-1", pharmacy.address);

            expect((await cargo.getCargoInfo("C-1")).delivered).to.equal(true);
            expect(await drug.inCargo("B-1")).to.equal(false);
            expect(await drug.inCargo("B-2")).to.equal(false);
        });

        it("leaves the batches with the owner, free to continue one by one", async function () {
            const { drug, cargo, distributor, warehouse, pharmacy, patient } =
                await loadFixture(cargoFixture);
            await cargo.transferCargo("C-1", distributor.address, State.InDistribution);
            await cargo.connect(distributor).transferCargo("C-1", warehouse.address, State.InTransit);
            await cargo.connect(warehouse).transferCargo("C-1", pharmacy.address, State.InPharmacy);
            await cargo.connect(pharmacy).markDelivered("C-1");

            await drug.connect(pharmacy).transferDrug("B-1", patient.address, State.Delivered);
            expect((await drug.getDrugInfo("B-1")).currentOwner).to.equal(patient.address);
            expect((await drug.getDrugInfo("B-2")).currentOwner).to.equal(pharmacy.address);
        });

        it("can only be done once", async function () {
            const { cargo } = await loadFixture(cargoFixture);
            await cargo.markDelivered("C-1");
            await expect(cargo.markDelivered("C-1")).to.be.revertedWith("Cargo already delivered");
        });

        it("only lets the current owner do it", async function () {
            const { cargo, stranger } = await loadFixture(cargoFixture);
            await expect(cargo.connect(stranger).markDelivered("C-1")).to.be.revertedWith(
                "Only current owner can mark delivered"
            );
        });

        it("rejects unknown cargos", async function () {
            const { cargo } = await loadFixture(cargoFixture);
            await expect(cargo.markDelivered("NOPE")).to.be.revertedWith("Cargo not found");
        });

        it("makes a delivered cargo impossible to transfer", async function () {
            const { cargo, distributor } = await loadFixture(cargoFixture);
            await cargo.markDelivered("C-1");
            await expect(
                cargo.transferCargo("C-1", distributor.address, State.InDistribution)
            ).to.be.revertedWith("Cargo already delivered");
            await expect(
                cargo.transferCargo("C-1", ethers.ZeroAddress, State.InDistribution)
            ).to.be.revertedWith("Cargo already delivered");
        });

        it("frees the batches to join a new cargo", async function () {
            const { cargo } = await loadFixture(cargoFixture);
            await cargo.markDelivered("C-1");
            await cargo.createCargo("C-2", ["B-1", "B-3"]);
            expect((await cargo.getCargoInfo("C-2")).batchIds).to.deep.equal(["B-1", "B-3"]);
        });
    });

    describe("getCargoInfo", function () {
        it("reverts for unknown cargos", async function () {
            const { cargo } = await loadFixture(deployFixture);
            await expect(cargo.getCargoInfo("NOPE")).to.be.revertedWith("Cargo not found");
        });
    });

    describe("full chain", function () {
        it("goes from the laboratory to a patient who uses the drug", async function () {
            const { drug, cargo, distributor, warehouse, pharmacy, patient } =
                await loadFixture(cargoFixture);
            await cargo.transferCargo("C-1", distributor.address, State.InDistribution);
            await cargo.connect(distributor).transferCargo("C-1", warehouse.address, State.InTransit);
            await cargo.connect(warehouse).transferCargo("C-1", pharmacy.address, State.InPharmacy);
            await cargo.connect(pharmacy).markDelivered("C-1");
            await drug.connect(pharmacy).transferDrug("B-1", patient.address, State.Delivered);
            await drug.connect(patient).markInUse("B-1");

            const info = await drug.getDrugInfo("B-1");
            expect(info.currentState).to.equal(State.InUse);
            expect(info.currentOwner).to.equal(patient.address);
            expect((await drug.getDrugHistory("B-1")).length).to.equal(5);
        });
    });
});
