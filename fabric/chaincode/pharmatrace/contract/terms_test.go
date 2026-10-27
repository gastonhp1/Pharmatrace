package contract

import (
	"encoding/json"
	"testing"
)

func termsJSON(t *testing.T, terms CommercialTerms) map[string][]byte {
	t.Helper()
	data, err := json.Marshal(terms)
	if err != nil {
		t.Fatal(err)
	}
	return map[string][]byte{TransientTermsKey: data}
}

func TestCommercialTerms(t *testing.T) {
	h := setup(t)
	h.register("B1")
	terms := CommercialTerms{BatchID: "B1", Seller: lab, Buyer: dist, UnitPrice: "15230.50", Currency: "ARS", Quantity: 1200}

	set := func(ctx ctxT) error { return h.cc.SetCommercialTerms(ctx, "B1") }

	h.fails("transient map", lab, "user1", set)
	h.fails("belongs to LabMSP", dist, "user1", set, termsJSON(t, terms))
	wrongBuyer := terms
	wrongBuyer.Buyer = farma
	h.fails("sells to a distributor", lab, "user1", set, termsJSON(t, wrongBuyer))
	badPrice := terms
	badPrice.UnitPrice = "-3"
	h.fails("unitPrice", lab, "user1", set, termsJSON(t, badPrice))
	h.fails("unknown field", lab, "user1", set, map[string][]byte{TransientTermsKey: []byte(`{"batchId":"B1","extra":1}`)})

	stub := h.must(lab, "user1", set, termsJSON(t, terms))
	if len(stub.writes) != 0 {
		t.Fatalf("terms must not touch the public state, wrote %d keys", len(stub.writes))
	}
	if stub.privW[CollectionManufacturerDistributor]["B1"] == nil {
		t.Fatal("terms not written to the manufacturer-distributor collection")
	}

	read := func(msp string) (*CommercialTerms, error) {
		var got *CommercialTerms
		_, err := h.as(msp, "user1", func(ctx ctxT) error {
			var err error
			got, err = h.cc.ReadCommercialTerms(ctx, "B1", RoleManufacturer)
			return err
		})
		return got, err
	}
	if got, err := read(dist); err != nil || *got != terms {
		t.Fatalf("buyer read: %+v, %v", got, err)
	}
	if _, err := read(farma); err == nil {
		t.Fatal("the pharmacy read terms it is not part of")
	}

	verify := func(candidate map[string][]byte) bool {
		var ok bool
		h.must(reg, "auditor", func(ctx ctxT) error {
			var err error
			ok, err = h.cc.VerifyCommercialTerms(ctx, "B1", RoleManufacturer)
			return err
		}, candidate)
		return ok
	}
	// Same terms with different JSON formatting still match: the chaincode normalizes them.
	reformatted := map[string][]byte{TransientTermsKey: []byte(`{ "quantity": 1200, "currency": "ARS", "unitPrice": "15230.50",
		"buyer": "DistMSP", "seller": "LabMSP", "batchId": "B1" }`)}
	if !verify(reformatted) {
		t.Fatal("the regulator could not verify the real terms")
	}
	tampered := terms
	tampered.UnitPrice = "9999.00"
	if verify(termsJSON(t, tampered)) {
		t.Fatal("tampered terms verified")
	}
}
