const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const State = { Registered: 0, InDistribution: 1, InTransit: 2, InPharmacy: 3, Delivered: 4, InUse: 5 };

describe("CargoTracker", function () {
    async function deployFixture() {
        const [laboratory, distributor, warehouse, stranger] = await ethers.getSigners();

        const DrugTracker = await ethers.getContractFactory("DrugTracker");
        const drugs = await DrugTracker.deploy();

        const CargoTracker = await ethers.getContractFactory("CargoTracker");
        const cargo = await CargoTracker.deploy(await drugs.getAddress());

        // Two batches owned by the laboratory.
        await drugs.connect(laboratory).registerDrug("B-1", "Drug A", "Maker", 1700000000);
        await drugs.connect(laboratory).registerDrug("B-2", "Drug B", "Maker", 1700000001);

        return { drugs, cargo, laboratory, distributor, warehouse, stranger };
    }

    async function cargoFixture() {
        const ctx = await deployFixture();
        await ctx.cargo.connect(ctx.laboratory).createCargo("C-1", ["B-1", "B-2"]);
        return ctx;
    }

    describe("createCargo", function () {
        it("points to the DrugTracker it was deployed with", async function () {
            const { cargo, drugs } = await loadFixture(deployFixture);
            expect(await cargo.drugContract()).to.equal(await drugs.getAddress());
        });

        it("creates a cargo owned by its creator", async function () {
            const { cargo, laboratory } = await loadFixture(cargoFixture);
            const info = await cargo.getCargoInfo("C-1");
            expect(info.batchIds).to.deep.equal(["B-1", "B-2"]);
            expect(info.createdBy).to.equal(laboratory.address);
            expect(info.currentOwner).to.equal(laboratory.address);
            expect(info.createdAt).to.be.greaterThan(0n);
            expect(info.delivered).to.equal(false);
        });

        it("emits CargoCreated", async function () {
            const { cargo, laboratory } = await loadFixture(deployFixture);
            await expect(cargo.connect(laboratory).createCargo("C-1", ["B-1"]))
                .to.emit(cargo, "CargoCreated")
                .withArgs("C-1", laboratory.address, ["B-1"]);
        });

        it("rejects a cargo id that already exists", async function () {
            const { cargo, laboratory } = await loadFixture(cargoFixture);
            await expect(cargo.connect(laboratory).createCargo("C-1", ["B-1"])).to.be.revertedWith(
                "Cargo already exists"
            );
        });

        it("rejects a creator that does not own every batch", async function () {
            const { cargo, stranger } = await loadFixture(deployFixture);
            await expect(cargo.connect(stranger).createCargo("C-1", ["B-1"])).to.be.revertedWith(
                "Sender does not own all drugs"
            );
        });

        it("rejects unknown batches", async function () {
            const { cargo, laboratory } = await loadFixture(deployFixture);
            await expect(cargo.connect(laboratory).createCargo("C-1", ["NOPE"])).to.be.revertedWith(
                "Drug does not exist."
            );
        });

        it("fails getCargoInfo for unknown cargos", async function () {
            const { cargo } = await loadFixture(deployFixture);
            await expect(cargo.getCargoInfo("NOPE")).to.be.revertedWith("Cargo not found");
        });
    });

    describe("transferCargo", function () {
        it("moves the cargo to a new owner and emits CargoTransferred", async function () {
            const { cargo, laboratory, distributor } = await loadFixture(cargoFixture);
            await expect(cargo.connect(laboratory).transferCargo("C-1", distributor.address))
                .to.emit(cargo, "CargoTransferred")
                .withArgs("C-1", laboratory.address, distributor.address);
            expect((await cargo.getCargoInfo("C-1")).currentOwner).to.equal(distributor.address);
        });

        it("only lets the current owner transfer", async function () {
            const { cargo, distributor, stranger } = await loadFixture(cargoFixture);
            await expect(cargo.connect(stranger).transferCargo("C-1", distributor.address)).to.be.revertedWith(
                "Only owner can transfer"
            );
        });

        it("rejects unknown cargos", async function () {
            const { cargo, laboratory, distributor } = await loadFixture(deployFixture);
            await expect(cargo.connect(laboratory).transferCargo("NOPE", distributor.address)).to.be.revertedWith(
                "Cargo does not exist"
            );
        });
    });

    describe("markDelivered", function () {
        it("lets the current owner mark the cargo as delivered", async function () {
            const { cargo, laboratory, distributor } = await loadFixture(cargoFixture);
            await cargo.connect(laboratory).transferCargo("C-1", distributor.address);
            await cargo.connect(distributor).markDelivered("C-1");
            expect((await cargo.getCargoInfo("C-1")).delivered).to.equal(true);
        });

        it("rejects anyone who is not the current owner", async function () {
            const { cargo, laboratory, distributor } = await loadFixture(cargoFixture);
            await cargo.connect(laboratory).transferCargo("C-1", distributor.address);
            await expect(cargo.connect(laboratory).markDelivered("C-1")).to.be.revertedWith(
                "Only current owner can mark delivered"
            );
        });

        it("rejects unknown cargos", async function () {
            const { cargo, laboratory } = await loadFixture(deployFixture);
            await expect(cargo.connect(laboratory).markDelivered("NOPE")).to.be.revertedWith("Cargo not found");
        });
    });

    // These tests pin the CURRENT behaviour for the problems found in the review: the cargo and
    // the drugs inside it have independent ownership. They pass today because the contract allows
    // all of this; when the contracts are fixed, flip the assertions.
    describe("known issues (current behaviour)", function () {
        it("KNOWN ISSUE: transferring a cargo does not move the ownership of its drugs", async function () {
            const { cargo, drugs, laboratory, distributor } = await loadFixture(cargoFixture);
            await cargo.connect(laboratory).transferCargo("C-1", distributor.address);

            expect((await cargo.getCargoInfo("C-1")).currentOwner).to.equal(distributor.address);
            // ...but DrugTracker still says the laboratory owns every batch in it.
            expect((await drugs.getDrugInfo("B-1")).currentOwner).to.equal(laboratory.address);
            expect((await drugs.getDrugInfo("B-2")).currentOwner).to.equal(laboratory.address);
        });

        it("KNOWN ISSUE: the same batch can be part of several cargos at once", async function () {
            const { cargo, laboratory } = await loadFixture(cargoFixture);
            await cargo.connect(laboratory).createCargo("C-2", ["B-1"]);
            expect((await cargo.getCargoInfo("C-1")).batchIds).to.include("B-1");
            expect((await cargo.getCargoInfo("C-2")).batchIds).to.include("B-1");
        });

        it("KNOWN ISSUE: a batch can be transferred away while it is still listed in a cargo", async function () {
            const { cargo, drugs, laboratory, distributor } = await loadFixture(cargoFixture);
            await drugs.connect(laboratory).transferDrug("B-1", distributor.address, State.InDistribution);

            const info = await cargo.getCargoInfo("C-1");
            expect(info.currentOwner).to.equal(laboratory.address);
            expect(info.batchIds).to.include("B-1");
            expect((await drugs.getDrugInfo("B-1")).currentOwner).to.equal(distributor.address);
        });

        it("KNOWN ISSUE: the same batch id can be listed twice in one cargo", async function () {
            const { cargo, laboratory } = await loadFixture(deployFixture);
            await cargo.connect(laboratory).createCargo("C-DUP", ["B-1", "B-1"]);
            expect((await cargo.getCargoInfo("C-DUP")).batchIds).to.deep.equal(["B-1", "B-1"]);
        });

        it("KNOWN ISSUE: a cargo can be created with no batches", async function () {
            const { cargo, laboratory } = await loadFixture(deployFixture);
            await cargo.connect(laboratory).createCargo("C-EMPTY", []);
            expect((await cargo.getCargoInfo("C-EMPTY")).batchIds).to.deep.equal([]);
        });

        it("KNOWN ISSUE: a delivered cargo can still be transferred, even to the zero address", async function () {
            const { cargo, laboratory } = await loadFixture(cargoFixture);
            await cargo.connect(laboratory).markDelivered("C-1");
            await cargo.connect(laboratory).transferCargo("C-1", ethers.ZeroAddress);
            const info = await cargo.getCargoInfo("C-1");
            expect(info.delivered).to.equal(true);
            expect(info.currentOwner).to.equal(ethers.ZeroAddress);
        });

        it("KNOWN ISSUE: markDelivered emits no event and can be called repeatedly", async function () {
            const { cargo, laboratory } = await loadFixture(cargoFixture);
            const tx = await cargo.connect(laboratory).markDelivered("C-1");
            const receipt = await tx.wait();
            expect(receipt.logs).to.have.length(0);
            await cargo.connect(laboratory).markDelivered("C-1");
        });
    });
});
