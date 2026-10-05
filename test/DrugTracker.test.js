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

const Role = {
    None: 0,
    Manufacturer: 1,
    Distributor: 2,
    Warehouse: 3,
    Pharmacy: 4,
    Patient: 5,
};

describe("DrugTracker", function () {
    async function deployFixture() {
        const [laboratory, distributor, warehouse, pharmacy, patient, stranger] =
            await ethers.getSigners();
        const DrugTracker = await ethers.getContractFactory("DrugTracker");
        const tracker = await DrugTracker.deploy();

        // The deployer (laboratory) is the contract owner and registers the other actors.
        await tracker.registerActor(distributor.address, Role.Distributor);
        await tracker.registerActor(warehouse.address, Role.Warehouse);
        await tracker.registerActor(pharmacy.address, Role.Pharmacy);
        await tracker.registerActor(patient.address, Role.Patient);

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

    // A batch already handed down the chain up to the patient (state Delivered).
    async function deliveredFixture() {
        const ctx = await registeredFixture();
        const { tracker, laboratory, distributor, warehouse, pharmacy, patient, batch } = ctx;
        await tracker.connect(laboratory).transferDrug(batch, distributor.address, State.InDistribution);
        await tracker.connect(distributor).transferDrug(batch, warehouse.address, State.InTransit);
        await tracker.connect(warehouse).transferDrug(batch, pharmacy.address, State.InPharmacy);
        await tracker.connect(pharmacy).transferDrug(batch, patient.address, State.Delivered);
        return ctx;
    }

    describe("actors", function () {
        it("makes the deployer the contract owner and the manufacturer", async function () {
            const { tracker, laboratory } = await loadFixture(deployFixture);
            expect(await tracker.owner()).to.equal(laboratory.address);
            expect(await tracker.roleOf(laboratory.address)).to.equal(Role.Manufacturer);
        });

        it("assigns roles and emits ActorRegistered", async function () {
            const { tracker, stranger } = await loadFixture(deployFixture);
            expect(await tracker.roleOf(stranger.address)).to.equal(Role.None);
            await expect(tracker.registerActor(stranger.address, Role.Pharmacy))
                .to.emit(tracker, "ActorRegistered")
                .withArgs(stranger.address, Role.Pharmacy);
            expect(await tracker.roleOf(stranger.address)).to.equal(Role.Pharmacy);
        });

        it("only lets the contract owner register actors", async function () {
            const { tracker, distributor, stranger } = await loadFixture(deployFixture);
            await expect(
                tracker.connect(stranger).registerActor(distributor.address, Role.Warehouse)
            ).to.be.revertedWith("Only the contract owner can perform this action.");
        });

        it("rejects the zero address, the None role and a new role for the owner", async function () {
            const { tracker, laboratory, stranger } = await loadFixture(deployFixture);
            await expect(tracker.registerActor(ethers.ZeroAddress, Role.Distributor)).to.be.revertedWith(
                "Invalid actor address."
            );
            await expect(tracker.registerActor(stranger.address, Role.None)).to.be.revertedWith("Invalid role.");
            await expect(tracker.registerActor(laboratory.address, Role.Distributor)).to.be.revertedWith(
                "The owner is always the manufacturer."
            );
        });
    });

    describe("registerDrug", function () {
        it("registers a batch owned by the registrant in state Registered", async function () {
            const { tracker, laboratory, batch } = await loadFixture(registeredFixture);
            const info = await tracker.getDrugInfo(batch);
            expect(info.name).to.equal("Ibuprofen 400mg");
            expect(info.manufacturer).to.equal("Test Labs");
            expect(info.productionDate).to.equal(1700000000n);
            expect(info.currentState).to.equal(State.Registered);
            expect(info.currentOwner).to.equal(laboratory.address);
            expect(await tracker.getDrugHistory(batch)).to.deep.equal([laboratory.address]);
            expect(await tracker.inCargo(batch)).to.equal(false);
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
                await loadFixture(deliveredFixture);

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

        it("rejects a recipient with no role", async function () {
            const { tracker, laboratory, stranger, batch } = await loadFixture(registeredFixture);
            await expect(
                tracker.connect(laboratory).transferDrug(batch, stranger.address, State.InDistribution)
            ).to.be.revertedWith("Invalid recipient role");
        });

        it("only moves a batch to the next role in the chain (no skipping)", async function () {
            const { tracker, laboratory, warehouse, patient, batch } = await loadFixture(registeredFixture);
            // Manufacturer -> Warehouse and Manufacturer -> Patient skip roles.
            await expect(
                tracker.connect(laboratory).transferDrug(batch, warehouse.address, State.InTransit)
            ).to.be.revertedWith("Invalid recipient role");
            await expect(
                tracker.connect(laboratory).transferDrug(batch, patient.address, State.Delivered)
            ).to.be.revertedWith("Invalid recipient role");
        });

        it("does not let a batch jump straight to InUse", async function () {
            const { tracker, laboratory, patient, batch } = await loadFixture(registeredFixture);
            await expect(
                tracker.connect(laboratory).transferDrug(batch, patient.address, State.InUse)
            ).to.be.revertedWith("Invalid recipient role");
        });

        it("requires the new state to match the recipient's role", async function () {
            const { tracker, laboratory, distributor, batch } = await loadFixture(registeredFixture);
            for (const wrongState of [State.Registered, State.InTransit, State.Delivered, State.InUse]) {
                await expect(
                    tracker.connect(laboratory).transferDrug(batch, distributor.address, wrongState)
                ).to.be.revertedWith("State does not match recipient role");
            }
        });

        it("rejects going backwards", async function () {
            const { tracker, laboratory, distributor, warehouse, batch } =
                await loadFixture(registeredFixture);
            await tracker.connect(laboratory).transferDrug(batch, distributor.address, State.InDistribution);
            await tracker.connect(distributor).transferDrug(batch, warehouse.address, State.InTransit);
            await expect(
                tracker.connect(warehouse).transferDrug(batch, distributor.address, State.InDistribution)
            ).to.be.revertedWith("Invalid recipient role");
        });

        it("reverts for states outside the enum", async function () {
            const { tracker, laboratory, distributor, batch } = await loadFixture(registeredFixture);
            await expect(tracker.connect(laboratory).transferDrug(batch, distributor.address, 6)).to.be
                .reverted;
        });

        it("has no recipient after the last role (patient)", async function () {
            const { tracker, patient, stranger, batch } = await loadFixture(deliveredFixture);
            await expect(
                tracker.connect(patient).transferDrug(batch, stranger.address, State.InUse)
            ).to.be.revertedWith("Invalid recipient role");
        });
    });

    describe("markInUse", function () {
        it("lets the patient mark a delivered batch as in use", async function () {
            const { tracker, patient, batch } = await loadFixture(deliveredFixture);
            await expect(tracker.connect(patient).markInUse(batch))
                .to.emit(tracker, "DrugUsed")
                .withArgs(anyValue, patient.address);
            const info = await tracker.getDrugInfo(batch);
            expect(info.currentState).to.equal(State.InUse);
            expect(info.currentOwner).to.equal(patient.address);
        });

        it("only lets the patient role do it", async function () {
            const { tracker, laboratory, distributor, warehouse, pharmacy, batch } =
                await loadFixture(registeredFixture);
            await expect(tracker.connect(laboratory).markInUse(batch)).to.be.revertedWith(
                "Only patients can mark a drug as in use"
            );
            await tracker.connect(laboratory).transferDrug(batch, distributor.address, State.InDistribution);
            await tracker.connect(distributor).transferDrug(batch, warehouse.address, State.InTransit);
            await tracker.connect(warehouse).transferDrug(batch, pharmacy.address, State.InPharmacy);
            await expect(tracker.connect(pharmacy).markInUse(batch)).to.be.revertedWith(
                "Only patients can mark a drug as in use"
            );
        });

        it("only lets the current owner do it", async function () {
            const { tracker, stranger, batch } = await loadFixture(deliveredFixture);
            await expect(tracker.connect(stranger).markInUse(batch)).to.be.revertedWith(
                "You are not the current owner."
            );
        });

        it("can only be done once, from Delivered", async function () {
            const { tracker, patient, batch } = await loadFixture(deliveredFixture);
            await tracker.connect(patient).markInUse(batch);
            await expect(tracker.connect(patient).markInUse(batch)).to.be.revertedWith(
                "Drug must be delivered first"
            );
        });

        it("rejects unknown batches", async function () {
            const { tracker, patient } = await loadFixture(deployFixture);
            await expect(tracker.connect(patient).markInUse("NOPE")).to.be.revertedWith("Drug does not exist.");
        });
    });

    describe("views", function () {
        it("reverts for unknown batches", async function () {
            const { tracker } = await loadFixture(deployFixture);
            await expect(tracker.getDrugInfo("NOPE")).to.be.revertedWith("Drug does not exist.");
            await expect(tracker.getDrugHistory("NOPE")).to.be.revertedWith("Drug does not exist.");
        });
    });

    // The cargo integration is covered end to end in CargoTracker.test.js. Here an ordinary
    // account plays the cargo tracker, to test DrugTracker's side of the contract alone.
    describe("cargo integration", function () {
        async function linkedFixture() {
            const ctx = await registeredFixture();
            const fakeCargo = ctx.stranger;
            await ctx.tracker.setCargoTracker(fakeCargo.address);
            return { ...ctx, fakeCargo };
        }

        it("only lets the owner set the cargo tracker, and not to the zero address", async function () {
            const { tracker, stranger } = await loadFixture(deployFixture);
            await expect(tracker.connect(stranger).setCargoTracker(stranger.address)).to.be.revertedWith(
                "Only the contract owner can perform this action."
            );
            await expect(tracker.setCargoTracker(ethers.ZeroAddress)).to.be.revertedWith(
                "Invalid cargo tracker address."
            );
            await expect(tracker.setCargoTracker(stranger.address))
                .to.emit(tracker, "CargoTrackerSet")
                .withArgs(stranger.address);
            expect(await tracker.cargoTracker()).to.equal(stranger.address);
        });

        it("only lets the cargo tracker lock, unlock and move batches", async function () {
            const { tracker, laboratory, distributor, batch } = await loadFixture(linkedFixture);
            const message = "Only the cargo tracker can perform this action.";
            await expect(tracker.connect(laboratory).lockForCargo(batch, laboratory.address)).to.be.revertedWith(message);
            await expect(tracker.connect(laboratory).unlockFromCargo(batch)).to.be.revertedWith(message);
            await expect(
                tracker.connect(laboratory).transferFromCargo(batch, laboratory.address, distributor.address, State.InDistribution)
            ).to.be.revertedWith(message);
        });

        it("locks a batch for its owner only, and only once", async function () {
            const { tracker, laboratory, distributor, fakeCargo, batch } = await loadFixture(linkedFixture);
            await expect(tracker.connect(fakeCargo).lockForCargo(batch, distributor.address)).to.be.revertedWith(
                "Sender does not own all drugs"
            );
            await expect(tracker.connect(fakeCargo).lockForCargo("NOPE", laboratory.address)).to.be.revertedWith(
                "Drug does not exist."
            );

            await tracker.connect(fakeCargo).lockForCargo(batch, laboratory.address);
            expect(await tracker.inCargo(batch)).to.equal(true);
            await expect(tracker.connect(fakeCargo).lockForCargo(batch, laboratory.address)).to.be.revertedWith(
                "Drug is already in a cargo"
            );
        });

        it("does not let the owner transfer a locked batch", async function () {
            const { tracker, laboratory, distributor, fakeCargo, batch } = await loadFixture(linkedFixture);
            await tracker.connect(fakeCargo).lockForCargo(batch, laboratory.address);
            await expect(
                tracker.connect(laboratory).transferDrug(batch, distributor.address, State.InDistribution)
            ).to.be.revertedWith("Drug is in a cargo");

            await tracker.connect(fakeCargo).unlockFromCargo(batch);
            await tracker.connect(laboratory).transferDrug(batch, distributor.address, State.InDistribution);
        });

        it("moves a locked batch on behalf of its owner, following the role rules", async function () {
            const { tracker, laboratory, distributor, warehouse, fakeCargo, batch } =
                await loadFixture(linkedFixture);

            await expect(
                tracker.connect(fakeCargo).transferFromCargo(batch, laboratory.address, distributor.address, State.InDistribution)
            ).to.be.revertedWith("Drug is not in a cargo");

            await tracker.connect(fakeCargo).lockForCargo(batch, laboratory.address);

            await expect(
                tracker.connect(fakeCargo).transferFromCargo(batch, distributor.address, warehouse.address, State.InTransit)
            ).to.be.revertedWith("You are not the current owner.");
            await expect(
                tracker.connect(fakeCargo).transferFromCargo(batch, laboratory.address, warehouse.address, State.InTransit)
            ).to.be.revertedWith("Invalid recipient role");

            await expect(
                tracker.connect(fakeCargo).transferFromCargo(batch, laboratory.address, distributor.address, State.InDistribution)
            )
                .to.emit(tracker, "DrugTransferred")
                .withArgs(anyValue, laboratory.address, distributor.address, State.InDistribution);
            expect((await tracker.getDrugInfo(batch)).currentOwner).to.equal(distributor.address);
            expect(await tracker.inCargo(batch)).to.equal(true);
        });

        it("lets the owner force-unlock a batch left locked by a replaced cargo tracker", async function () {
            const { tracker, laboratory, stranger, fakeCargo, batch } = await loadFixture(linkedFixture);
            await tracker.connect(fakeCargo).lockForCargo(batch, laboratory.address);

            await expect(tracker.connect(stranger).forceUnlock(batch)).to.be.revertedWith(
                "Only the contract owner can perform this action."
            );
            await tracker.forceUnlock(batch);
            expect(await tracker.inCargo(batch)).to.equal(false);
        });
    });
});
