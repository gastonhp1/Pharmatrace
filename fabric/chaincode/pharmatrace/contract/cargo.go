package contract

import (
	"strings"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// Cargoes, ported from contracts/CargoTracker.sol with one change: a cargo is one leg of the
// trip (from one org to the next), not the whole route. That is how a shipment with its IoT
// valija works in practice, and it keeps every cargo transaction endorsable by the same two orgs
// as its batches: the holder and the regulator.

// CreateCargo groups batches the caller owns so they travel together. They are locked to the
// cargo until it is received or dissolved.
func (c *PharmaTrace) CreateCargo(ctx contractapi.TransactionContextInterface, cargoID string, batchIDs []string) (*Cargo, error) {
	msp, err := clientMSP(ctx)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(cargoID) == "" {
		return nil, invalid("invalid cargo ID")
	}
	if len(batchIDs) == 0 || len(batchIDs) > MaxBatchesPerCargo {
		return nil, invalid("a cargo needs between 1 and %d batches, got %d", MaxBatchesPerCargo, len(batchIDs))
	}
	var existing Cargo
	exists, err := getJSON(ctx, objCargo, []string{cargoID}, &existing)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, conflict("cargo %s already exists", cargoID)
	}

	seen := map[string]bool{}
	batches := make([]*Batch, 0, len(batchIDs))
	for _, id := range batchIDs {
		if seen[id] {
			return nil, invalid("batch %s is repeated", id)
		}
		seen[id] = true
		batch, err := c.ownedBatch(ctx, id)
		if err != nil {
			return nil, err
		}
		if batch.Cargo != "" {
			return nil, conflict("batch %s is already in cargo %s", id, batch.Cargo)
		}
		if batch.State == StateInTransit || batch.State == StateInPharmacy {
			return nil, conflict("batch %s is %s and cannot go in a cargo", id, batch.State)
		}
		batches = append(batches, batch)
	}

	now, err := txTimeString(ctx)
	if err != nil {
		return nil, err
	}
	for _, batch := range batches {
		batch.Cargo = cargoID
		if err := c.saveBatch(ctx, batch, msp); err != nil {
			return nil, err
		}
	}
	cargo := &Cargo{ID: cargoID, Owner: msp, BatchIDs: batchIDs, State: CargoOpen, CreatedAt: now, UpdatedAt: now}
	if err := putJSON(ctx, objCargo, []string{cargoID}, cargo); err != nil {
		return nil, err
	}
	return cargo, emit(ctx, EventCargoCreated, cargoEvent{CargoID: cargoID, Owner: msp, State: cargo.State, BatchIDs: batchIDs})
}

// DispatchCargo sends the cargo and all its batches to the next org, with the same rules as
// DispatchBatch. If one batch cannot go, nothing moves.
func (c *PharmaTrace) DispatchCargo(ctx contractapi.TransactionContextInterface, cargoID string, toMSP string) (*Cargo, error) {
	cargo, batches, err := c.ownedOpenCargo(ctx, cargoID)
	if err != nil {
		return nil, err
	}
	for _, batch := range batches {
		if batch.State == StateRecalled {
			return nil, conflict("batch %s of cargo %s was recalled: dissolve the cargo and leave it out", batch.ID, cargoID)
		}
		if err := c.checkDispatch(ctx, batch, toMSP); err != nil {
			return nil, err
		}
	}
	for _, batch := range batches {
		batch.State = StateInTransit
		batch.PendingTo = toMSP
		if err := c.saveBatch(ctx, batch, toMSP); err != nil {
			return nil, err
		}
	}
	cargo.State = CargoInTransit
	cargo.PendingTo = toMSP
	if err := c.saveCargo(ctx, cargo); err != nil {
		return nil, err
	}
	return cargo, emit(ctx, EventCargoDispatched, cargoEvent{CargoID: cargoID, Owner: cargo.Owner, State: cargo.State, To: toMSP, BatchIDs: cargo.BatchIDs})
}

// ReceiveCargo is called by the recipient: it takes custody of every batch (recalled ones
// included), the batches leave the cargo and the cargo is closed.
//
// A monitored cargo is received with its verdict final: its monitoring has to be closed first.
// If the cold chain was broken, the batches arrive QUARANTINED: they cannot be dispatched or
// dispensed until the regulator releases them (ReleaseBatch) or recalls them.
func (c *PharmaTrace) ReceiveCargo(ctx contractapi.TransactionContextInterface, cargoID string) (*Cargo, error) {
	msp, err := clientMSP(ctx)
	if err != nil {
		return nil, err
	}
	cargo, err := c.ReadCargo(ctx, cargoID)
	if err != nil {
		return nil, err
	}
	if cargo.State != CargoInTransit || cargo.PendingTo != msp {
		return nil, conflict("cargo %s is not in transit to %s", cargoID, msp)
	}
	reason, err := c.brokenColdChain(ctx, cargoID)
	if err != nil {
		return nil, err
	}
	quarantined := []string{}
	for _, id := range cargo.BatchIDs {
		batch, err := c.ReadBatch(ctx, id)
		if err != nil {
			return nil, err
		}
		if err := c.receive(ctx, batch, msp, reason); err != nil {
			return nil, err
		}
		if batch.State == StateQuarantined {
			quarantined = append(quarantined, id)
		}
	}
	cargo.Owner = msp
	cargo.PendingTo = ""
	cargo.State = CargoDelivered
	if err := c.saveCargo(ctx, cargo); err != nil {
		return nil, err
	}
	event := cargoEvent{CargoID: cargoID, Owner: msp, State: cargo.State, BatchIDs: cargo.BatchIDs}
	if len(quarantined) > 0 {
		event.Quarantined, event.Reason = quarantined, reason
	}
	return cargo, emit(ctx, EventCargoReceived, event)
}

// DissolveCargo undoes a cargo that was not dispatched yet and frees its batches, for example to
// leave out a batch that was recalled. The cold-chain rules of ReceiveCargo apply here too:
// dissolving a cargo is not a way around a broken cold chain.
func (c *PharmaTrace) DissolveCargo(ctx contractapi.TransactionContextInterface, cargoID string) (*Cargo, error) {
	cargo, batches, err := c.ownedOpenCargo(ctx, cargoID)
	if err != nil {
		return nil, err
	}
	reason, err := c.brokenColdChain(ctx, cargoID)
	if err != nil {
		return nil, err
	}
	quarantined := []string{}
	for _, batch := range batches {
		batch.Cargo = ""
		if reason != "" && batch.State != StateRecalled {
			quarantine(batch, cargoID, reason)
			quarantined = append(quarantined, batch.ID)
		}
		if err := c.saveBatch(ctx, batch, batch.Owner); err != nil {
			return nil, err
		}
	}
	cargo.State = CargoDissolved
	if err := c.saveCargo(ctx, cargo); err != nil {
		return nil, err
	}
	event := cargoEvent{CargoID: cargoID, Owner: cargo.Owner, State: cargo.State, BatchIDs: cargo.BatchIDs}
	if len(quarantined) > 0 {
		event.Quarantined, event.Reason = quarantined, reason
	}
	return cargo, emit(ctx, EventCargoDissolved, event)
}

// ReadCargo returns a cargo.
func (c *PharmaTrace) ReadCargo(ctx contractapi.TransactionContextInterface, cargoID string) (*Cargo, error) {
	var cargo Cargo
	found, err := getJSON(ctx, objCargo, []string{cargoID}, &cargo)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, notFound("cargo %s does not exist", cargoID)
	}
	return &cargo, nil
}

// ---------------------------------------------------------------- internals

// ownedOpenCargo reads an OPEN cargo of the caller and its batches.
func (c *PharmaTrace) ownedOpenCargo(ctx contractapi.TransactionContextInterface, cargoID string) (*Cargo, []*Batch, error) {
	msp, err := clientMSP(ctx)
	if err != nil {
		return nil, nil, err
	}
	cargo, err := c.ReadCargo(ctx, cargoID)
	if err != nil {
		return nil, nil, err
	}
	if cargo.Owner != msp {
		return nil, nil, forbidden("cargo %s belongs to %s, not to %s", cargoID, cargo.Owner, msp)
	}
	if cargo.State != CargoOpen {
		return nil, nil, conflict("cargo %s is %s", cargoID, cargo.State)
	}
	batches := make([]*Batch, 0, len(cargo.BatchIDs))
	for _, id := range cargo.BatchIDs {
		batch, err := c.ReadBatch(ctx, id)
		if err != nil {
			return nil, nil, err
		}
		batches = append(batches, batch)
	}
	return cargo, batches, nil
}

// brokenColdChain says why the batches of a cargo have to be quarantined when they leave it, or
// "" if they do not. A cargo nobody monitored has no verdict and quarantines nothing. A monitored
// one needs its verdict to be final: while the monitoring is open a window can still arrive.
func (c *PharmaTrace) brokenColdChain(ctx contractapi.TransactionContextInterface, cargoID string) (string, error) {
	var m Monitoring
	found, err := getJSON(ctx, objMonitoring, []string{cargoID}, &m)
	if err != nil || !found {
		return "", err
	}
	if !m.Closed {
		return "", conflict("cargo %s is still being monitored: close its monitoring first, so its verdict is final", cargoID)
	}
	if m.Verdict != VerdictCompromised {
		return "", nil
	}
	if m.Reason == "" {
		return "cold chain compromised", nil
	}
	return m.Reason, nil
}

func (c *PharmaTrace) saveCargo(ctx contractapi.TransactionContextInterface, cargo *Cargo) error {
	now, err := txTimeString(ctx)
	if err != nil {
		return err
	}
	cargo.UpdatedAt = now
	return putJSON(ctx, objCargo, []string{cargo.ID}, cargo)
}
