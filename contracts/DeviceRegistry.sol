// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Registry of the IoT devices (cold-chain "valijas") and of the gateways allowed to speak for
// them on-chain.
//
// A device never sends transactions: it signs its readings with a key that lives in a secure
// element (ATECC608, P-256), and a gateway verifies those signatures off-chain and then
// attests the result in ColdChainMonitor. The registry is what ties the two together: it holds
// the device's public key (so anyone can re-verify a reading), its calibration expiry (readings
// from an uncalibrated sensor are worthless in an audit) and the list of attestor addresses.
contract DeviceRegistry {
    address public owner;

    struct Device {
        bytes pubKey; // 64 bytes: P-256 public key as X || Y
        uint64 calibrationExpiry; // unix seconds
        bool active;
        bool exists;
    }

    mapping(string => Device) private devices;
    mapping(address => bool) public isAttestor;

    event DeviceRegistered(string deviceId, bytes pubKey, uint64 calibrationExpiry);
    event CalibrationUpdated(string deviceId, uint64 calibrationExpiry);
    event DeviceRevoked(string deviceId);
    event AttestorSet(address indexed attestor, bool allowed);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only the contract owner can perform this action.");
        _;
    }

    modifier deviceExists(string memory _deviceId) {
        require(devices[_deviceId].exists, "Device does not exist");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ---------------------------------------------------------------- administration

    function setAttestor(address _attestor, bool _allowed) external onlyOwner {
        require(_attestor != address(0), "Invalid attestor address.");

        isAttestor[_attestor] = _allowed;
        emit AttestorSet(_attestor, _allowed);
    }

    function registerDevice(
        string memory _deviceId,
        bytes memory _pubKey,
        uint64 _calibrationExpiry
    ) external onlyOwner {
        require(bytes(_deviceId).length > 0, "Invalid device id");
        require(!devices[_deviceId].exists, "Device already registered");
        require(_pubKey.length == 64, "Public key must be 64 bytes");
        require(_calibrationExpiry > block.timestamp, "Calibration already expired");

        devices[_deviceId] = Device({
            pubKey: _pubKey,
            calibrationExpiry: _calibrationExpiry,
            active: true,
            exists: true
        });

        emit DeviceRegistered(_deviceId, _pubKey, _calibrationExpiry);
    }

    function updateCalibration(string memory _deviceId, uint64 _calibrationExpiry)
        external
        onlyOwner
        deviceExists(_deviceId)
    {
        require(_calibrationExpiry > block.timestamp, "Calibration already expired");

        devices[_deviceId].calibrationExpiry = _calibrationExpiry;
        emit CalibrationUpdated(_deviceId, _calibrationExpiry);
    }

    // A lost, stolen or compromised device. It cannot be re-activated: register a new one.
    function revokeDevice(string memory _deviceId) external onlyOwner deviceExists(_deviceId) {
        devices[_deviceId].active = false;
        emit DeviceRevoked(_deviceId);
    }

    // ---------------------------------------------------------------- views

    function getDevice(string memory _deviceId)
        external
        view
        deviceExists(_deviceId)
        returns (bytes memory pubKey, uint64 calibrationExpiry, bool active)
    {
        Device storage device = devices[_deviceId];
        return (device.pubKey, device.calibrationExpiry, device.active);
    }

    // True if the device is registered, not revoked and calibrated at `_timestamp`. Taking the
    // time as a parameter lets a window of readings be anchored late (after a connectivity
    // gap) as long as the device was calibrated when it measured.
    function isOperationalAt(string memory _deviceId, uint256 _timestamp) external view returns (bool) {
        Device storage device = devices[_deviceId];
        return device.exists && device.active && device.calibrationExpiry >= _timestamp;
    }
}
