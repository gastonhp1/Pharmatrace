// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract DrugTracker {
    address public owner;

    enum State {
        Registered,
        InDistribution,
        InTransit,
        InPharmacy,
        Delivered,
        InUse
    }

    struct Drug {
        string name;
        string batchNumber;
        string manufacturer;
        uint256 productionDate;
        address[] ownershipHistory;
        State currentState;
    }

    mapping(string => Drug) private drugs;
    mapping(string => bool) private drugExists;

    event DrugRegistered(
        string indexed batchNumber,
        string name,
        string manufacturer,
        uint256 productionDate
    );

    event DrugTransferred(
        string indexed batchNumber,
        address indexed from,
        address indexed to,
        State newState
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Only the contract owner can perform this action.");
        _;
    }

    modifier onlyCurrentOwner(string memory _batchNumber) {
        Drug storage drug = drugs[_batchNumber];
        require(msg.sender == drug.ownershipHistory[drug.ownershipHistory.length - 1], "You are not the current owner.");
        _;
    }

    modifier exists(string memory _batchNumber) {
        require(drugExists[_batchNumber], "Drug does not exist.");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function registerDrug(
        string memory _batchNumber,
        string memory _name,
        string memory _manufacturer,
        uint256 _productionDate
    ) public onlyOwner {
        require(!drugExists[_batchNumber], "Drug already registered.");

        Drug storage newDrug = drugs[_batchNumber];
        newDrug.name = _name;
        newDrug.batchNumber = _batchNumber;
        newDrug.manufacturer = _manufacturer;
        newDrug.productionDate = _productionDate;
        newDrug.ownershipHistory.push(msg.sender);
        newDrug.currentState = State.Registered;

        drugExists[_batchNumber] = true;

        emit DrugRegistered(_batchNumber, _name, _manufacturer, _productionDate);
    }

    function transferDrug(
        string memory _batchNumber,
        address _to,
        State _newState
    ) public exists(_batchNumber) onlyCurrentOwner(_batchNumber) {
        require(_to != address(0), "Invalid recipient address.");

        Drug storage drug = drugs[_batchNumber];

        // Ensure logical state progression (cannot go backward)
        require(uint8(_newState) > uint8(drug.currentState), "Invalid state transition.");

        drug.ownershipHistory.push(_to);
        drug.currentState = _newState;

        emit DrugTransferred(_batchNumber, msg.sender, _to, _newState);
    }

    function getDrugInfo(string memory _batchNumber)
    public
    view
    exists(_batchNumber)
    returns (
        string memory name,
        string memory manufacturer,
        uint256 productionDate,
        State currentState,
        address currentOwner
    )
    {
        Drug storage drug = drugs[_batchNumber];
        return (
            drug.name,
            drug.manufacturer,
            drug.productionDate,
            drug.currentState,
            drug.ownershipHistory[drug.ownershipHistory.length - 1]
        );
    }

    function getDrugHistory(string memory _batchNumber)
    public
    view
    exists(_batchNumber)
    returns (address[] memory)
    {
        return drugs[_batchNumber].ownershipHistory;
    }
}
