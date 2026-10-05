// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

interface IDrugTracker {
    function getDrugInfo(string calldata batchId) external view returns (
        string memory name,
        string memory manufacturer,
        uint256 productionDate,
        uint8 state,
        address currentOwner
    );

    function lockForCargo(string calldata batchId, address by) external;

    function unlockFromCargo(string calldata batchId) external;

    function transferFromCargo(
        string calldata batchId,
        address from,
        address to,
        uint8 newState
    ) external;
}

// A cargo groups batches that travel together. While a batch is inside a cargo it is locked in
// DrugTracker, and moving the cargo moves its batches too, so the ownership of the cargo and of
// its batches cannot diverge. DrugTracker.setCargoTracker must point to this contract.
contract CargoTracker {
    uint256 public constant MAX_BATCHES_PER_CARGO = 100;

    struct Cargo {
        string[] batchIds;
        address createdBy;
        address currentOwner;
        uint256 createdAt;
        bool delivered;
    }

    mapping(string => Cargo) private cargos;

    IDrugTracker public drugContract;

    event CargoCreated(string cargoId, address indexed by, string[] batchIds);
    event CargoTransferred(string cargoId, address from, address to);
    event CargoDelivered(string cargoId, address indexed by);

    constructor(address _drugContract) {
        drugContract = IDrugTracker(_drugContract);
    }

    function createCargo(string memory cargoId, string[] memory batchIds) external {
        require(cargos[cargoId].createdAt == 0, "Cargo already exists");
        require(batchIds.length > 0, "Cargo must have at least one drug");
        require(batchIds.length <= MAX_BATCHES_PER_CARGO, "Too many drugs in a cargo");

        // Locking a batch checks that it exists, that the sender owns it and that it is not in
        // another cargo (which also rejects a batch listed twice in the same cargo).
        for (uint i = 0; i < batchIds.length; i++) {
            drugContract.lockForCargo(batchIds[i], msg.sender);
        }

        cargos[cargoId] = Cargo({
            batchIds: batchIds,
            createdBy: msg.sender,
            currentOwner: msg.sender,
            createdAt: block.timestamp,
            delivered: false
        });

        emit CargoCreated(cargoId, msg.sender, batchIds);
    }

    // Moves the cargo and every batch in it to `to`. `newState` is the state the batches take
    // (it has to match the receiver's role, see DrugTracker).
    function transferCargo(string memory cargoId, address to, uint8 newState) external {
        Cargo storage cargo = cargos[cargoId];
        require(cargo.createdAt != 0, "Cargo does not exist");
        require(cargo.currentOwner == msg.sender, "Only owner can transfer");
        require(!cargo.delivered, "Cargo already delivered");
        require(to != address(0), "Invalid recipient address.");

        for (uint i = 0; i < cargo.batchIds.length; i++) {
            drugContract.transferFromCargo(cargo.batchIds[i], msg.sender, to, newState);
        }

        cargo.currentOwner = to;
        emit CargoTransferred(cargoId, msg.sender, to);
    }

    function getCargoInfo(string memory cargoId) external view returns (
        string[] memory batchIds,
        address createdBy,
        address currentOwner,
        uint256 createdAt,
        bool delivered
    ) {
        Cargo storage cargo = cargos[cargoId];
        require(cargo.createdAt != 0, "Cargo not found");

        return (
            cargo.batchIds,
            cargo.createdBy,
            cargo.currentOwner,
            cargo.createdAt,
            cargo.delivered
        );
    }

    // Closes the cargo and unlocks its batches, which stay with the current owner and can
    // continue down the chain one by one.
    function markDelivered(string memory cargoId) external {
        Cargo storage cargo = cargos[cargoId];
        require(cargo.createdAt != 0, "Cargo not found");
        require(cargo.currentOwner == msg.sender, "Only current owner can mark delivered");
        require(!cargo.delivered, "Cargo already delivered");

        cargo.delivered = true;

        for (uint i = 0; i < cargo.batchIds.length; i++) {
            drugContract.unlockFromCargo(cargo.batchIds[i]);
        }

        emit CargoDelivered(cargoId, msg.sender);
    }
}
