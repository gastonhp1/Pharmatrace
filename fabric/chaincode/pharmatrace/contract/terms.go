package contract

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// Private data collections, defined in fabric/network/collections_config.json. Each one is shared
// only by the two orgs of one leg of the chain: the pharmacy never sees what the distributor paid
// the manufacturer, and the regulator sees neither, only the hashes that go on the ledger.
const (
	CollectionManufacturerDistributor = "termsManufacturerDistributor"
	CollectionDistributorPharmacy     = "termsDistributorPharmacy"
)

// termsCollection maps the seller's role to the collection of that leg.
var termsCollection = map[string]string{
	RoleManufacturer: CollectionManufacturerDistributor,
	RoleDistributor:  CollectionDistributorPharmacy,
}

// TransientTermsKey is the key of the transient map that carries the terms. Transient data reaches
// the endorsing peers but is not written to the transaction, so it never lands on the ledger.
const TransientTermsKey = "terms"

var pricePattern = regexp.MustCompile(`^\d+(\.\d{1,4})?$`)

// SetCommercialTerms stores the price and quantity agreed for a batch in the collection of the
// seller and the buyer. The terms go in the transient map (key "terms"), never as arguments: the
// arguments are written to the transaction and every org would see them.
//
// It returns nothing on purpose: a return value is part of the endorsement response, which is
// also written to the ledger.
func (c *PharmaTrace) SetCommercialTerms(ctx contractapi.TransactionContextInterface, batchID string) error {
	terms, raw, err := transientTerms(ctx)
	if err != nil {
		return err
	}
	if terms.BatchID != batchID {
		return fmt.Errorf("the terms are for batch %q, not %q", terms.BatchID, batchID)
	}

	batch, err := c.ownedBatch(ctx, batchID)
	if err != nil {
		return err
	}
	if terms.Seller != batch.Owner {
		return fmt.Errorf("the seller has to be the owner of the batch (%s)", batch.Owner)
	}
	sellerRole, err := orgRole(ctx, terms.Seller)
	if err != nil {
		return err
	}
	buyerRole, err := orgRole(ctx, terms.Buyer)
	if err != nil {
		return err
	}
	if buyerRole == "" || nextRole[sellerRole] != buyerRole {
		return fmt.Errorf("a %s sells to a %s, %s is %q", sellerRole, nextRole[sellerRole], terms.Buyer, buyerRole)
	}

	return ctx.GetStub().PutPrivateData(termsCollection[sellerRole], batchID, raw)
}

// ReadCommercialTerms returns the terms of a batch from the collection of the given leg
// ("manufacturer" for manufacturer -> distributor, "distributor" for distributor -> pharmacy).
// Only the seller and the buyer can read them.
func (c *PharmaTrace) ReadCommercialTerms(ctx contractapi.TransactionContextInterface, batchID string, sellerRole string) (*CommercialTerms, error) {
	collection, ok := termsCollection[sellerRole]
	if !ok {
		return nil, fmt.Errorf("invalid leg %q: use %s or %s", sellerRole, RoleManufacturer, RoleDistributor)
	}
	msp, err := clientMSP(ctx)
	if err != nil {
		return nil, err
	}
	data, err := ctx.GetStub().GetPrivateData(collection, batchID)
	if err != nil {
		return nil, fmt.Errorf("could not read %s: %w", collection, err)
	}
	if data == nil {
		return nil, fmt.Errorf("no terms for batch %s in %s", batchID, collection)
	}
	var terms CommercialTerms
	if err := json.Unmarshal(data, &terms); err != nil {
		return nil, fmt.Errorf("corrupt terms: %w", err)
	}
	if msp != terms.Seller && msp != terms.Buyer {
		return nil, fmt.Errorf("%s is not part of these terms", msp)
	}
	return &terms, nil
}

// VerifyCommercialTerms tells whether some terms (in the transient map, key "terms") are exactly
// the ones stored for a batch. Any org can call it, even one outside the collection: it only
// compares hashes. This is how an auditor checks a price someone showed them off-chain.
func (c *PharmaTrace) VerifyCommercialTerms(ctx contractapi.TransactionContextInterface, batchID string, sellerRole string) (bool, error) {
	collection, ok := termsCollection[sellerRole]
	if !ok {
		return false, fmt.Errorf("invalid leg %q: use %s or %s", sellerRole, RoleManufacturer, RoleDistributor)
	}
	_, raw, err := transientTerms(ctx)
	if err != nil {
		return false, err
	}
	stored, err := ctx.GetStub().GetPrivateDataHash(collection, batchID)
	if err != nil {
		return false, fmt.Errorf("could not read the hash from %s: %w", collection, err)
	}
	if stored == nil {
		return false, fmt.Errorf("no terms for batch %s in %s", batchID, collection)
	}
	sum := sha256.Sum256(raw)
	return bytes.Equal(sum[:], stored), nil
}

// transientTerms reads and validates the terms from the transient map. It returns them both
// decoded and re-encoded: storing the re-encoded form makes the bytes (and so the hash)
// independent of how the client formatted its JSON.
func transientTerms(ctx contractapi.TransactionContextInterface) (*CommercialTerms, []byte, error) {
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return nil, nil, fmt.Errorf("could not read the transient map: %w", err)
	}
	data, ok := transient[TransientTermsKey]
	if !ok || len(data) == 0 {
		return nil, nil, fmt.Errorf("the terms have to be sent in the transient map under %q", TransientTermsKey)
	}

	var terms CommercialTerms
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&terms); err != nil {
		return nil, nil, fmt.Errorf("invalid terms: %w", err)
	}
	switch {
	case strings.TrimSpace(terms.BatchID) == "":
		return nil, nil, fmt.Errorf("terms.batchId is required")
	case terms.Seller == "" || terms.Buyer == "":
		return nil, nil, fmt.Errorf("terms.seller and terms.buyer are required")
	case !pricePattern.MatchString(terms.UnitPrice):
		return nil, nil, fmt.Errorf("terms.unitPrice has to be a positive decimal like 1234.50")
	case len(terms.Currency) != 3 || strings.ToUpper(terms.Currency) != terms.Currency:
		return nil, nil, fmt.Errorf("terms.currency has to be an ISO 4217 code like ARS")
	case terms.Quantity <= 0:
		return nil, nil, fmt.Errorf("terms.quantity has to be positive")
	}

	raw, err := json.Marshal(terms)
	if err != nil {
		return nil, nil, err
	}
	return &terms, raw, nil
}
