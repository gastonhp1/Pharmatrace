package contract

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// Cold chain, ported from contracts/ColdChainMonitor.sol. The valija signs its readings, the IoT
// gateway (backend/iot) verifies them off-chain and anchors one Merkle root per window together
// with the numbers the chaincode needs to judge the window against the policy.
//
// Differences with the Solidity version:
//   - Gateways are authorized by client certificate (RegisterAttestor) instead of by address.
//   - The unit monitored is the batch, because this chaincode has no cargoes yet.
//   - The regulator, not the manufacturer, sets the policies and authorizes the gateways.

var hex32 = regexp.MustCompile(`^(0x)?[0-9a-fA-F]{64}$`)

// clockSkewSeconds is how far in the future (by the transaction timestamp) a window can end.
const clockSkewSeconds = 60

// SetColdChainPolicy creates a temperature policy. Policies are immutable: to change one, create
// another, so a batch is always judged by the rules it left with.
func (c *PharmaTrace) SetColdChainPolicy(
	ctx contractapi.TransactionContextInterface,
	policyID string, minTemp int, maxTemp int, maxExcursionSeconds int,
) error {
	if err := requireRegulator(ctx); err != nil {
		return err
	}
	if strings.TrimSpace(policyID) == "" {
		return fmt.Errorf("invalid policy ID")
	}
	if minTemp >= maxTemp {
		return fmt.Errorf("invalid temperature range: %d >= %d", minTemp, maxTemp)
	}
	if maxExcursionSeconds < 0 {
		return fmt.Errorf("maxExcursionSeconds cannot be negative")
	}
	var existing ColdChainPolicy
	exists, err := getJSON(ctx, objPolicy, []string{policyID}, &existing)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("policy %s already exists", policyID)
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
		return nil, fmt.Errorf("policy %s does not exist", policyID)
	}
	return &policy, nil
}

// RegisterAttestor authorizes an IoT gateway identity to anchor readings. clientID is what
// WhoAmI returns when called with the gateway's certificate.
func (c *PharmaTrace) RegisterAttestor(ctx contractapi.TransactionContextInterface, mspID string, gatewayClientID string) error {
	if err := requireRegulator(ctx); err != nil {
		return err
	}
	if strings.TrimSpace(mspID) == "" || strings.TrimSpace(gatewayClientID) == "" {
		return fmt.Errorf("mspID and gatewayClientID are required")
	}
	return putJSON(ctx, objAttestor, []string{mspID, gatewayClientID}, Attestor{ClientID: gatewayClientID, MSPID: mspID})
}

// RevokeAttestor removes an IoT gateway identity.
func (c *PharmaTrace) RevokeAttestor(ctx contractapi.TransactionContextInterface, mspID string, gatewayClientID string) error {
	if err := requireRegulator(ctx); err != nil {
		return err
	}
	k, err := key(ctx, objAttestor, []string{mspID, gatewayClientID})
	if err != nil {
		return err
	}
	return ctx.GetStub().DelState(k)
}

// StartMonitoring binds a valija to a batch under a policy. Sent by the batch owner or by an
// authorized gateway.
func (c *PharmaTrace) StartMonitoring(ctx contractapi.TransactionContextInterface, batchID string, deviceID string, policyID string) (*Monitoring, error) {
	batch, err := c.ReadBatch(ctx, batchID)
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
	if msp != batch.Owner && !attestor {
		return nil, fmt.Errorf("only the owner of batch %s or an authorized gateway can monitor it", batchID)
	}
	if batch.State == StateDispensed || batch.State == StateRecalled {
		return nil, fmt.Errorf("batch %s is %s", batchID, batch.State)
	}
	if strings.TrimSpace(deviceID) == "" {
		return nil, fmt.Errorf("invalid device ID")
	}
	if _, err := c.GetColdChainPolicy(ctx, policyID); err != nil {
		return nil, err
	}
	var existing Monitoring
	exists, err := getJSON(ctx, objMonitoring, []string{batchID}, &existing)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, fmt.Errorf("batch %s is already monitored", batchID)
	}

	now, err := txTimeString(ctx)
	if err != nil {
		return nil, err
	}
	m := &Monitoring{
		BatchID:   batchID,
		DeviceID:  deviceID,
		PolicyID:  policyID,
		StartedAt: now,
		Roots:     []string{},
		Verdict:   VerdictMonitoring,
	}
	return m, putJSON(ctx, objMonitoring, []string{batchID}, m)
}

// AnchorWindow records a window of readings. Only an authorized gateway can send it. Windows have
// to come in order, must not overlap and cannot end in the future.
func (c *PharmaTrace) AnchorWindow(ctx contractapi.TransactionContextInterface, batchID string, window Window) (*Monitoring, error) {
	if err := requireAttestor(ctx); err != nil {
		return nil, err
	}
	m, policy, err := c.openMonitoring(ctx, batchID)
	if err != nil {
		return nil, err
	}

	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	switch {
	case !hex32.MatchString(window.Root) || strings.Trim(strings.TrimPrefix(window.Root, "0x"), "0") == "":
		return nil, fmt.Errorf("invalid root: 32 bytes in hex, not zero")
	case window.Count <= 0:
		return nil, fmt.Errorf("empty window")
	case window.From > window.To:
		return nil, fmt.Errorf("invalid window: from > to")
	case window.From <= m.LastWindowEnd:
		return nil, fmt.Errorf("window overlaps or comes before the previous one (ended at %d)", m.LastWindowEnd)
	case window.To > now.Unix()+clockSkewSeconds:
		return nil, fmt.Errorf("window ends in the future")
	case window.MinTemp > window.MaxTemp:
		return nil, fmt.Errorf("invalid window: minTemp > maxTemp")
	case window.ExcursionSeconds < 0:
		return nil, fmt.Errorf("excursionSeconds cannot be negative")
	}
	outOfRange := window.MinTemp < policy.MinTemp || window.MaxTemp > policy.MaxTemp
	if outOfRange && window.ExcursionSeconds == 0 {
		return nil, fmt.Errorf("the window went out of range but reports no excursion time")
	}

	m.Roots = append(m.Roots, strings.ToLower(strings.TrimPrefix(window.Root, "0x")))
	m.LastWindowEnd = window.To
	m.ReadingCount += window.Count
	m.ExcursionSeconds += window.ExcursionSeconds

	event, payload := EventReadingsAnchored, coldChainEvent{BatchID: batchID, Verdict: m.Verdict, ExcursionSeconds: m.ExcursionSeconds}
	if m.Verdict != VerdictCompromised && m.ExcursionSeconds > policy.MaxExcursionSeconds {
		m.Verdict = VerdictCompromised
		m.Reason = fmt.Sprintf("%d seconds out of range, the policy allows %d", m.ExcursionSeconds, policy.MaxExcursionSeconds)
		event, payload = EventColdChainCompromise, coldChainEvent{BatchID: batchID, Verdict: m.Verdict, ExcursionSeconds: m.ExcursionSeconds, Reason: m.Reason}
	}
	if err := putJSON(ctx, objMonitoring, []string{batchID}, m); err != nil {
		return nil, err
	}
	return m, emit(ctx, event, payload)
}

// ReportDeviceEvent records an event from the valija. A broken seal compromises the batch on
// the spot; an opened lid or a shock is only recorded (the lid opens at every handover).
func (c *PharmaTrace) ReportDeviceEvent(ctx contractapi.TransactionContextInterface, batchID string, kind string, timestamp int64) (*Monitoring, error) {
	if err := requireAttestor(ctx); err != nil {
		return nil, err
	}
	m, _, err := c.openMonitoring(ctx, batchID)
	if err != nil {
		return nil, err
	}
	switch kind {
	case DeviceEventLidOpened, DeviceEventShock:
		// Recorded by the transaction itself: it stays in the block with its arguments.
		return m, nil
	case DeviceEventSealBroken:
		if m.Verdict == VerdictCompromised {
			return m, nil
		}
		m.Verdict = VerdictCompromised
		m.Reason = fmt.Sprintf("seal broken at %d", timestamp)
		if err := putJSON(ctx, objMonitoring, []string{batchID}, m); err != nil {
			return nil, err
		}
		return m, emit(ctx, EventColdChainCompromise, coldChainEvent{BatchID: batchID, Verdict: m.Verdict, ExcursionSeconds: m.ExcursionSeconds, Reason: m.Reason})
	default:
		return nil, fmt.Errorf("invalid event %q", kind)
	}
}

// CloseMonitoring ends the session. Without problems the verdict becomes COMPLIANT; a
// COMPROMISED verdict stays. After closing the verdict is final.
func (c *PharmaTrace) CloseMonitoring(ctx contractapi.TransactionContextInterface, batchID string) (*Monitoring, error) {
	batch, err := c.ReadBatch(ctx, batchID)
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
	if msp != batch.Owner && msp != batch.PendingTo && !attestor {
		return nil, fmt.Errorf("only the holder of batch %s or an authorized gateway can close its monitoring", batchID)
	}
	m, _, err := c.openMonitoring(ctx, batchID)
	if err != nil {
		return nil, err
	}
	if m.Verdict == VerdictMonitoring {
		m.Verdict = VerdictCompliant
	}
	m.Closed = true
	if err := putJSON(ctx, objMonitoring, []string{batchID}, m); err != nil {
		return nil, err
	}
	return m, emit(ctx, EventMonitoringClosed, coldChainEvent{BatchID: batchID, Verdict: m.Verdict, ExcursionSeconds: m.ExcursionSeconds, Reason: m.Reason})
}

// GetMonitoring returns the cold-chain session of a batch and its verdict.
func (c *PharmaTrace) GetMonitoring(ctx contractapi.TransactionContextInterface, batchID string) (*Monitoring, error) {
	var m Monitoring
	found, err := getJSON(ctx, objMonitoring, []string{batchID}, &m)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("batch %s has no cold-chain monitoring", batchID)
	}
	return &m, nil
}

// ---------------------------------------------------------------- internals

func (c *PharmaTrace) openMonitoring(ctx contractapi.TransactionContextInterface, batchID string) (*Monitoring, *ColdChainPolicy, error) {
	m, err := c.GetMonitoring(ctx, batchID)
	if err != nil {
		return nil, nil, err
	}
	if m.Closed {
		return nil, nil, fmt.Errorf("the monitoring of batch %s is closed", batchID)
	}
	policy, err := c.GetColdChainPolicy(ctx, m.PolicyID)
	if err != nil {
		return nil, nil, err
	}
	return m, policy, nil
}

func isAttestor(ctx contractapi.TransactionContextInterface) (bool, error) {
	msp, err := clientMSP(ctx)
	if err != nil {
		return false, err
	}
	id, err := clientID(ctx)
	if err != nil {
		return false, err
	}
	var a Attestor
	return getJSON(ctx, objAttestor, []string{msp, id}, &a)
}

func requireAttestor(ctx contractapi.TransactionContextInterface) error {
	ok, err := isAttestor(ctx)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("only an authorized IoT gateway can do this")
	}
	return nil
}
