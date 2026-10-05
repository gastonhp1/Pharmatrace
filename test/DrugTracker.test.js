const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const State = {
    Registered: 0,
    InDistribution: 1,
    InTransit: 2,
    InPharmacy: 3,
    Delivered: 4,
    InUse: 5,
};

describe("DrugTracker", function () {
    async function deployFixture() {
        const [laboratory, distributor, warehouse, pharmacy, patient, stranger] =
            await ethers.getSigners();
        const DrugTracker = await ethers.getContractFactory("DrugTracker");
        const tracker = await DrugTracker.deploy();
        return { tracker, laboratory, distributor, warehouse, pharmacy, patient, stranger };
    }

    async function registeredFixture() {
        const ctx = await deployFixture();
        const batch = "BATCH-001";
        await ctx.tracker
            .connect(ctx.laboratory)
            .registerDrug(batch, "Ibuprofen 400mg", "Test Labs", 1700000000);
        return { ...ctx, batch };
    }

    describe("registerDrug", function () {
        it("sets the deployer as contract owner", async function () {
            const { tracker, laboratory } = await loadFixture(deployFixture);
            expect(await tracker.owner()).to.equal(laboratory.address);
        });

        it("registers a batch owned by the registrant in state Registered", async function () {
            const { tracker, laboratory, batch } = await loadFixture(registeredFixture);
            const info = await tracker.getDrugInfo(batch);
            expect(info.name).to.equal("Ibuprofen 400mg");
            expect(info.manufacturer).to.equal("Test Labs");
            expect(info.productionDate).to.equal(1700000000n);
            expect(info.currentState).to.equal(State.Registered);
            expect(info.currentOwner).to.equal(laboratory.address);
            expect(await tracker.getDrugHistory(batch)).to.deep.equal([laboratory.address]);
        });

        it("emits DrugRegistered", async function () {
            const { tracker, laboratory } = await loadFixture(deployFixture);
            await expect(tracker.connect(laboratory).registerDrug("B-1", "Name", "Maker", 123))
                .to.emit(tracker, "DrugRegistered")
                .withArgs(anyValue, "Name", "Maker", 123);
        });

        it("only lets the contract owner register", async function () {
            const { tracker, stranger } = await loadFixture(deployFixture);
            await expect(
                tracker.connect(stranger).registerDrug("B-1", "Name", "Maker", 123)
            ).to.be.revertedWith("Only the contract owner can perform this action.");
        });

        it("rejects a duplicate batch number", async function () {
            const { tracker, laboratory, batch } = await loadFixture(registeredFixture);
            await expect(
                tracker.connect(laboratory).registerDrug(batch, "Other", "Other", 1)
            ).to.be.revertedWith("Drug already registered.");
        });
    });

    describe("transferDrug", function () {
        it("moves ownership along the supply chain and records the history", async function () {
            const { tracker, laboratory, distributor, warehouse, pharmacy, patient, batch } =
                await loadFixture(registeredFixture);

            await tracker.connect(laboratory).transferDrug(batch, distributor.address, State.InDistribution);
            await tracker.connect(distributor).transferDrug(batch, warehouse.address, State.InTransit);
            await tracker.connect(warehouse).transferDrug(batch, pharmacy.address, State.InPharmacy);
            await tracker.connect(pharmacy).transferDrug(batch, patient.address, State.Delivered);

            const info = await tracker.getDrugInfo(batch);
            expect(info.currentOwner).to.equal(patient.address);
            expect(info.currentState).to.equal(State.Delivered);
            expect(await tracker.getDrugHistory(batch)).to.deep.equal([
                laboratory.address,
                distributor.address,
                warehouse.address,
                pharmacy.address,
                patient.address,
            ]);
        });

        it("emits DrugTransferred", async function () {
            const { tracker, laboratory, distributor, batch } = await loadFixture(registeredFixture);
            await expect(
                tracker.connect(laboratory).transferDrug(batch, distributor.address, State.InDistribution)
            )
                .to.emit(tracker, "DrugTransferred")
                .withArgs(anyValue, laboratory.address, distributor.address, State.InDistribution);
        });

        it("only lets the current owner transfer", async function () {
            const { tracker, distributor, stranger, batch } = await loadFixture(registeredFixture);
            await expect(
                tracker.connect(stranger).transferDrug(batch, distributor.address, State.InDistribution)
            ).to.be.revertedWith("You are not the current owner.");
        });

        it("does not let the previous owner transfer again", async function () {
            const { tracker, laboratory, distributor, warehouse, batch } =
                await loadFixture(registeredFixture);
            await tracker.connect(laboratory).transferDrug(batch, distributor.address, State.InDistribution);
            await expect(
                tracker.connect(laboratory).transferDrug(batch, warehouse.address, State.InTransit)
            ).to.be.revertedWith("You are not the current owner.");
        });

        it("rejects unknown batches", async function () {
            const { tracker, laboratory, distributor } = await loadFixture(deployFixture);
            await expect(
                tracker.connect(laboratory).transferDrug("NOPE", distributor.address, State.InDistribution)
            ).to.be.revertedWith("Drug does not exist.");
        });

        it("rejects the zero address as recipient", async function () {
            const { tracker, laboratory, batch } = await loadFixture(registeredFixture);
            await expect(
                tracker.connect(laboratory).transferDrug(batch, ethers.ZeroAddress, State.InDistribution)
            ).to.be.revertedWith("Invalid recipient address.");
        });

        it("rejects going backwards or staying in the same state", async function () {
            const { tracker, laboratory, distributor, warehouse, batch } =
                await loadFixture(registeredFixture);
            await tracker.connect(laboratory).transferDrug(batch, distributor.address, State.InTransit);
            await expect(
                tracker.connect(distributor).transferDrug(batch, warehouse.address, State.InDistribution)
            ).to.be.revertedWith("Invalid state transition.");
            await expect(
                tracker.connect(distributor).transferDrug(batch, warehouse.address, State.InTransit)
            ).to.be.revertedWith("Invalid state transition.");
        });

        it("reverts for states outside the enum", async function () {
            const { tracker, laboratory, distributor, batch } = await loadFixture(registeredFixture);
            await expect(tracker.connect(laboratory).transferDrug(batch, distributor.address, 6)).to.be
                .reverted;
        });

        it("cannot be transferred after reaching the last state (InUse)", async function () {
            const { tracker, laboratory, distributor, warehouse, batch } =
                await loadFixture(registeredFixture);
            await tracker.connect(laboratory).transferDrug(batch, distributor.address, State.InUse);
            await expect(
                tracker.connect(distributor).transferDrug(batch, warehouse.address, State.InUse)
            ).to.be.revertedWith("Invalid state transition.");
        });
    });

    describe("views", function () {
        it("reverts for unknown batches", async function () {
            const { tracker } = await loadFixture(deployFixture);
            await expect(tracker.getDrugInfo("NOPE")).to.be.revertedWith("Drug does not exist.");
            await expect(tracker.getDrugHistory("NOPE")).to.be.revertedWith("Drug does not exist.");
        });
    });

    // These tests pin the CURRENT behaviour of the contract for the problems found in the
    // review (state transitions are not validated against the actor). They pass today because
    // the contract allows these things; when the contract is tightened, flip the assertions.
    describe("known issues (current behaviour)", function () {
        it("KNOWN ISSUE: a batch can skip states (Registered -> InUse in one hop)", async function () {
            const { tracker, laboratory, patient, batch } = await loadFixture(registeredFixture);
            await tracker.connect(laboratory).transferDrug(batch, patient.address, State.InUse);
            const info = await tracker.getDrugInfo(batch);
            expect(info.currentState).to.equal(State.InUse);
            expect(info.currentOwner).to.equal(patient.address);
        });

        it("KNOWN ISSUE: the recipient can be any address, regardless of the state being set", async function () {
            const { tracker, laboratory, stranger, batch } = await loadFixture(registeredFixture);
            // A random address with no role receives the batch as "InPharmacy".
            await tracker.connect(laboratory).transferDrug(batch, stranger.address, State.InPharmacy);
            const info = await tracker.getDrugInfo(batch);
            expect(info.currentState).to.equal(State.InPharmacy);
            expect(info.currentOwner).to.equal(stranger.address);
        });
    });
});
