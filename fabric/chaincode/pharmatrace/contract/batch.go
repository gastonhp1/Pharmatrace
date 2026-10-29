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
		return invalid("invalid MSP ID %q", mspID)
	}
	switch role {
	case RoleManufacturer, RoleDistributor, RolePharmacy:
	default:
		return invalid("invalid role %q: use %s, %s or %s", role, RoleManufacturer, RoleDistributor, RolePharmacy)
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
		return nil, notFound("org %s is not registered", mspID)
	}
	return &org, nil
}

// WhoAmI returns the caller's MSP ID, client ID and pharmatrace.role attribute, straight from its
// certificate. Handy to check what a newly issued certificate carries.
func (c *PharmaTrace) WhoAmI(ctx contractapi.TransactionContextInterface) (*Identity, error) {
	msp, err := clientMSP(ctx)
	if err != nil {
		return nil, err
	}
	id, err := clientID(ctx)
	if err != nil {
		return nil, err
	}
	role, err := clientRole(ctx)
	if err != nil {
		return nil, err
	}
	return &Identity{ClientID: id, MSPID: msp, Role: role}, nil
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
		return nil, forbidden("only a manufacturer can register batches, %s is %q", msp, role)
	}

	if strings.TrimSpace(batchID) == "" {
		return nil, invalid("invalid batch ID")
	}
	if !gtinPattern.MatchString(gtin) {
		return nil, invalid("invalid GTIN %q: 8 to 14 digits", gtin)
	}
	if strings.TrimSpace(product) == "" || strings.TrimSpace(lot) == "" {
		return nil, invalid("product and lot are required")
	}
	if _, err := time.Parse("2006-01-02", expiryDate); err != nil {
		return nil, invalid("invalid expiry date %q: use YYYY-MM-DD", expiryDate)
	}

	var existing Batch
	exists, err := getJSON(ctx, objBatch, []string{batchID}, &existing)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, conflict("batch %s already exists", batchID)
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
	if batch.Cargo != "" {
		return nil, conflict("batch %s travels in cargo %s: dispatch the cargo", batchID, batch.Cargo)
	}
	if err := c.checkDispatch(ctx, batch, toMSP); err != nil {
		return nil, err
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
	// A batch recalled on the way still arrives: the recipient takes custody to quarantine it.
	if batch.PendingTo != msp || (batch.State != StateInTransit && batch.State != StateRecalled) {
		return nil, conflict("batch %s is not in transit to %s", batchID, msp)
	}
	if batch.Cargo != "" {
		return nil, conflict("batch %s travels in cargo %s: receive the cargo", batchID, batch.Cargo)
	}
	if err := c.receive(ctx, batch, msp); err != nil {
		return nil, err
	}
	return batch, emit(ctx, EventBatchReceived, batchEvent{BatchID: batchID, Owner: msp, State: batch.State})
}

// DispenseBatch records that a pharmacy handed the batch to a patient. Only a hash of the patient
// reference goes to the ledger, never personal data.
func (c *PharmaTrace) DispenseBatch(ctx contractapi.TransactionContextInterface, batchID string, patientRefHash string) (*Batch, error) {
	batch, err := c.ownedBatch(ctx, batchID)
	if err != nil {
		return nil, err
	}
	if batch.State != StateInPharmacy {
		return nil, conflict("batch %s is %s, it has to be IN_PHARMACY to be dispensed", batchID, batch.State)
	}
	if batch.Cargo != "" {
		return nil, conflict("batch %s is still in cargo %s", batchID, batch.Cargo)
	}
	patientRefHash = strings.ToLower(patientRefHash)
	if !sha256Hex.MatchString(patientRefHash) {
		return nil, invalid("patientRefHash has to be a sha256 in hex (64 characters)")
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
// A recalled batch inside a cargo stays in it, so it arrives with the rest and the recipient
// takes custody of it to quarantine it.
func (c *PharmaTrace) RecallBatch(ctx contractapi.TransactionContextInterface, batchID string, reason string) (*Batch, error) {
	if err := requireRegulator(ctx); err != nil {
		return nil, err
	}
	if strings.TrimSpace(reason) == "" {
		return nil, invalid("a recall needs a reason")
	}
	batch, err := c.ReadBatch(ctx, batchID)
	if err != nil {
		return nil, err
	}
	switch batch.State {
	case StateRecalled:
		return nil, conflict("batch %s is already recalled", batchID)
	case StateDispensed:
		return nil, conflict("batch %s was already dispensed", batchID)
	}

	batch.StateBefore = batch.State
	batch.State = StateRecalled
	batch.RecallReason = reason
	if err := c.saveBatch(ctx, batch, holderOf(batch)); err != nil {
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
		return nil, notFound("batch %s does not exist", batchID)
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
		return nil, notFound("batch %s does not exist", batchID)
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

// holderOf is the org that physically has the batch: the recipient while it is in transit.
func holderOf(batch *Batch) string {
	if batch.PendingTo != "" {
		return batch.PendingTo
	}
	return batch.Owner
}

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
		return nil, forbidden("batch %s belongs to %s, not to %s", batchID, batch.Owner, msp)
	}
	if batch.State == StateRecalled || batch.State == StateDispensed {
		return nil, conflict("batch %s is %s and cannot change anymore", batchID, batch.State)
	}
	return batch, nil
}

// checkDispatch validates that an owned batch can go to toMSP: it is not already moving, it is
// not at the end of the chain, and toMSP has the next role.
func (c *PharmaTrace) checkDispatch(ctx contractapi.TransactionContextInterface, batch *Batch, toMSP string) error {
	if batch.State == StateInTransit {
		return conflict("batch %s is already in transit to %s", batch.ID, batch.PendingTo)
	}
	if batch.State == StateInPharmacy {
		return conflict("batch %s is in a pharmacy: it can only be dispensed", batch.ID)
	}
	fromRole, err := orgRole(ctx, batch.Owner)
	if err != nil {
		return err
	}
	toRole, err := orgRole(ctx, toMSP)
	if err != nil {
		return err
	}
	if toRole == "" {
		return notFound("org %s is not registered", toMSP)
	}
	if nextRole[fromRole] != toRole {
		return conflict("a %s can only dispatch to a %s, %s is a %s", fromRole, nextRole[fromRole], toMSP, toRole)
	}
	return nil
}

// receive hands a batch in transit to its recipient. A recalled batch changes hands but keeps
// its state.
func (c *PharmaTrace) receive(ctx contractapi.TransactionContextInterface, batch *Batch, msp string) error {
	if batch.State != StateRecalled {
		role, err := orgRole(ctx, msp)
		if err != nil {
			return err
		}
		state, ok := stateHeldBy[role]
		if !ok {
			return conflict("a %q cannot hold batches", role)
		}
		batch.State = state
	}
	if err := c.moveOwnerIndex(ctx, batch.ID, batch.Owner, msp); err != nil {
		return err
	}
	batch.Owner = msp
	batch.PendingTo = ""
	return c.saveBatch(ctx, batch, msp)
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
