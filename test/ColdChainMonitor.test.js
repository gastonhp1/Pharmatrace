const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { encodeReading, leafHash } = require("../backend/iot/reading");
const { buildTree, verifyProof } = require("../backend/iot/merkle");

const Role = { None: 0, Manufacturer: 1, Distributor: 2, Warehouse: 3, Pharmacy: 4, Patient: 5 };
const Verdict = { Unknown: 0, Monitoring: 1, Compliant: 2, Compromised: 3 };
const EventKind = { LidOpened: 0, Shock: 1, SealBroken: 2 };

const DAY = 24 * 60 * 60;

describe("Cold chain (DeviceRegistry + ColdChainMonitor)", function () {
    async function deployFixture() {
        const [laboratory, distributor, warehouse, pharmacy, patient, gateway, stranger] =
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
        await cargo.createCargo("C-1", ["B-1", "B-2"]);
        await cargo.createCargo("C-2", ["B-3"]);

        const registry = await (await ethers.getContractFactory("DeviceRegistry")).deploy();
        const monitor = await (await ethers.getContractFactory("ColdChainMonitor")).deploy(
            await registry.getAddress(),
            await cargo.getAddress()
        );

        await registry.setAttestor(gateway.address, true);

        const now = await time.latest();
        const calibrationExpiry = now + 30 * DAY;
        const pubKey = ethers.hexlify(ethers.randomBytes(64));
        await registry.registerDevice("VAL-001", pubKey, calibrationExpiry);
        await registry.registerDevice("VAL-002", ethers.hexlify(ethers.randomBytes(64)), now + 30 * DAY);

        // 2.00 C to 8.00 C, with up to 30 minutes outside of it in total.
        await monitor.setPolicy("pharma-2-8c", 200, 800, 1800);

        return {
            drug,
            cargo,
            registry,
            monitor,
            laboratory,
            distributor,
            gateway,
            stranger,
            pubKey,
            calibrationExpiry,
        };
    }

    async function monitoringFixture() {
        const ctx = await deployFixture();
        await ctx.monitor.connect(ctx.gateway).startMonitoring("C-1", "VAL-001", "pharma-2-8c");
        return ctx;
    }

    // A window that ended a minute ago, inside the policy range unless overridden.
    async function makeWindow(overrides = {}) {
        const now = await time.latest();
        return {
            root: ethers.keccak256("0x01"),
            count: 3,
            from: now - 120,
            to: now - 60,
            minTemp: 400,
            maxTemp: 500,
            excursionSeconds: 0,
            ...overrides,
        };
    }

    describe("DeviceRegistry", function () {
        it("registers a device and exposes its key and calibration", async function () {
            const { registry, pubKey, calibrationExpiry } = await loadFixture(deployFixture);

            const device = await registry.getDevice("VAL-001");
            expect(device.pubKey).to.equal(pubKey);
            expect(device.calibrationExpiry).to.equal(calibrationExpiry);
            expect(device.active).to.equal(true);
            expect(await registry.isOperationalAt("VAL-001", await time.latest())).to.equal(true);
        });

        it("emits DeviceRegistered", async function () {
            const { registry } = await loadFixture(deployFixture);
            const expiry = (await time.latest()) + DAY;
            const key = ethers.hexlify(ethers.randomBytes(64));
            await expect(registry.registerDevice("VAL-009", key, expiry))
                .to.emit(registry, "DeviceRegistered")
                .withArgs("VAL-009", key, expiry);
        });

        it("only lets the owner register devices", async function () {
            const { registry, stranger } = await loadFixture(deployFixture);
            await expect(
                registry
                    .connect(stranger)
                    .registerDevice("VAL-009", ethers.hexlify(ethers.randomBytes(64)), (await time.latest()) + DAY)
            ).to.be.revertedWith("Only the contract owner can perform this action.");
        });

        it("rejects duplicates, bad keys, empty ids and expired calibrations", async function () {
            const { registry } = await loadFixture(deployFixture);
            const key = ethers.hexlify(ethers.randomBytes(64));
            const future = (await time.latest()) + DAY;

            await expect(registry.registerDevice("VAL-001", key, future)).to.be.revertedWith(
                "Device already registered"
            );
            await expect(
                registry.registerDevice("VAL-009", ethers.hexlify(ethers.randomBytes(33)), future)
            ).to.be.revertedWith("Public key must be 64 bytes");
            await expect(registry.registerDevice("", key, future)).to.be.revertedWith("Invalid device id");
            await expect(
                registry.registerDevice("VAL-009", key, (await time.latest()) - 1)
            ).to.be.revertedWith("Calibration already expired");
        });

        it("stops being operational when the calibration expires, but still was before", async function () {
            const { registry, calibrationExpiry } = await loadFixture(deployFixture);

            await time.increaseTo(calibrationExpiry + 10);

            expect(await registry.isOperationalAt("VAL-001", calibrationExpiry - 1)).to.equal(true);
            expect(await registry.isOperationalAt("VAL-001", await time.latest())).to.equal(false);
        });

        it("renews the calibration", async function () {
            const { registry, calibrationExpiry } = await loadFixture(deployFixture);
            const renewed = calibrationExpiry + 30 * DAY;

            await expect(registry.updateCalibration("VAL-001", renewed))
                .to.emit(registry, "CalibrationUpdated")
                .withArgs("VAL-001", renewed);
            expect((await registry.getDevice("VAL-001")).calibrationExpiry).to.equal(renewed);

            await expect(registry.updateCalibration("NOPE", renewed)).to.be.revertedWith(
                "Device does not exist"
            );
            await expect(
                registry.updateCalibration("VAL-001", (await time.latest()) - 1)
            ).to.be.revertedWith("Calibration already expired");
        });

        it("revokes a device for good", async function () {
            const { registry } = await loadFixture(deployFixture);

            await expect(registry.revokeDevice("VAL-001"))
                .to.emit(registry, "DeviceRevoked")
                .withArgs("VAL-001");

            expect((await registry.getDevice("VAL-001")).active).to.equal(false);
            expect(await registry.isOperationalAt("VAL-001", await time.latest())).to.equal(false);
        });

        it("manages attestors (owner only, no zero address)", async function () {
            const { registry, stranger } = await loadFixture(deployFixture);

            await expect(registry.setAttestor(stranger.address, true))
                .to.emit(registry, "AttestorSet")
                .withArgs(stranger.address, true);
            expect(await registry.isAttestor(stranger.address)).to.equal(true);

            await registry.setAttestor(stranger.address, false);
            expect(await registry.isAttestor(stranger.address)).to.equal(false);

            await expect(
                registry.connect(stranger).setAttestor(stranger.address, true)
            ).to.be.revertedWith("Only the contract owner can perform this action.");
            await expect(registry.setAttestor(ethers.ZeroAddress, true)).to.be.revertedWith(
                "Invalid attestor address."
            );
        });

        it("reports unknown devices", async function () {
            const { registry } = await loadFixture(deployFixture);
            await expect(registry.getDevice("NOPE")).to.be.revertedWith("Device does not exist");
            expect(await registry.isOperationalAt("NOPE", await time.latest())).to.equal(false);
        });
    });

    describe("policies", function () {
        it("stores a policy", async function () {
            const { monitor } = await loadFixture(deployFixture);

            const policy = await monitor.getPolicy("pharma-2-8c");
            expect(policy.minTemp).to.equal(200);
            expect(policy.maxTemp).to.equal(800);
            expect(policy.maxExcursionSeconds).to.equal(1800);
        });

        it("emits PolicySet", async function () {
            const { monitor } = await loadFixture(deployFixture);
            await expect(monitor.setPolicy("ambient", 1500, 2500, 3600))
                .to.emit(monitor, "PolicySet")
                .withArgs("ambient", 1500, 2500, 3600);
        });

        it("only lets the owner create policies", async function () {
            const { monitor, stranger } = await loadFixture(deployFixture);
            await expect(
                monitor.connect(stranger).setPolicy("ambient", 1500, 2500, 3600)
            ).to.be.revertedWith("Only the contract owner can perform this action.");
        });

        it("rejects duplicates (policies are immutable), empty ids and inverted ranges", async function () {
            const { monitor } = await loadFixture(deployFixture);
            await expect(monitor.setPolicy("pharma-2-8c", 0, 100, 0)).to.be.revertedWith(
                "Policy already exists"
            );
            await expect(monitor.setPolicy("", 0, 100, 0)).to.be.revertedWith("Invalid policy id");
            await expect(monitor.setPolicy("bad", 800, 200, 0)).to.be.revertedWith(
                "Invalid temperature range"
            );
            await expect(monitor.setPolicy("bad", 200, 200, 0)).to.be.revertedWith(
                "Invalid temperature range"
            );
        });

        it("reports unknown policies", async function () {
            const { monitor } = await loadFixture(deployFixture);
            await expect(monitor.getPolicy("NOPE")).to.be.revertedWith("Policy does not exist");
        });
    });

    describe("startMonitoring", function () {
        it("binds a device to a cargo when an attestor starts it", async function () {
            const { monitor, gateway } = await loadFixture(deployFixture);

            await expect(monitor.connect(gateway).startMonitoring("C-1", "VAL-001", "pharma-2-8c"))
                .to.emit(monitor, "MonitoringStarted")
                .withArgs("C-1", "VAL-001", "pharma-2-8c");

            const session = await monitor.getSession("C-1");
            expect(session.deviceId).to.equal("VAL-001");
            expect(session.policyId).to.equal("pharma-2-8c");
            expect(session.compromised).to.equal(false);
            expect(session.closed).to.equal(false);
            expect(await monitor.activeCargoOf("VAL-001")).to.equal("C-1");
            expect(await monitor.getVerdict("C-1")).to.equal(Verdict.Monitoring);
        });

        it("lets the cargo's current owner start it", async function () {
            const { monitor, laboratory } = await loadFixture(deployFixture);
            await monitor.connect(laboratory).startMonitoring("C-1", "VAL-001", "pharma-2-8c");
            expect(await monitor.getVerdict("C-1")).to.equal(Verdict.Monitoring);
        });

        it("rejects anyone else", async function () {
            const { monitor, stranger } = await loadFixture(deployFixture);
            await expect(
                monitor.connect(stranger).startMonitoring("C-1", "VAL-001", "pharma-2-8c")
            ).to.be.revertedWith("Not authorized to monitor this cargo.");
        });

        it("rejects unknown cargos", async function () {
            const { monitor, gateway } = await loadFixture(deployFixture);
            await expect(
                monitor.connect(gateway).startMonitoring("NOPE", "VAL-001", "pharma-2-8c")
            ).to.be.revertedWith("Cargo not found");
        });

        it("rejects delivered cargos", async function () {
            const { monitor, cargo, gateway } = await loadFixture(deployFixture);
            await cargo.markDelivered("C-1");
            await expect(
                monitor.connect(gateway).startMonitoring("C-1", "VAL-001", "pharma-2-8c")
            ).to.be.revertedWith("Cargo already delivered");
        });

        it("rejects a second monitoring on the same cargo", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            await expect(
                monitor.connect(gateway).startMonitoring("C-1", "VAL-002", "pharma-2-8c")
            ).to.be.revertedWith("Monitoring already started");
        });

        it("rejects unknown policies", async function () {
            const { monitor, gateway } = await loadFixture(deployFixture);
            await expect(
                monitor.connect(gateway).startMonitoring("C-1", "VAL-001", "NOPE")
            ).to.be.revertedWith("Policy does not exist");
        });

        it("rejects unregistered, revoked and uncalibrated devices", async function () {
            const { monitor, registry, gateway, calibrationExpiry } = await loadFixture(deployFixture);

            await expect(
                monitor.connect(gateway).startMonitoring("C-1", "NOPE", "pharma-2-8c")
            ).to.be.revertedWith("Device is not operational");

            await registry.revokeDevice("VAL-002");
            await expect(
                monitor.connect(gateway).startMonitoring("C-1", "VAL-002", "pharma-2-8c")
            ).to.be.revertedWith("Device is not operational");

            await time.increaseTo(calibrationExpiry + 10);
            await expect(
                monitor.connect(gateway).startMonitoring("C-1", "VAL-001", "pharma-2-8c")
            ).to.be.revertedWith("Device is not operational");
        });

        it("rejects a device that is already monitoring another cargo", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            await expect(
                monitor.connect(gateway).startMonitoring("C-2", "VAL-001", "pharma-2-8c")
            ).to.be.revertedWith("Device is already in use");
        });
    });

    describe("anchorReadings", function () {
        it("anchors a window and counts it", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            const window = await makeWindow();

            await expect(monitor.connect(gateway).anchorReadings("C-1", window))
                .to.emit(monitor, "ReadingsAnchored")
                .withArgs("C-1", 0, window.root, 3, window.from, window.to);

            const session = await monitor.getSession("C-1");
            expect(session.anchorCount).to.equal(1);
            expect(session.readingCount).to.equal(3);
            expect(session.lastWindowEnd).to.equal(window.to);
            expect(session.excursionSeconds).to.equal(0);
            expect(await monitor.getRoot("C-1", 0)).to.equal(window.root);
            expect(await monitor.getVerdict("C-1")).to.equal(Verdict.Monitoring);
        });

        it("only accepts attestors", async function () {
            const { monitor, laboratory, stranger } = await loadFixture(monitoringFixture);
            const window = await makeWindow();
            await expect(monitor.connect(stranger).anchorReadings("C-1", window)).to.be.revertedWith(
                "Only an attestor can perform this action."
            );
            // Not even the cargo owner: only the gateway vouches for the device.
            await expect(monitor.connect(laboratory).anchorReadings("C-1", window)).to.be.revertedWith(
                "Only an attestor can perform this action."
            );
        });

        it("rejects cargos that are not being monitored", async function () {
            const { monitor, gateway } = await loadFixture(deployFixture);
            await expect(
                monitor.connect(gateway).anchorReadings("C-1", await makeWindow())
            ).to.be.revertedWith("Monitoring not found");
        });

        it("rejects malformed windows", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            const anchor = async (overrides) =>
                monitor.connect(gateway).anchorReadings("C-1", await makeWindow(overrides));

            await expect(anchor({ root: ethers.ZeroHash })).to.be.revertedWith("Invalid root");
            await expect(anchor({ count: 0 })).to.be.revertedWith("Empty window");
            const now = await time.latest();
            await expect(anchor({ from: now - 10, to: now - 20 })).to.be.revertedWith("Invalid window");
            await expect(anchor({ minTemp: 600, maxTemp: 500 })).to.be.revertedWith(
                "Invalid temperature range"
            );
        });

        it("rejects windows from the future", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            const now = await time.latest();
            await expect(
                monitor.connect(gateway).anchorReadings("C-1", await makeWindow({ to: now + 1000 }))
            ).to.be.revertedWith("Window is in the future");
        });

        it("rejects windows that overlap the previous one", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            const first = await makeWindow();
            await monitor.connect(gateway).anchorReadings("C-1", first);

            await expect(
                monitor.connect(gateway).anchorReadings("C-1", { ...first, from: first.to })
            ).to.be.revertedWith("Window overlaps previous one");

            await monitor
                .connect(gateway)
                .anchorReadings("C-1", { ...first, from: first.to + 1, to: first.to + 30 });
            expect((await monitor.getSession("C-1")).anchorCount).to.equal(2);
        });

        it("rejects a window that went out of range without any time out of range", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            await expect(
                monitor.connect(gateway).anchorReadings("C-1", await makeWindow({ minTemp: 100 }))
            ).to.be.revertedWith("Inconsistent excursion data");
            await expect(
                monitor.connect(gateway).anchorReadings("C-1", await makeWindow({ maxTemp: 900 }))
            ).to.be.revertedWith("Inconsistent excursion data");
        });

        it("records excursions and keeps the cargo compliant while under budget", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            const window = await makeWindow({ minTemp: 100, maxTemp: 500, excursionSeconds: 600 });

            await expect(monitor.connect(gateway).anchorReadings("C-1", window))
                .to.emit(monitor, "ExcursionRecorded")
                .withArgs("C-1", 100, 500, 600, 600);

            expect((await monitor.getSession("C-1")).excursionSeconds).to.equal(600);
            expect(await monitor.getVerdict("C-1")).to.equal(Verdict.Monitoring);
        });

        it("compromises the cargo when the excursion budget is exceeded", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            const first = await makeWindow({ minTemp: 100, excursionSeconds: 1000 });
            await monitor.connect(gateway).anchorReadings("C-1", first);
            expect(await monitor.getVerdict("C-1")).to.equal(Verdict.Monitoring);

            const second = {
                ...first,
                from: first.to + 1,
                to: first.to + 30,
                excursionSeconds: 801, // 1801 s in total, budget is 1800
            };
            await expect(monitor.connect(gateway).anchorReadings("C-1", second))
                .to.emit(monitor, "CargoCompromised")
                .withArgs("C-1", "Excursion budget exceeded");

            expect(await monitor.getVerdict("C-1")).to.equal(Verdict.Compromised);
            expect((await monitor.getSession("C-1")).compromised).to.equal(true);
        });

        it("allows an excursion of exactly the budget", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            await monitor
                .connect(gateway)
                .anchorReadings("C-1", await makeWindow({ minTemp: 100, excursionSeconds: 1800 }));
            expect(await monitor.getVerdict("C-1")).to.equal(Verdict.Monitoring);
        });

        it("emits CargoCompromised only once", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            const first = await makeWindow({ minTemp: 100, excursionSeconds: 2000 });
            await expect(monitor.connect(gateway).anchorReadings("C-1", first)).to.emit(
                monitor,
                "CargoCompromised"
            );

            const second = { ...first, from: first.to + 1, to: first.to + 30 };
            await expect(monitor.connect(gateway).anchorReadings("C-1", second)).to.not.emit(
                monitor,
                "CargoCompromised"
            );
        });

        it("judges the window by the device's calibration at its end, not at anchoring time", async function () {
            const { monitor, gateway, calibrationExpiry } = await loadFixture(monitoringFixture);

            await time.increaseTo(calibrationExpiry + 100);

            await expect(
                monitor
                    .connect(gateway)
                    .anchorReadings("C-1", await makeWindow({ from: calibrationExpiry - 60, to: calibrationExpiry - 10 }))
            ).to.emit(monitor, "ReadingsAnchored");

            await expect(
                monitor
                    .connect(gateway)
                    .anchorReadings("C-1", await makeWindow({ from: calibrationExpiry + 1, to: calibrationExpiry + 50 }))
            ).to.be.revertedWith("Device is not operational");
        });

        it("rejects windows once the device is revoked", async function () {
            const { monitor, registry, gateway } = await loadFixture(monitoringFixture);
            await registry.revokeDevice("VAL-001");
            await expect(
                monitor.connect(gateway).anchorReadings("C-1", await makeWindow())
            ).to.be.revertedWith("Device is not operational");
        });
    });

    describe("reportEvent", function () {
        const payloadHash = ethers.keccak256("0x1234");

        it("logs a lid opening or a shock without compromising the cargo", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            const now = await time.latest();

            await expect(monitor.connect(gateway).reportEvent("C-1", EventKind.LidOpened, now, payloadHash))
                .to.emit(monitor, "DeviceEvent")
                .withArgs("C-1", EventKind.LidOpened, now, payloadHash);
            await expect(monitor.connect(gateway).reportEvent("C-1", EventKind.Shock, now, payloadHash))
                .to.emit(monitor, "DeviceEvent")
                .withArgs("C-1", EventKind.Shock, now, payloadHash);

            expect(await monitor.getVerdict("C-1")).to.equal(Verdict.Monitoring);
        });

        it("compromises the cargo when the seal is broken", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            const now = await time.latest();

            const tx = monitor.connect(gateway).reportEvent("C-1", EventKind.SealBroken, now, payloadHash);
            await expect(tx).to.emit(monitor, "DeviceEvent");
            await expect(tx).to.emit(monitor, "CargoCompromised").withArgs("C-1", "Seal broken");

            expect(await monitor.getVerdict("C-1")).to.equal(Verdict.Compromised);
        });

        it("only accepts attestors, active cargos and past timestamps", async function () {
            const { monitor, gateway, stranger } = await loadFixture(monitoringFixture);
            const now = await time.latest();

            await expect(
                monitor.connect(stranger).reportEvent("C-1", EventKind.Shock, now, payloadHash)
            ).to.be.revertedWith("Only an attestor can perform this action.");
            await expect(
                monitor.connect(gateway).reportEvent("C-2", EventKind.Shock, now, payloadHash)
            ).to.be.revertedWith("Monitoring not found");
            await expect(
                monitor.connect(gateway).reportEvent("C-1", EventKind.Shock, now + 1000, payloadHash)
            ).to.be.revertedWith("Event is in the future");
        });
    });

    describe("closeMonitoring", function () {
        it("closes a clean monitoring as compliant and frees the device", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            await monitor.connect(gateway).anchorReadings("C-1", await makeWindow());

            await expect(monitor.connect(gateway).closeMonitoring("C-1"))
                .to.emit(monitor, "MonitoringClosed")
                .withArgs("C-1", true);

            expect(await monitor.getVerdict("C-1")).to.equal(Verdict.Compliant);
            expect(await monitor.activeCargoOf("VAL-001")).to.equal("");

            // The device can monitor another cargo now.
            await monitor.connect(gateway).startMonitoring("C-2", "VAL-001", "pharma-2-8c");
            expect(await monitor.activeCargoOf("VAL-001")).to.equal("C-2");
        });

        it("keeps a compromised verdict after closing", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            await monitor
                .connect(gateway)
                .reportEvent("C-1", EventKind.SealBroken, await time.latest(), ethers.ZeroHash);

            await expect(monitor.connect(gateway).closeMonitoring("C-1"))
                .to.emit(monitor, "MonitoringClosed")
                .withArgs("C-1", false);
            expect(await monitor.getVerdict("C-1")).to.equal(Verdict.Compromised);
        });

        it("can be closed by the cargo's owner", async function () {
            const { monitor, laboratory } = await loadFixture(monitoringFixture);
            await monitor.connect(laboratory).closeMonitoring("C-1");
            expect(await monitor.getVerdict("C-1")).to.equal(Verdict.Compliant);
        });

        it("rejects strangers, unknown and already closed monitorings", async function () {
            const { monitor, gateway, stranger } = await loadFixture(monitoringFixture);

            await expect(monitor.connect(stranger).closeMonitoring("C-1")).to.be.revertedWith(
                "Not authorized to monitor this cargo."
            );
            await expect(monitor.connect(gateway).closeMonitoring("C-2")).to.be.revertedWith(
                "Monitoring not found"
            );

            await monitor.connect(gateway).closeMonitoring("C-1");
            await expect(monitor.connect(gateway).closeMonitoring("C-1")).to.be.revertedWith(
                "Monitoring already closed"
            );
            await expect(
                monitor.connect(gateway).anchorReadings("C-1", await makeWindow())
            ).to.be.revertedWith("Monitoring already closed");
        });
    });

    describe("verdict and views", function () {
        it("is Unknown for a cargo that was never monitored", async function () {
            const { monitor } = await loadFixture(deployFixture);
            expect(await monitor.getVerdict("C-1")).to.equal(Verdict.Unknown);
            await expect(monitor.getSession("C-1")).to.be.revertedWith("Monitoring not found");
        });

        it("rejects roots that were never anchored", async function () {
            const { monitor } = await loadFixture(monitoringFixture);
            await expect(monitor.getRoot("C-1", 0)).to.be.revertedWith("Anchor not found");
            await expect(
                monitor.verifyReading("C-1", 0, ethers.ZeroHash, [])
            ).to.be.revertedWith("Anchor not found");
        });
    });

    describe("verifyReading (Merkle proofs built by the backend)", function () {
        // Five readings, so the tree has an odd level (the last node is carried up).
        const readings = [0, 1, 2, 3, 4].map((i) => ({
            ts: 1_800_000_000 + i * 60,
            seq: i + 1,
            tempCenti: 450 + i * 10,
            humCenti: 5500,
            flags: 0,
            latE5: -3_460_000 + i,
            lonE5: -5_840_000 - i,
        }));

        it("accepts the proof of every reading and rejects anything else", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);

            const leaves = readings.map((r) => leafHash(encodeReading(r)));
            const tree = buildTree(leaves);
            const now = await time.latest();
            await monitor.connect(gateway).anchorReadings("C-1", {
                root: tree.root,
                count: leaves.length,
                from: now - 400,
                to: now - 100,
                minTemp: 450,
                maxTemp: 490,
                excursionSeconds: 0,
            });

            for (let i = 0; i < leaves.length; i++) {
                const proof = tree.proof(i);
                expect(verifyProof(leaves[i], proof, tree.root)).to.equal(true);
                expect(await monitor.verifyReading("C-1", 0, leaves[i], proof)).to.equal(true);
            }

            // A reading that was altered after the fact is not in the anchored window.
            const tampered = leafHash(encodeReading({ ...readings[2], tempCenti: 500 }));
            expect(await monitor.verifyReading("C-1", 0, tampered, tree.proof(2))).to.equal(false);

            // A valid proof for a different leaf does not work either.
            expect(await monitor.verifyReading("C-1", 0, leaves[1], tree.proof(2))).to.equal(false);
        });

        it("works for a single-reading window", async function () {
            const { monitor, gateway } = await loadFixture(monitoringFixture);
            const leaf = leafHash(encodeReading(readings[0]));
            const tree = buildTree([leaf]);
            expect(tree.root).to.equal(leaf);

            await monitor
                .connect(gateway)
                .anchorReadings("C-1", await makeWindow({ root: tree.root, count: 1 }));
            expect(await monitor.verifyReading("C-1", 0, leaf, tree.proof(0))).to.equal(true);
        });
    });
});
