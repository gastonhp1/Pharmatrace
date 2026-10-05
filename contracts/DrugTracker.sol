// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract DrugTracker {
    address public owner;
    address public cargoTracker;

    enum State {
        Registered,
        InDistribution,
        InTransit,
        InPharmacy,
        Delivered,
        InUse
    }

    // Actors of the supply chain, in the order a batch travels through them. A batch can only
    // be handed to the next role in this list, and the state it gets is set by the receiver's
    // role: Distributor -> InDistribution, Warehouse -> InTransit, Pharmacy -> InPharmacy,
    // Patient -> Delivered. InUse is set by the patient with markInUse.
    enum Role {
        None,
        Manufacturer,
        Distributor,
        Warehouse,
        Pharmacy,
        Patient
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
    mapping(address => Role) public roleOf;
    // True while a batch travels inside a cargo: only the CargoTracker moves it then.
    mapping(string => bool) public inCargo;

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

    event DrugUsed(string indexed batchNumber, address indexed patient);
    event ActorRegistered(address indexed actor, Role role);
    event CargoTrackerSet(address indexed cargoTracker);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only the contract owner can perform this action.");
        _;
    }

    modifier onlyCurrentOwner(string memory _batchNumber) {
        require(msg.sender == _currentOwner(_batchNumber), "You are not the current owner.");
        _;
    }

    modifier exists(string memory _batchNumber) {
        require(drugExists[_batchNumber], "Drug does not exist.");
        _;
    }

    modifier onlyCargoTracker() {
        require(msg.sender == cargoTracker, "Only the cargo tracker can perform this action.");
        _;
    }

    constructor() {
        owner = msg.sender;
        roleOf[msg.sender] = Role.Manufacturer;
        emit ActorRegistered(msg.sender, Role.Manufacturer);
    }

    // ---------------------------------------------------------------- administration

    function registerActor(address _actor, Role _role) external onlyOwner {
        require(_actor != address(0), "Invalid actor address.");
        require(_role != Role.None, "Invalid role.");
        require(_actor != owner || _role == Role.Manufacturer, "The owner is always the manufacturer.");

        roleOf[_actor] = _role;
        emit ActorRegistered(_actor, _role);
    }

    // The only contract allowed to lock, unlock and move batches that travel in a cargo.
    function setCargoTracker(address _cargoTracker) external onlyOwner {
        require(_cargoTracker != address(0), "Invalid cargo tracker address.");

        cargoTracker = _cargoTracker;
        emit CargoTrackerSet(_cargoTracker);
    }

    // Escape hatch for batches left locked by a cargo tracker that was replaced.
    function forceUnlock(string memory _batchNumber) external onlyOwner exists(_batchNumber) {
        inCargo[_batchNumber] = false;
    }

    // ---------------------------------------------------------------- drugs

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
        require(!inCargo[_batchNumber], "Drug is in a cargo");

        _transfer(_batchNumber, msg.sender, _to, _newState);
    }

    // The patient marks a delivered batch as being used. It is the last state.
    function markInUse(string memory _batchNumber)
    external
    exists(_batchNumber)
    onlyCurrentOwner(_batchNumber)
    {
        require(roleOf[msg.sender] == Role.Patient, "Only patients can mark a drug as in use");

        Drug storage drug = drugs[_batchNumber];
        require(drug.currentState == State.Delivered, "Drug must be delivered first");

        drug.currentState = State.InUse;
        emit DrugUsed(_batchNumber, msg.sender);
    }

    // ---------------------------------------------------------------- cargo integration

    function lockForCargo(string memory _batchNumber, address _by)
    external
    onlyCargoTracker
    exists(_batchNumber)
    {
        require(!inCargo[_batchNumber], "Drug is already in a cargo");
        require(_currentOwner(_batchNumber) == _by, "Sender does not own all drugs");

        inCargo[_batchNumber] = true;
    }

    function unlockFromCargo(string memory _batchNumber)
    external
    onlyCargoTracker
    exists(_batchNumber)
    {
        inCargo[_batchNumber] = false;
    }

    function transferFromCargo(
        string memory _batchNumber,
        address _from,
        address _to,
        State _newState
    ) external onlyCargoTracker exists(_batchNumber) {
        require(inCargo[_batchNumber], "Drug is not in a cargo");
        require(_currentOwner(_batchNumber) == _from, "You are not the current owner.");

        _transfer(_batchNumber, _from, _to, _newState);
    }

    // ---------------------------------------------------------------- views

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
            _currentOwner(_batchNumber)
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

    // ---------------------------------------------------------------- internals

    function _currentOwner(string memory _batchNumber) private view returns (address) {
        Drug storage drug = drugs[_batchNumber];
        return drug.ownershipHistory[drug.ownershipHistory.length - 1];
    }

    function _transfer(
        string memory _batchNumber,
        address _from,
        address _to,
        State _newState
    ) private {
        require(_to != address(0), "Invalid recipient address.");

        // The batch can only move to the next role in the chain...
        require(uint8(roleOf[_to]) == uint8(roleOf[_from]) + 1, "Invalid recipient role");
        // ...and the new state is the one that role stands for.
        require(uint8(_newState) == uint8(roleOf[_to]) - 1, "State does not match recipient role");

        Drug storage drug = drugs[_batchNumber];
        // Ensure logical state progression (cannot go backward)
        require(uint8(_newState) > uint8(drug.currentState), "Invalid state transition.");

        drug.ownershipHistory.push(_to);
        drug.currentState = _newState;

        emit DrugTransferred(_batchNumber, _from, _to, _newState);
    }
}
