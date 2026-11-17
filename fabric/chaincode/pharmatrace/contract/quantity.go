package contract

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// ================================================================= units: splits and dispensations
//
// A manufacturer registers a batch with its units (10,000 vials of lot L1). A distributor that
// receives it sends 2,000 to each pharmacy: it splits the batch (SplitBatch) and dispatches each
// part on its own. A pharmacy dispenses a few units at a time (DispenseUnits). Every part keeps
// the lot, the GTIN and the expiry date of the original, and points to the batch it came from,
// so the lot can be followed (and recalled) as a whole.

// SplitBatch takes units out of a batch into a new one, with the same product, lot, expiry date,
// owner and state, and ParentID pointing to the original. Only the owner can split, and only a
// batch it has in hand: not in transit, not in a cargo, not quarantined or recalled.
func (c *PharmaTrace) SplitBatch(ctx contractapi.TransactionContextInterface, batchID string, newBatchID string, quantity int) (*Batch, error) {
	batch, err := c.ownedBatch(ctx, batchID)
	if err != nil {
		return nil, err
	}
	if batch.Cargo != "" {
		return nil, conflict("batch %s travels in cargo %s: it can be split once the cargo is received or dissolved", batchID, batch.Cargo)
	}
	if batch.State == StateInTransit {
		return nil, conflict("batch %s is in transit to %s: it can be split once received", batchID, batch.PendingTo)
	}
	if batch.Quantity == 0 {
		return nil, conflict("batch %s has no quantity recorded: it can only move whole", batchID)
	}
	if batch.Quantity < 2 {
		return nil, conflict("batch %s has 1 unit left: there is nothing to split", batchID)
	}
	if quantity < 1 || quantity >= batch.Quantity {
		return nil, invalid("a split takes between 1 and %d units (batch %s has %d)", batch.Quantity-1, batchID, batch.Quantity)
	}
	if strings.TrimSpace(newBatchID) == "" || newBatchID == batchID {
		return nil, invalid("invalid batch ID")
	}
	var existing Batch
	exists, err := getJSON(ctx, objBatch, []string{newBatchID}, &existing)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, conflict("batch %s already exists", newBatchID)
	}

	part := Batch{
		ID: newBatchID, GTIN: batch.GTIN, Product: batch.Product, Lot: batch.Lot, ExpiryDate: batch.ExpiryDate,
		Manufacturer: batch.Manufacturer, Owner: batch.Owner, State: batch.State,
		Quantity: quantity, ParentID: batchID,
	}
	batch.Quantity -= quantity
	if err := c.saveBatch(ctx, batch, batch.Owner); err != nil {
		return nil, err
	}
	if err := c.saveBatch(ctx, &part, ""); err != nil {
		return nil, err
	}
	if err := putMarker(ctx, objSplitIndex, []string{batchID, newBatchID}); err != nil {
		return nil, err
	}
	return &part, emit(ctx, EventBatchSplit, batchEvent{
		BatchID: batchID, Owner: batch.Owner, State: batch.State, NewBatchID: newBatchID, Quantity: quantity,
	})
}

// DispenseUnits records that a pharmacy handed some units of the batch to a patient. Only a hash
// of the patient reference goes to the ledger, never personal data. When no units are left the
// batch is DISPENSED.
func (c *PharmaTrace) DispenseUnits(ctx contractapi.TransactionContextInterface, batchID string, quantity int, patientRefHash string) (*Batch, error) {
	batch, hash, err := c.dispensable(ctx, batchID, patientRefHash)
	if err != nil {
		return nil, err
	}
	if batch.Quantity == 0 {
		return nil, conflict("batch %s has no quantity recorded: dispense it whole", batchID)
	}
	if quantity < 1 || quantity > batch.Quantity {
		return nil, invalid("quantity has to be between 1 and %d (the units left in batch %s)", batch.Quantity, batchID)
	}
	return c.dispense(ctx, batch, quantity, hash)
}

// DispenseBatch dispenses every unit left in the batch (or the whole batch, if it has no
// quantity recorded).
func (c *PharmaTrace) DispenseBatch(ctx contractapi.TransactionContextInterface, batchID string, patientRefHash string) (*Batch, error) {
	batch, hash, err := c.dispensable(ctx, batchID, patientRefHash)
	if err != nil {
		return nil, err
	}
	return c.dispense(ctx, batch, batch.Quantity, hash)
}

// BatchSplits lists the batches split directly from a batch.
func (c *PharmaTrace) BatchSplits(ctx contractapi.TransactionContextInterface, batchID string) ([]*Batch, error) {
	if _, err := c.ReadBatch(ctx, batchID); err != nil {
		return nil, err
	}
	return c.children(ctx, batchID)
}

// BatchDescendants lists every batch split from a batch, and from those, down to the last one:
// what a recall of the batch would reach. Each one has its ParentID.
func (c *PharmaTrace) BatchDescendants(ctx contractapi.TransactionContextInterface, batchID string) ([]*Batch, error) {
	if _, err := c.ReadBatch(ctx, batchID); err != nil {
		return nil, err
	}
	return c.descendants(ctx, batchID, MaxRecallBatches)
}

// Dispensations lists the units of a batch handed to patients, oldest first.
func (c *PharmaTrace) Dispensations(ctx contractapi.TransactionContextInterface, batchID string) ([]*Dispensation, error) {
	if _, err := c.ReadBatch(ctx, batchID); err != nil {
		return nil, err
	}
	iter, err := ctx.GetStub().GetStateByPartialCompositeKey(objDispense, []string{batchID})
	if err != nil {
		return nil, err
	}
	defer iter.Close()
	list := []*Dispensation{}
	for iter.HasNext() {
		kv, err := iter.Next()
		if err != nil {
			return nil, err
		}
		var d Dispensation
		if err := json.Unmarshal(kv.GetValue(), &d); err != nil {
			return nil, err
		}
		list = append(list, &d)
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].At < list[j].At })
	return list, nil
}

// ---------------------------------------------------------------- internals (not transactions)

// dispensable checks that the caller's pharmacy can dispense from the batch now.
func (c *PharmaTrace) dispensable(ctx contractapi.TransactionContextInterface, batchID, patientRefHash string) (*Batch, string, error) {
	batch, err := c.ownedBatch(ctx, batchID)
	if err != nil {
		return nil, "", err
	}
	if batch.State != StateInPharmacy {
		return nil, "", conflict("batch %s is %s, it has to be IN_PHARMACY to be dispensed", batchID, batch.State)
	}
	if batch.Cargo != "" {
		return nil, "", conflict("batch %s is still in cargo %s", batchID, batch.Cargo)
	}
	hash := strings.ToLower(patientRefHash)
	if !sha256Hex.MatchString(hash) {
		return nil, "", invalid("patientRefHash has to be a sha256 in hex (64 characters)")
	}
	return batch, hash, nil
}

func (c *PharmaTrace) dispense(ctx contractapi.TransactionContextInterface, batch *Batch, quantity int, hash string) (*Batch, error) {
	batch.Quantity -= quantity
	batch.Dispensed += quantity
	batch.PatientRef = hash
	if batch.Quantity == 0 {
		batch.State = StateDispensed
	}
	if err := c.saveBatch(ctx, batch, batch.Owner); err != nil {
		return nil, err
	}
	txID := ctx.GetStub().GetTxID()
	d := Dispensation{BatchID: batch.ID, Quantity: quantity, PatientRef: hash, Pharmacy: batch.Owner, At: batch.LastUpdatedAt, TxID: txID}
	if err := putJSON(ctx, objDispense, []string{batch.ID, txID}, d); err != nil {
		return nil, err
	}
	return batch, emit(ctx, EventBatchDispensed, batchEvent{BatchID: batch.ID, Owner: batch.Owner, State: batch.State, Quantity: quantity})
}

func (c *PharmaTrace) children(ctx contractapi.TransactionContextInterface, batchID string) ([]*Batch, error) {
	iter, err := ctx.GetStub().GetStateByPartialCompositeKey(objSplitIndex, []string{batchID})
	if err != nil {
		return nil, err
	}
	defer iter.Close()
	list := []*Batch{}
	for iter.HasNext() {
		kv, err := iter.Next()
		if err != nil {
			return nil, err
		}
		_, attrs, err := ctx.GetStub().SplitCompositeKey(kv.GetKey())
		if err != nil || len(attrs) != 2 {
			return nil, fmt.Errorf("corrupt split index key %q", kv.GetKey())
		}
		b, err := c.ReadBatch(ctx, attrs[1])
		if err != nil {
			return nil, err
		}
		list = append(list, b)
	}
	return list, nil
}

// descendants walks the splits of a batch breadth first, up to limit batches.
func (c *PharmaTrace) descendants(ctx contractapi.TransactionContextInterface, batchID string, limit int) ([]*Batch, error) {
	all := []*Batch{}
	queue := []string{batchID}
	for len(queue) > 0 {
		kids, err := c.children(ctx, queue[0])
		if err != nil {
			return nil, err
		}
		queue = queue[1:]
		for _, k := range kids {
			all = append(all, k)
			if len(all) >= limit {
				return nil, conflict("batch %s has %d or more batches split from it: recall them in parts, starting with the splits", batchID, limit)
			}
			queue = append(queue, k.ID)
		}
	}
	return all, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
