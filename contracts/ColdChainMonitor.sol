// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IDeviceRegistry {
    function isAttestor(address account) external view returns (bool);

    function isOperationalAt(string calldata deviceId, uint256 timestamp) external view returns (bool);
}

interface ICargoTrackerView {
    function getCargoInfo(string calldata cargoId) external view returns (
        string[] memory batchIds,
        address createdBy,
        address currentOwner,
        uint256 createdAt,
        bool delivered
    );
}

// Cold-chain monitoring of a cargo. The IoT valija travels with a cargo (CargoTracker), so the
// cargo is the unit that gets monitored and every batch inside it shares the verdict.
//
// Raw readings never go on-chain. A gateway verifies the device signatures off-chain, stores the
// readings and anchors a Merkle root per window of readings, together with a few numbers that
// the contract can check against the policy (observed min/max, seconds out of range). Anyone
// holding a reading and its proof can later check that it belongs to an anchored window
// (verifyReading), and the device's public key in DeviceRegistry lets them re-check its signature.
//
// DrugTracker is left untouched: its state machine only moves forward, so a compromised cargo is
// reported here (getVerdict, CargoCompromised) instead of by adding a state to the batches.
contract ColdChainMonitor {
    address public owner;
    IDeviceRegistry public devices;
    ICargoTrackerView public cargoTracker;

    // Temperatures are in hundredths of a degree Celsius (2.00 C = 200).
    struct Policy {
        int32 minTemp;
        int32 maxTemp;
        uint64 maxExcursionSeconds; // total time allowed outside [minTemp, maxTemp]
        bool exists;
    }

    // One window of readings, as computed by the gateway.
    struct Window {
        bytes32 root;
        uint32 count;
        uint64 from; // timestamp of the first reading
        uint64 to; // timestamp of the last reading
        int32 minTemp; // lowest temperature observed in the window
        int32 maxTemp; // highest temperature observed in the window
        uint64 excursionSeconds; // time spent outside the policy range in this window
    }

    enum EventKind {
        LidOpened,
        Shock,
        SealBroken
    }

    enum Verdict {
        Unknown, // never monitored
        Monitoring, // in progress, no problem so far
        Compliant, // closed without problems
        Compromised // the policy was violated
    }

    struct Session {
        string deviceId;
        string policyId;
        uint64 startedAt;
        uint64 lastWindowEnd;
        uint64 excursionSeconds;
        uint64 readingCount;
        bool compromised;
        bool closed;
        bool exists;
        bytes32[] roots;
    }

    mapping(string => Policy) private policies;
    mapping(string => Session) private sessions;
    // Cargo a device is currently monitoring ("" when it is free).
    mapping(string => string) public activeCargoOf;

    event PolicySet(string policyId, int32 minTemp, int32 maxTemp, uint64 maxExcursionSeconds);
    event MonitoringStarted(string cargoId, string deviceId, string policyId);
    event ReadingsAnchored(
        string cargoId,
        uint256 index,
        bytes32 root,
        uint32 count,
        uint64 from,
        uint64 to
    );
    event ExcursionRecorded(
        string cargoId,
        int32 minTemp,
        int32 maxTemp,
        uint64 excursionSeconds,
        uint64 totalExcursionSeconds
    );
    event DeviceEvent(string cargoId, EventKind kind, uint64 timestamp, bytes32 payloadHash);
    event CargoCompromised(string cargoId, string reason);
    event MonitoringClosed(string cargoId, bool compliant);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only the contract owner can perform this action.");
        _;
    }

    modifier onlyAttestor() {
        require(devices.isAttestor(msg.sender), "Only an attestor can perform this action.");
        _;
    }

    modifier activeSession(string memory _cargoId) {
        Session storage session = sessions[_cargoId];
        require(session.exists, "Monitoring not found");
        require(!session.closed, "Monitoring already closed");
        _;
    }

    constructor(address _devices, address _cargoTracker) {
        require(_devices != address(0) && _cargoTracker != address(0), "Invalid address.");

        owner = msg.sender;
        devices = IDeviceRegistry(_devices);
        cargoTracker = ICargoTrackerView(_cargoTracker);
    }

    // ---------------------------------------------------------------- policies

    // Policies are immutable: to change one, create another with a new id. Otherwise a cargo
    // could be judged by rules that changed after it left.
    function setPolicy(
        string memory _policyId,
        int32 _minTemp,
        int32 _maxTemp,
        uint64 _maxExcursionSeconds
    ) external onlyOwner {
        require(bytes(_policyId).length > 0, "Invalid policy id");
        require(!policies[_policyId].exists, "Policy already exists");
        require(_minTemp < _maxTemp, "Invalid temperature range");

        policies[_policyId] = Policy({
            minTemp: _minTemp,
            maxTemp: _maxTemp,
            maxExcursionSeconds: _maxExcursionSeconds,
            exists: true
        });

        emit PolicySet(_policyId, _minTemp, _maxTemp, _maxExcursionSeconds);
    }

    // ---------------------------------------------------------------- monitoring

    // Binds a device to a cargo under a policy. Sent by the cargo's current owner or by an
    // attestor (the backend, which signs on behalf of the owner).
    function startMonitoring(
        string memory _cargoId,
        string memory _deviceId,
        string memory _policyId
    ) external {
        // Reverts with "Cargo not found" if the cargo does not exist.
        (, , address currentOwner, , bool delivered) = cargoTracker.getCargoInfo(_cargoId);

        require(
            msg.sender == currentOwner || devices.isAttestor(msg.sender),
            "Not authorized to monitor this cargo."
        );
        require(!delivered, "Cargo already delivered");
        require(!sessions[_cargoId].exists, "Monitoring already started");
        require(policies[_policyId].exists, "Policy does not exist");
        require(devices.isOperationalAt(_deviceId, block.timestamp), "Device is not operational");
        require(bytes(activeCargoOf[_deviceId]).length == 0, "Device is already in use");

        Session storage session = sessions[_cargoId];
        session.deviceId = _deviceId;
        session.policyId = _policyId;
        session.startedAt = uint64(block.timestamp);
        session.exists = true;

        activeCargoOf[_deviceId] = _cargoId;

        emit MonitoringStarted(_cargoId, _deviceId, _policyId);
    }

    // Anchors a window of readings. Windows have to come in order and must not overlap.
    function anchorReadings(string memory _cargoId, Window calldata _window)
        external
        onlyAttestor
        activeSession(_cargoId)
    {
        Session storage session = sessions[_cargoId];
        Policy storage policy = policies[session.policyId];

        require(_window.root != bytes32(0), "Invalid root");
        require(_window.count > 0, "Empty window");
        require(_window.from <= _window.to, "Invalid window");
        require(_window.from > session.lastWindowEnd, "Window overlaps previous one");
        require(_window.to <= block.timestamp, "Window is in the future");
        require(_window.minTemp <= _window.maxTemp, "Invalid temperature range");
        require(
            devices.isOperationalAt(session.deviceId, _window.to),
            "Device is not operational"
        );

        // A window that went outside the range has to account for some time out of it.
        if (_window.minTemp < policy.minTemp || _window.maxTemp > policy.maxTemp) {
            require(_window.excursionSeconds > 0, "Inconsistent excursion data");
        }

        session.roots.push(_window.root);
        session.lastWindowEnd = _window.to;
        session.readingCount += _window.count;

        emit ReadingsAnchored(
            _cargoId,
            session.roots.length - 1,
            _window.root,
            _window.count,
            _window.from,
            _window.to
        );

        if (_window.excursionSeconds > 0) {
            session.excursionSeconds += _window.excursionSeconds;

            emit ExcursionRecorded(
                _cargoId,
                _window.minTemp,
                _window.maxTemp,
                _window.excursionSeconds,
                session.excursionSeconds
            );

            if (session.excursionSeconds > policy.maxExcursionSeconds) {
                _compromise(_cargoId, session, "Excursion budget exceeded");
            }
        }
    }

    // Events that do not fit in the temperature windows. A broken seal compromises the cargo
    // right away; a lid opening or a shock is recorded for the audit but is not fatal by itself
    // (the lid is opened on every legitimate handoff).
    function reportEvent(
        string memory _cargoId,
        EventKind _kind,
        uint64 _timestamp,
        bytes32 _payloadHash
    ) external onlyAttestor activeSession(_cargoId) {
        require(_timestamp <= block.timestamp, "Event is in the future");

        emit DeviceEvent(_cargoId, _kind, _timestamp, _payloadHash);

        if (_kind == EventKind.SealBroken) {
            _compromise(_cargoId, sessions[_cargoId], "Seal broken");
        }
    }

    // Ends the monitoring and frees the device. After this the verdict is final.
    function closeMonitoring(string memory _cargoId) external activeSession(_cargoId) {
        (, , address currentOwner, , ) = cargoTracker.getCargoInfo(_cargoId);
        require(
            msg.sender == currentOwner || devices.isAttestor(msg.sender),
            "Not authorized to monitor this cargo."
        );

        Session storage session = sessions[_cargoId];
        session.closed = true;
        delete activeCargoOf[session.deviceId];

        emit MonitoringClosed(_cargoId, !session.compromised);
    }

    // ---------------------------------------------------------------- views

    function getPolicy(string memory _policyId)
        external
        view
        returns (int32 minTemp, int32 maxTemp, uint64 maxExcursionSeconds)
    {
        Policy storage policy = policies[_policyId];
        require(policy.exists, "Policy does not exist");
        return (policy.minTemp, policy.maxTemp, policy.maxExcursionSeconds);
    }

    function getSession(string memory _cargoId)
        external
        view
        returns (
            string memory deviceId,
            string memory policyId,
            uint64 startedAt,
            uint64 lastWindowEnd,
            uint64 excursionSeconds,
            uint64 readingCount,
            uint256 anchorCount,
            bool compromised,
            bool closed
        )
    {
        Session storage session = sessions[_cargoId];
        require(session.exists, "Monitoring not found");
        return (
            session.deviceId,
            session.policyId,
            session.startedAt,
            session.lastWindowEnd,
            session.excursionSeconds,
            session.readingCount,
            session.roots.length,
            session.compromised,
            session.closed
        );
    }

    function getVerdict(string memory _cargoId) external view returns (Verdict) {
        Session storage session = sessions[_cargoId];
        if (!session.exists) return Verdict.Unknown;
        if (session.compromised) return Verdict.Compromised;
        if (session.closed) return Verdict.Compliant;
        return Verdict.Monitoring;
    }

    function getRoot(string memory _cargoId, uint256 _index) external view returns (bytes32) {
        Session storage session = sessions[_cargoId];
        require(session.exists, "Monitoring not found");
        require(_index < session.roots.length, "Anchor not found");
        return session.roots[_index];
    }

    // Checks that `_leaf` (the keccak256 of a packed reading, see iot/docs/READING_FORMAT.md)
    // belongs to the window anchored at `_index`. Pairs are hashed in sorted order, so the
    // proof needs no left/right flags.
    function verifyReading(
        string memory _cargoId,
        uint256 _index,
        bytes32 _leaf,
        bytes32[] calldata _proof
    ) external view returns (bool) {
        Session storage session = sessions[_cargoId];
        require(session.exists, "Monitoring not found");
        require(_index < session.roots.length, "Anchor not found");

        bytes32 hash = _leaf;
        for (uint256 i = 0; i < _proof.length; i++) {
            bytes32 sibling = _proof[i];
            hash = hash <= sibling
                ? keccak256(abi.encodePacked(hash, sibling))
                : keccak256(abi.encodePacked(sibling, hash));
        }
        return hash == session.roots[_index];
    }

    // ---------------------------------------------------------------- internals

    function _compromise(string memory _cargoId, Session storage _session, string memory _reason) private {
        if (_session.compromised) return;

        _session.compromised = true;
        emit CargoCompromised(_cargoId, _reason);
    }
}
