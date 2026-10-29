package contract

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// Cold chain, ported from contracts/DeviceRegistry.sol and contracts/ColdChainMonitor.sol. The
// valija travels with a cargo and signs its readings; the IoT gateway (backend/iot) verifies them
// off-chain against the device's public key registered here, and anchors one Merkle root per
// window together with the numbers the chaincode needs to judge the window against the policy.
//
// Differences with the Solidity version:
//   - A gateway is any identity whose certificate carries pharmatrace.role=iot-gateway (issued by
//     its org's CA) from an org the regulator authorized (AuthorizeGatewayOrg), instead of a list
//     of addresses. Rotating or adding a gateway is a CA operation; no transaction needed.
//   - Each org registers its own valijas; the regulator sets the policies.
//   - The Merkle tree uses SHA-256 instead of keccak256 (see iot/docs/READING_FORMAT.md).

var (
	hex32 = regexp.MustCompile(`^(0x)?[0-9a-fA-F]{64}$`)
	hex64 = regexp.MustCompile(`^(0x)?[0-9a-fA-F]{128}$`)
)

// clockSkewSeconds is how far in the future (by the transaction timestamp) a window can end.
const clockSkewSeconds = 60

func normHex(s string) string { return strings.ToLower(strings.TrimPrefix(s, "0x")) }

// ================================================================= devices

// RegisterDevice registers a valija of the caller's org: its P-256 public key (X || Y, 64 bytes
// in hex) and when its calibration expires (unix seconds).
func (c *PharmaTrace) RegisterDevice(ctx contractapi.TransactionContextInterface, deviceID string, pubKey string, calibrationExpiry int64) (*Device, error) {
	msp, err := clientMSP(ctx)
	if err != nil {
		return nil, err
	}
	role, err := orgRole(ctx, msp)
	if err != nil {
		return nil, err
	}
	if role == "" && msp != RegulatorMSP {
		return nil, forbidden("org %s is not registered", msp)
	}
	if strings.TrimSpace(deviceID) == "" {
		return nil, invalid("invalid device ID")
	}
	if !hex64.MatchString(pubKey) {
		return nil, invalid("pubKey has to be 64 bytes in hex (P-256 X || Y)")
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	if calibrationExpiry <= now.Unix() {
		return nil, invalid("calibration already expired")
	}
	var existing Device
	exists, err := getJSON(ctx, objDevice, []string{deviceID}, &existing)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, conflict("device %s already exists", deviceID)
	}
	device := &Device{ID: deviceID, Org: msp, PubKey: normHex(pubKey), CalibrationExpiry: calibrationExpiry, Active: true}
	return device, putJSON(ctx, objDevice, []string{deviceID}, device)
}

// SetDeviceActive turns a valija on or off (lost, broken, out for calibration). Its org or the
// regulator can do it. A valija that is monitoring a cargo cannot be turned off.
func (c *PharmaTrace) SetDeviceActive(ctx contractapi.TransactionContextInterface, deviceID string, active bool) (*Device, error) {
	device, err := c.GetDevice(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	msp, err := clientMSP(ctx)
	if err != nil {
		return nil, err
	}
	if msp != device.Org && msp != RegulatorMSP {
		return nil, forbidden("device %s belongs to %s", deviceID, device.Org)
	}
	if !active && device.ActiveCargo != "" {
		return nil, conflict("device %s is monitoring cargo %s", deviceID, device.ActiveCargo)
	}
	device.Active = active
	return device, putJSON(ctx, objDevice, []string{deviceID}, device)
}

// GetDevice returns a valija, with its public key and the cargo it is monitoring.
func (c *PharmaTrace) GetDevice(ctx contractapi.TransactionContextInterface, deviceID string) (*Device, error) {
	var device Device
	found, err := getJSON(ctx, objDevice, []string{deviceID}, &device)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, notFound("device %s does not exist", deviceID)
	}
	return &device, nil
}

// ================================================================= policies and gateways

// SetColdChainPolicy creates a temperature policy. Policies are immutable: to change one, create
// another, so a cargo is always judged by the rules it left with.
func (c *PharmaTrace) SetColdChainPolicy(
	ctx contractapi.TransactionContextInterface,
	policyID string, minTemp int, maxTemp int, maxExcursionSeconds int,
) error {
	if err := requireRegulator(ctx); err != nil {
		return err
	}
	if strings.TrimSpace(policyID) == "" {
		return invalid("invalid policy ID")
	}
	if minTemp >= maxTemp {
		return invalid("invalid temperature range: %d >= %d", minTemp, maxTemp)
	}
	if maxExcursionSeconds < 0 {
		return invalid("maxExcursionSeconds cannot be negative")
	}
	var existing ColdChainPolicy
	exists, err := getJSON(ctx, objPolicy, []string{policyID}, &existing)
	if err != nil {
		return err
	}
	if exists {
		return conflict("policy %s already exists", policyID)
	}
	return putJSON(ctx, objPolicy, []string{policyID}, ColdChainPolicy{
		ID: policyID, MinTemp: minTemp, MaxTemp: maxTemp, MaxExcursionSeconds: maxExcursionSeconds,
	})
}

// GetColdChainPolicy returns a policy.
func (c *PharmaTrace) GetColdChainPolicy(ctx contractapi.TransactionContextInterface, policyID string) (*ColdChainPolicy, error) {
	var policy ColdChainPolicy
	found, err := getJSON(ctx, objPolicy, []string{policyID}, &policy)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, notFound("policy %s does not exist", policyID)
	}
	return &policy, nil
}

// AuthorizeGatewayOrg makes the regulator accept the IoT gateways of an org: its identities whose
// certificate has the attribute pharmatrace.role=iot-gateway.
func (c *PharmaTrace) AuthorizeGatewayOrg(ctx contractapi.TransactionContextInterface, mspID string) (*GatewayOrg, error) {
	if err := requireRegulator(ctx); err != nil {
		return nil, err
	}
	role, err := orgRole(ctx, mspID)
	if err != nil {
		return nil, err
	}
	if role == "" {
		return nil, notFound("org %s is not registered", mspID)
	}
	now, err := txTimeString(ctx)
	if err != nil {
		return nil, err
	}
	g := &GatewayOrg{MSPID: mspID, AuthorizedAt: now}
	return g, putJSON(ctx, objGatewayOrg, []string{mspID}, g)
}

// RevokeGatewayOrg stops accepting the IoT gateways of an org. To stop a single gateway, its org
// revokes the certificate in its CA and publishes the CRL in the channel (see fabric/docs/PKI.md).
func (c *PharmaTrace) RevokeGatewayOrg(ctx contractapi.TransactionContextInterface, mspID string) error {
	if err := requireRegulator(ctx); err != nil {
		return err
	}
	k, err := key(ctx, objGatewayOrg, []string{mspID})
	if err != nil {
		return err
	}
	return ctx.GetStub().DelState(k)
}

// IsAttestor tells whether the caller is an authorized IoT gateway.
func (c *PharmaTrace) IsAttestor(ctx contractapi.TransactionContextInterface) (bool, error) {
	return isAttestor(ctx)
}

// ================================================================= monitoring

// StartMonitoring binds a valija to a cargo under a policy. Sent by the cargo's owner or by an
// authorized gateway.
func (c *PharmaTrace) StartMonitoring(ctx contractapi.TransactionContextInterface, cargoID string, deviceID string, policyID string) (*Monitoring, error) {
	cargo, err := c.ReadCargo(ctx, cargoID)
	if err != nil {
		return nil, err
	}
	msp, err := clientMSP(ctx)
	if err != nil {
		return nil, err
	}
	attestor, err := isAttestor(ctx)
	if err != nil {
		return nil, err
	}
	if msp != cargo.Owner && !attestor {
		return nil, forbidden("only the owner of cargo %s or an authorized gateway can monitor it", cargoID)
	}
	if cargo.State == CargoDelivered || cargo.State == CargoDissolved {
		return nil, conflict("cargo %s is %s", cargoID, cargo.State)
	}
	var existing Monitoring
	exists, err := getJSON(ctx, objMonitoring, []string{cargoID}, &existing)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, conflict("cargo %s is already monitored", cargoID)
	}
	if _, err := c.GetColdChainPolicy(ctx, policyID); err != nil {
		return nil, err
	}
	device, err := c.GetDevice(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	if !device.Active || device.CalibrationExpiry <= now.Unix() {
		return nil, conflict("device %s is not operational (inactive or out of calibration)", deviceID)
	}
	if device.ActiveCargo != "" {
		return nil, conflict("device %s is already monitoring cargo %s", deviceID, device.ActiveCargo)
	}
	device.ActiveCargo = cargoID
	if err := putJSON(ctx, objDevice, []string{deviceID}, device); err != nil {
		return nil, err
	}
	m := &Monitoring{
		CargoID:   cargoID,
		DeviceID:  deviceID,
		PolicyID:  policyID,
		StartedAt: now.Format("2006-01-02T15:04:05Z07:00"),
		Roots:     []string{},
		Events:    []DeviceEvent{},
		Verdict:   VerdictMonitoring,
	}
	return m, putJSON(ctx, objMonitoring, []string{cargoID}, m)
}

// AnchorWindow records a window of readings. Only an authorized gateway can send it. Windows have
// to come in order, must not overlap and cannot end in the future.
func (c *PharmaTrace) AnchorWindow(ctx contractapi.TransactionContextInterface, cargoID string, window Window) (*Monitoring, error) {
	if err := requireAttestor(ctx); err != nil {
		return nil, err
	}
	m, policy, err := c.openMonitoring(ctx, cargoID)
	if err != nil {
		return nil, err
	}

	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	switch {
	case !hex32.MatchString(window.Root) || strings.Trim(normHex(window.Root), "0") == "":
		return nil, invalid("invalid root: 32 bytes in hex, not zero")
	case window.Count <= 0:
		return nil, invalid("empty window")
	case window.From > window.To:
		return nil, invalid("invalid window: from > to")
	case window.From <= m.LastWindowEnd:
		return nil, conflict("window overlaps or comes before the previous one (ended at %d)", m.LastWindowEnd)
	case window.To > now.Unix()+clockSkewSeconds:
		return nil, conflict("window ends in the future")
	case window.MinTemp > window.MaxTemp:
		return nil, invalid("invalid window: minTemp > maxTemp")
	case window.ExcursionSeconds < 0:
		return nil, invalid("excursionSeconds cannot be negative")
	}
	outOfRange := window.MinTemp < policy.MinTemp || window.MaxTemp > policy.MaxTemp
	if outOfRange && window.ExcursionSeconds == 0 {
		return nil, conflict("the window went out of range but reports no excursion time")
	}

	m.Roots = append(m.Roots, normHex(window.Root))
	m.LastWindowEnd = window.To
	m.ReadingCount += window.Count
	m.ExcursionSeconds += window.ExcursionSeconds

	event, payload := EventReadingsAnchored, coldChainEvent{CargoID: cargoID, Verdict: m.Verdict, ExcursionSeconds: m.ExcursionSeconds}
	if m.Verdict != VerdictCompromised && m.ExcursionSeconds > policy.MaxExcursionSeconds {
		m.Verdict = VerdictCompromised
		m.Reason = fmt.Sprintf("%d seconds out of range, the policy allows %d", m.ExcursionSeconds, policy.MaxExcursionSeconds)
		event, payload = EventColdChainCompromise, coldChainEvent{CargoID: cargoID, Verdict: m.Verdict, ExcursionSeconds: m.ExcursionSeconds, Reason: m.Reason}
	}
	if err := putJSON(ctx, objMonitoring, []string{cargoID}, m); err != nil {
		return nil, err
	}
	return m, emit(ctx, event, payload)
}

// ReportDeviceEvent records an event from the valija, with the hash of the reading that showed
// it. A broken seal compromises the cargo on the spot; an opened lid or a shock is only recorded
// (the lid opens at every handover).
func (c *PharmaTrace) ReportDeviceEvent(ctx contractapi.TransactionContextInterface, cargoID string, kind string, timestamp int64, payloadHash string) (*Monitoring, error) {
	if err := requireAttestor(ctx); err != nil {
		return nil, err
	}
	m, _, err := c.openMonitoring(ctx, cargoID)
	if err != nil {
		return nil, err
	}
	switch kind {
	case DeviceEventLidOpened, DeviceEventShock, DeviceEventSealBroken:
	default:
		return nil, invalid("invalid event %q", kind)
	}
	if !hex32.MatchString(payloadHash) {
		return nil, invalid("payloadHash has to be 32 bytes in hex")
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	if timestamp > now.Unix()+clockSkewSeconds {
		return nil, conflict("event is in the future")
	}

	m.Events = append(m.Events, DeviceEvent{Kind: kind, Timestamp: timestamp, PayloadHash: normHex(payloadHash)})
	compromised := kind == DeviceEventSealBroken && m.Verdict != VerdictCompromised
	if compromised {
		m.Verdict = VerdictCompromised
		m.Reason = fmt.Sprintf("seal broken at %d", timestamp)
	}
	if err := putJSON(ctx, objMonitoring, []string{cargoID}, m); err != nil {
		return nil, err
	}
	if compromised {
		return m, emit(ctx, EventColdChainCompromise, coldChainEvent{CargoID: cargoID, Verdict: m.Verdict, ExcursionSeconds: m.ExcursionSeconds, Reason: m.Reason})
	}
	return m, nil
}

// CloseMonitoring ends the session and frees the valija. Without problems the verdict becomes
// COMPLIANT; a COMPROMISED verdict stays. After closing the verdict is final.
func (c *PharmaTrace) CloseMonitoring(ctx contractapi.TransactionContextInterface, cargoID string) (*Monitoring, error) {
	cargo, err := c.ReadCargo(ctx, cargoID)
	if err != nil {
		return nil, err
	}
	msp, err := clientMSP(ctx)
	if err != nil {
		return nil, err
	}
	attestor, err := isAttestor(ctx)
	if err != nil {
		return nil, err
	}
	// While in transit the recipient is the one who opens the valija and closes the session.
	if msp != cargo.Owner && msp != cargo.PendingTo && !attestor {
		return nil, forbidden("only the holder of cargo %s or an authorized gateway can close its monitoring", cargoID)
	}
	m, _, err := c.openMonitoring(ctx, cargoID)
	if err != nil {
		return nil, err
	}
	if m.Verdict == VerdictMonitoring {
		m.Verdict = VerdictCompliant
	}
	m.Closed = true
	if err := putJSON(ctx, objMonitoring, []string{cargoID}, m); err != nil {
		return nil, err
	}

	device, err := c.GetDevice(ctx, m.DeviceID)
	if err != nil {
		return nil, err
	}
	device.ActiveCargo = ""
	if err := putJSON(ctx, objDevice, []string{device.ID}, device); err != nil {
		return nil, err
	}
	return m, emit(ctx, EventMonitoringClosed, coldChainEvent{CargoID: cargoID, Verdict: m.Verdict, ExcursionSeconds: m.ExcursionSeconds, Reason: m.Reason})
}

// GetMonitoring returns the cold-chain session of a cargo and its verdict.
func (c *PharmaTrace) GetMonitoring(ctx contractapi.TransactionContextInterface, cargoID string) (*Monitoring, error) {
	var m Monitoring
	found, err := getJSON(ctx, objMonitoring, []string{cargoID}, &m)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, notFound("cargo %s has no cold-chain monitoring", cargoID)
	}
	return &m, nil
}

// VerifyReading checks that a reading (its leaf, sha256 of the payload) belongs to the window
// anchored at anchorIndex, using its Merkle proof. Sibling pairs are hashed in sorted order, so a
// proof is just the list of siblings, as built by backend/iot/merkle.js.
func (c *PharmaTrace) VerifyReading(ctx contractapi.TransactionContextInterface, cargoID string, anchorIndex int, leaf string, proof []string) (bool, error) {
	m, err := c.GetMonitoring(ctx, cargoID)
	if err != nil {
		return false, err
	}
	if anchorIndex < 0 || anchorIndex >= len(m.Roots) {
		return false, notFound("cargo %s has no anchor %d", cargoID, anchorIndex)
	}
	hash, err := decode32(leaf)
	if err != nil {
		return false, err
	}
	for _, s := range proof {
		sibling, err := decode32(s)
		if err != nil {
			return false, err
		}
		hash = hashPair(hash, sibling)
	}
	return hex.EncodeToString(hash) == m.Roots[anchorIndex], nil
}

// ---------------------------------------------------------------- internals

func decode32(s string) ([]byte, error) {
	if !hex32.MatchString(s) {
		return nil, invalid("%q is not 32 bytes in hex", s)
	}
	return hex.DecodeString(normHex(s))
}

func hashPair(a, b []byte) []byte {
	if bytes.Compare(a, b) > 0 {
		a, b = b, a
	}
	sum := sha256.Sum256(append(append([]byte{}, a...), b...))
	return sum[:]
}

func (c *PharmaTrace) openMonitoring(ctx contractapi.TransactionContextInterface, cargoID string) (*Monitoring, *ColdChainPolicy, error) {
	m, err := c.GetMonitoring(ctx, cargoID)
	if err != nil {
		return nil, nil, err
	}
	if m.Closed {
		return nil, nil, conflict("the monitoring of cargo %s is closed", cargoID)
	}
	policy, err := c.GetColdChainPolicy(ctx, m.PolicyID)
	if err != nil {
		return nil, nil, err
	}
	return m, policy, nil
}

// isAttestor: the certificate says iot-gateway and the regulator accepts gateways of its org.
func isAttestor(ctx contractapi.TransactionContextInterface) (bool, error) {
	role, err := clientRole(ctx)
	if err != nil || role != RoleIoTGateway {
		return false, err
	}
	msp, err := clientMSP(ctx)
	if err != nil {
		return false, err
	}
	var g GatewayOrg
	return getJSON(ctx, objGatewayOrg, []string{msp}, &g)
}

func requireAttestor(ctx contractapi.TransactionContextInterface) error {
	ok, err := isAttestor(ctx)
	if err != nil {
		return err
	}
	if !ok {
		return forbidden("only an authorized IoT gateway can do this")
	}
	return nil
}
