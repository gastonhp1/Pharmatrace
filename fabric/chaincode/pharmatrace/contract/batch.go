package contract

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// PharmaTrace is the chaincode. Every exported method is a transaction (or a query) that clients
// can call by name; the contract API turns the arguments and return values to and from JSON.
type PharmaTrace struct {
	contractapi.Contract
}

// ================================================================= organizations

// RegisterOrg gives an organization its role in the chain. Only the regulator can do it.
func (c *PharmaTrace) RegisterOrg(ctx contractapi.TransactionContextInterface, mspID string, role string) error {
	if err := requireRegulator(ctx); err != nil {
		return err
	}
	if strings.TrimSpace(mspID) == "" || mspID == RegulatorMSP {
		return fmt.Errorf("invalid MSP ID %q", mspID)
	}
	switch role {
	case RoleManufacturer, RoleDistributor, RolePharmacy:
	default:
		return fmt.Errorf("invalid role %q: use %s, %s or %s", role, RoleManufacturer, RoleDistributor, RolePharmacy)
	}
	now, err := txTimeString(ctx)
	if err != nil {
		return err
	}
	return putJSON(ctx, objOrg, []string{mspID}, Org{MSPID: mspID, Role: role, RegisteredAt: now})
}

// GetOrg returns an organization from the registry.
func (c *PharmaTrace) GetOrg(ctx contractapi.TransactionContextInterface, mspID string) (*Org, error) {
	var org Org
	found, err := getJSON(ctx, objOrg, []string{mspID}, &org)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("org %s is not registered", mspID)
	}
	return &org, nil
}

// WhoAmI returns the caller's MSP ID and client ID. The client ID is what RegisterAttestor needs
// to authorize an IoT gateway.
func (c *PharmaTrace) WhoAmI(ctx contractapi.TransactionContextInterface) (*Attestor, error) {
	msp, err := clientMSP(ctx)
	if err != nil {
		return nil, err
	}
	id, err := clientID(ctx)
	if err != nil {
		return nil, err
	}
	return &Attestor{ClientID: id, MSPID: msp}, nil
}

// ================================================================= batches

var (
	gtinPattern = regexp.MustCompile(`^\d{8,14}$`)
	sha256Hex   = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// RegisterBatch creates a batch. The caller has to be a manufacturer, which becomes its owner.
func (c *PharmaTrace) RegisterBatch(
	ctx contractapi.TransactionContextInterface,
	batchID string, gtin string, product string, lot string, expiryDate string,
) (*Batch, error) {
	msp, err := clientMSP(ctx)
	if err != nil {
		return nil, err
	}
	role, err := orgRole(ctx, msp)
	if err != nil {
		return nil, err
	}
	if role != RoleManufacturer {
		return nil, fmt.Errorf("only a manufacturer can register batches, %s is %q", msp, role)
	}

	if strings.TrimSpace(batchID) == "" || strings.ContainsRune(batchID, 0) {
		return nil, fmt.Errorf("invalid batch ID")
	}
	if !gtinPattern.MatchString(gtin) {
		return nil, fmt.Errorf("invalid GTIN %q: 8 to 14 digits", gtin)
	}
	if strings.TrimSpace(product) == "" || strings.TrimSpace(lot) == "" {
		return nil, fmt.Errorf("product and lot are required")
	}
	if _, err := time.Parse("2006-01-02", expiryDate); err != nil {
		return nil, fmt.Errorf("invalid expiry date %q: use YYYY-MM-DD", expiryDate)
	}

	var existing Batch
	exists, err := getJSON(ctx, objBatch, []string{batchID}, &existing)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, fmt.Errorf("batch %s already exists", batchID)
	}

	batch := &Batch{
		ID:           batchID,
		GTIN:         gtin,
		Product:      product,
		Lot:          lot,
		ExpiryDate:   expiryDate,
		Manufacturer: msp,
		Owner:        msp,
		State:        StateRegistered,
	}
	if err := c.saveBatch(ctx, batch, ""); err != nil {
		return nil, err
	}
	return batch, emit(ctx, EventBatchRegistered, batchEvent{BatchID: batchID, Owner: msp, State: batch.State})
}

// DispatchBatch sends a batch to the next org in the chain (manufacturer -> distributor ->
// pharmacy). The batch stays IN_TRANSIT until the recipient calls ReceiveBatch, and from this
// moment it is the recipient (plus the regulator) who has to endorse changes to it.
func (c *PharmaTrace) DispatchBatch(ctx contractapi.TransactionContextInterface, batchID string, toMSP string) (*Batch, error) {
	batch, err := c.ownedBatch(ctx, batchID)
	if err != nil {
		return nil, err
	}
	if batch.State == StateInTransit {
		return nil, fmt.Errorf("batch %s is already in transit to %s", batchID, batch.PendingTo)
	}
	if batch.State == StateInPharmacy {
		return nil, fmt.Errorf("batch %s is in a pharmacy: it can only be dispensed", batchID)
	}

	fromRole, err := orgRole(ctx, batch.Owner)
	if err != nil {
		return nil, err
	}
	toRole, err := orgRole(ctx, toMSP)
	if err != nil {
		return nil, err
	}
	if toRole == "" {
		return nil, fmt.Errorf("org %s is not registered", toMSP)
	}
	if nextRole[fromRole] != toRole {
		return nil, fmt.Errorf("a %s can only dispatch to a %s, %s is a %s", fromRole, nextRole[fromRole], toMSP, toRole)
	}

	previousOwner := batch.Owner
	batch.State = StateInTransit
	batch.PendingTo = toMSP
	// The batch is now in the hands of the carrier: the recipient endorses what comes next.
	if err := c.saveBatch(ctx, batch, toMSP); err != nil {
		return nil, err
	}
	return batch, emit(ctx, EventBatchDispatched, batchEvent{BatchID: batchID, Owner: previousOwner, State: batch.State, To: toMSP})
}

// ReceiveBatch is called by the recipient of a dispatched batch, which becomes its owner.
func (c *PharmaTrace) ReceiveBatch(ctx contractapi.TransactionContextInterface, batchID string) (*Batch, error) {
	msp, err := clientMSP(ctx)
	if err != nil {
		return nil, err
	}
	batch, err := c.ReadBatch(ctx, batchID)
	if err != nil {
		return nil, err
	}
	if batch.State != StateInTransit || batch.PendingTo != msp {
		return nil, fmt.Errorf("batch %s is not in transit to %s", batchID, msp)
	}
	role, err := orgRole(ctx, msp)
	if err != nil {
		return nil, err
	}
	state, ok := stateHeldBy[role]
	if !ok {
		return nil, fmt.Errorf("a %q cannot hold batches", role)
	}

	if err := c.moveOwnerIndex(ctx, batch.ID, batch.Owner, msp); err != nil {
		return nil, err
	}
	batch.Owner = msp
	batch.PendingTo = ""
	batch.State = state
	if err := c.saveBatch(ctx, batch, msp); err != nil {
		return nil, err
	}
	return batch, emit(ctx, EventBatchReceived, batchEvent{BatchID: batchID, Owner: msp, State: state})
}

// DispenseBatch records that a pharmacy handed the batch to a patient. Only a hash of the patient
// reference goes to the ledger, never personal data.
func (c *PharmaTrace) DispenseBatch(ctx contractapi.TransactionContextInterface, batchID string, patientRefHash string) (*Batch, error) {
	batch, err := c.ownedBatch(ctx, batchID)
	if err != nil {
		return nil, err
	}
	if batch.State != StateInPharmacy {
		return nil, fmt.Errorf("batch %s is %s, it has to be IN_PHARMACY to be dispensed", batchID, batch.State)
	}
	patientRefHash = strings.ToLower(patientRefHash)
	if !sha256Hex.MatchString(patientRefHash) {
		return nil, fmt.Errorf("patientRefHash has to be a sha256 in hex (64 characters)")
	}

	batch.State = StateDispensed
	batch.PatientRef = patientRefHash
	if err := c.saveBatch(ctx, batch, batch.Owner); err != nil {
		return nil, err
	}
	return batch, emit(ctx, EventBatchDispensed, batchEvent{BatchID: batchID, Owner: batch.Owner, State: batch.State})
}

// RecallBatch pulls a batch from the market. Only the regulator can do it, the batch cannot move
// again afterwards, and the holder's peer still has to endorse it (state-based endorsement).
func (c *PharmaTrace) RecallBatch(ctx contractapi.TransactionContextInterface, batchID string, reason string) (*Batch, error) {
	if err := requireRegulator(ctx); err != nil {
		return nil, err
	}
	if strings.TrimSpace(reason) == "" {
		return nil, fmt.Errorf("a recall needs a reason")
	}
	batch, err := c.ReadBatch(ctx, batchID)
	if err != nil {
		return nil, err
	}
	switch batch.State {
	case StateRecalled:
		return nil, fmt.Errorf("batch %s is already recalled", batchID)
	case StateDispensed:
		return nil, fmt.Errorf("batch %s was already dispensed", batchID)
	}

	holder := batch.Owner
	if batch.State == StateInTransit {
		holder = batch.PendingTo
	}
	batch.StateBefore = batch.State
	batch.State = StateRecalled
	batch.RecallReason = reason
	if err := c.saveBatch(ctx, batch, holder); err != nil {
		return nil, err
	}
	return batch, emit(ctx, EventBatchRecalled, batchEvent{BatchID: batchID, Owner: batch.Owner, State: batch.State, Reason: reason})
}

// ReadBatch returns a batch. Any member of the channel can read it.
func (c *PharmaTrace) ReadBatch(ctx contractapi.TransactionContextInterface, batchID string) (*Batch, error) {
	var batch Batch
	found, err := getJSON(ctx, objBatch, []string{batchID}, &batch)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("batch %s does not exist", batchID)
	}
	return &batch, nil
}

// GetBatchHistory returns every version of a batch, oldest first: the custody chain.
func (c *PharmaTrace) GetBatchHistory(ctx contractapi.TransactionContextInterface, batchID string) ([]*HistoryEntry, error) {
	k, err := key(ctx, objBatch, []string{batchID})
	if err != nil {
		return nil, err
	}
	iter, err := ctx.GetStub().GetHistoryForKey(k)
	if err != nil {
		return nil, fmt.Errorf("could not read the history of %s: %w", batchID, err)
	}
	defer iter.Close()

	history := []*HistoryEntry{}
	for iter.HasNext() {
		mod, err := iter.Next()
		if err != nil {
			return nil, err
		}
		entry := &HistoryEntry{TxID: mod.GetTxId(), IsDelete: mod.GetIsDelete()}
		if ts := mod.GetTimestamp(); ts != nil {
			entry.Timestamp = ts.AsTime().UTC().Format(time.RFC3339)
		}
		if !mod.GetIsDelete() {
			var b Batch
			if err := json.Unmarshal(mod.GetValue(), &b); err != nil {
				return nil, err
			}
			entry.Batch = &b
		}
		history = append(history, entry)
	}
	if len(history) == 0 {
		return nil, fmt.Errorf("batch %s does not exist", batchID)
	}
	return history, nil
}

// BatchesByOwner lists the batches an org holds, using a composite-key index (works on LevelDB,
// no CouchDB rich queries needed).
func (c *PharmaTrace) BatchesByOwner(ctx contractapi.TransactionContextInterface, mspID string) ([]*Batch, error) {
	iter, err := ctx.GetStub().GetStateByPartialCompositeKey(objOwnerIndex, []string{mspID})
	if err != nil {
		return nil, err
	}
	defer iter.Close()

	batches := []*Batch{}
	for iter.HasNext() {
		kv, err := iter.Next()
		if err != nil {
			return nil, err
		}
		_, attrs, err := ctx.GetStub().SplitCompositeKey(kv.GetKey())
		if err != nil || len(attrs) != 2 {
			return nil, fmt.Errorf("corrupt owner index key %q", kv.GetKey())
		}
		batch, err := c.ReadBatch(ctx, attrs[1])
		if err != nil {
			return nil, err
		}
		batches = append(batches, batch)
	}
	return batches, nil
}

// ---------------------------------------------------------------- internals (not transactions)

// ownedBatch reads a batch and checks that the caller's org owns it and it can still move.
func (c *PharmaTrace) ownedBatch(ctx contractapi.TransactionContextInterface, batchID string) (*Batch, error) {
	msp, err := clientMSP(ctx)
	if err != nil {
		return nil, err
	}
	batch, err := c.ReadBatch(ctx, batchID)
	if err != nil {
		return nil, err
	}
	if batch.Owner != msp {
		return nil, fmt.Errorf("batch %s belongs to %s, not to %s", batchID, batch.Owner, msp)
	}
	if batch.State == StateRecalled || batch.State == StateDispensed {
		return nil, fmt.Errorf("batch %s is %s and cannot change anymore", batchID, batch.State)
	}
	return batch, nil
}

// saveBatch writes the batch, stamps it with the transaction and sets who must endorse the next
// change. On creation (endorser == "") it also writes the owner index.
func (c *PharmaTrace) saveBatch(ctx contractapi.TransactionContextInterface, batch *Batch, endorser string) error {
	now, err := txTimeString(ctx)
	if err != nil {
		return err
	}
	batch.LastUpdatedAt = now
	batch.LastTxID = ctx.GetStub().GetTxID()

	if err := putJSON(ctx, objBatch, []string{batch.ID}, batch); err != nil {
		return err
	}
	if endorser == "" {
		endorser = batch.Owner
		if err := c.moveOwnerIndex(ctx, batch.ID, "", batch.Owner); err != nil {
			return err
		}
	}
	k, err := key(ctx, objBatch, []string{batch.ID})
	if err != nil {
		return err
	}
	return setBatchEndorsement(ctx, k, endorser)
}

func (c *PharmaTrace) moveOwnerIndex(ctx contractapi.TransactionContextInterface, batchID, from, to string) error {
	if from != "" {
		k, err := key(ctx, objOwnerIndex, []string{from, batchID})
		if err != nil {
			return err
		}
		if err := ctx.GetStub().DelState(k); err != nil {
			return err
		}
	}
	k, err := key(ctx, objOwnerIndex, []string{to, batchID})
	if err != nil {
		return err
	}
	// The index only needs the key; Fabric does not allow an empty value, so store a marker.
	return ctx.GetStub().PutState(k, []byte{0})
}
