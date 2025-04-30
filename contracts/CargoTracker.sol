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
}

contract CargoTracker {
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

    constructor(address _drugContract) {
        drugContract = IDrugTracker(_drugContract);
    }

    function createCargo(string memory cargoId, string[] memory batchIds) external {
        require(cargos[cargoId].createdAt == 0, "Cargo already exists");

        // Verifica que quien crea el cargo sea dueño de todos los batchIds
        for (uint i = 0; i < batchIds.length; i++) {
            (, , , , address owner) = drugContract.getDrugInfo(batchIds[i]);
            require(owner == msg.sender, "Sender does not own all drugs");
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

    function transferCargo(string memory cargoId, address to) external {
        require(cargos[cargoId].createdAt != 0, "Cargo does not exist");
        require(cargos[cargoId].currentOwner == msg.sender, "Only owner can transfer");

        cargos[cargoId].currentOwner = to;
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

    function markDelivered(string memory cargoId) external {
        require(cargos[cargoId].createdAt != 0, "Cargo not found");
        require(cargos[cargoId].currentOwner == msg.sender, "Only current owner can mark delivered");

        cargos[cargoId].delivered = true;
    }
}
