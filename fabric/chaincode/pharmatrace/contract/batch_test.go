package contract

import (
	"sort"
	"strings"
	"testing"

	"github.com/hyperledger/fabric-chaincode-go/v2/pkg/statebased"
	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

const (
	lab   = "LabMSP"
	dist  = "DistMSP"
	farma = "FarmaMSP"
	reg   = RegulatorMSP
)

type ctxT = contractapi.TransactionContextInterface

// setup registers the three orgs of the chain.
func setup(t *testing.T) *harness {
	h := newHarness(t)
	for msp, role := range map[string]string{lab: RoleManufacturer, dist: RoleDistributor, farma: RolePharmacy} {
		h.must(reg, "admin", func(ctx ctxT) error { return h.cc.RegisterOrg(ctx, msp, role) })
	}
	return h
}

func (h *harness) register(id string) {
	h.t.Helper()
	h.must(lab, "user1", func(ctx ctxT) error {
		_, err := h.cc.RegisterBatch(ctx, id, "07791234567890", "Insulina NPH 100 UI/ml", "L2026-10", "2028-03-31")
		return err
	})
}

func (h *harness) moveTo(id, from, to string) {
	h.t.Helper()
	h.must(from, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchBatch(ctx, id, to); return err })
	h.must(to, "user1", func(ctx ctxT) error { _, err := h.cc.ReceiveBatch(ctx, id); return err })
}

func (h *harness) batch(id string) *Batch {
	h.t.Helper()
	var b *Batch
	h.must(reg, "auditor", func(ctx ctxT) error {
		var err error
		b, err = h.cc.ReadBatch(ctx, id)
		return err
	})
	return b
}

// endorsers decodes the state-based endorsement policy a transaction set on a batch.
func endorsers(t *testing.T, stub *fakeStub, h *harness, id string) []string {
	t.Helper()
	k, _ := stub.CreateCompositeKey(objBatch, []string{id})
	policy, ok := stub.vparams[k]
	if !ok {
		policy, ok = h.l.validation[k]
	}
	if !ok {
		t.Fatalf("no endorsement policy on batch %s", id)
	}
	ep, err := statebased.NewStateEP(policy)
	if err != nil {
		t.Fatal(err)
	}
	orgs := ep.ListOrgs()
	sort.Strings(orgs)
	return orgs
}

func TestFullCustodyChain(t *testing.T) {
	h := setup(t)

	stub := h.must(lab, "user1", func(ctx ctxT) error {
		b, err := h.cc.RegisterBatch(ctx, "B1", "07791234567890", "Insulina NPH 100 UI/ml", "L2026-10", "2028-03-31")
		if err == nil && (b.Owner != lab || b.State != StateRegistered) {
			t.Errorf("new batch: owner %s state %s", b.Owner, b.State)
		}
		return err
	})
	if got := endorsers(t, stub, h, "B1"); strings.Join(got, ",") != "LabMSP,RegMSP" {
		t.Fatalf("after register, endorsers = %v", got)
	}
	if stub.events[0] != EventBatchRegistered {
		t.Errorf("event = %v", stub.events)
	}

	// Dispatch: the batch is in transit and from now on the recipient endorses it.
	stub = h.must(lab, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchBatch(ctx, "B1", dist); return err })
	if b := h.batch("B1"); b.State != StateInTransit || b.Owner != lab || b.PendingTo != dist {
		t.Fatalf("after dispatch: %+v", b)
	}
	if got := endorsers(t, stub, h, "B1"); strings.Join(got, ",") != "DistMSP,RegMSP" {
		t.Fatalf("after dispatch, endorsers = %v", got)
	}

	h.must(dist, "user1", func(ctx ctxT) error { _, err := h.cc.ReceiveBatch(ctx, "B1"); return err })
	if b := h.batch("B1"); b.State != StateInDistribution || b.Owner != dist || b.PendingTo != "" {
		t.Fatalf("after receive: %+v", b)
	}

	h.moveTo("B1", dist, farma)
	if b := h.batch("B1"); b.State != StateInPharmacy || b.Owner != farma {
		t.Fatalf("at the pharmacy: %+v", b)
	}

	ref := strings.Repeat("ab", 32)
	h.must(farma, "user1", func(ctx ctxT) error { _, err := h.cc.DispenseBatch(ctx, "B1", ref); return err })
	if b := h.batch("B1"); b.State != StateDispensed || b.PatientRef != ref {
		t.Fatalf("after dispense: %+v", b)
	}

	var history []*HistoryEntry
	h.must(reg, "auditor", func(ctx ctxT) error {
		var err error
		history, err = h.cc.GetBatchHistory(ctx, "B1")
		return err
	})
	var states []string
	for _, e := range history {
		states = append(states, e.Batch.Owner+":"+e.Batch.State)
	}
	want := "LabMSP:REGISTERED LabMSP:IN_TRANSIT DistMSP:IN_DISTRIBUTION DistMSP:IN_TRANSIT FarmaMSP:IN_PHARMACY FarmaMSP:DISPENSED"
	if strings.Join(states, " ") != want {
		t.Fatalf("history:\n got %s\nwant %s", strings.Join(states, " "), want)
	}
}

func TestOwnerIndex(t *testing.T) {
	h := setup(t)
	h.register("B1")
	h.register("B2")
	h.moveTo("B2", lab, dist)

	count := func(msp string) int {
		var n int
		h.must(reg, "auditor", func(ctx ctxT) error {
			b, err := h.cc.BatchesByOwner(ctx, msp)
			n = len(b)
			return err
		})
		return n
	}
	if count(lab) != 1 || count(dist) != 1 || count(farma) != 0 {
		t.Fatalf("lab %d dist %d farma %d", count(lab), count(dist), count(farma))
	}
}

func TestRegistryRules(t *testing.T) {
	h := setup(t)
	h.fails("only the regulator", lab, "admin", func(ctx ctxT) error { return h.cc.RegisterOrg(ctx, "OtherMSP", RolePharmacy) })
	h.fails("invalid role", reg, "admin", func(ctx ctxT) error { return h.cc.RegisterOrg(ctx, "OtherMSP", "patient") })
	h.fails("invalid MSP", reg, "admin", func(ctx ctxT) error { return h.cc.RegisterOrg(ctx, reg, RolePharmacy) })
}

func TestBatchRules(t *testing.T) {
	h := setup(t)
	registerFn := func(id, gtin, expiry string) func(ctx ctxT) error {
		return func(ctx ctxT) error {
			_, err := h.cc.RegisterBatch(ctx, id, gtin, "Producto", "L1", expiry)
			return err
		}
	}
	h.fails("only a manufacturer", dist, "user1", registerFn("B1", "07791234567890", "2028-01-01"))
	h.fails("invalid GTIN", lab, "user1", registerFn("B1", "77-9", "2028-01-01"))
	h.fails("invalid expiry", lab, "user1", registerFn("B1", "07791234567890", "31/01/2028"))
	h.register("B1")
	h.fails("already exists", lab, "user1", registerFn("B1", "07791234567890", "2028-01-01"))

	dispatch := func(to string) func(ctx ctxT) error {
		return func(ctx ctxT) error { _, err := h.cc.DispatchBatch(ctx, "B1", to); return err }
	}
	receive := func(ctx ctxT) error { _, err := h.cc.ReceiveBatch(ctx, "B1"); return err }

	h.fails("belongs to LabMSP", dist, "user1", dispatch(farma))
	h.fails("can only dispatch to a distributor", lab, "user1", dispatch(farma)) // no skipping steps
	h.fails("not registered", lab, "user1", dispatch("NopeMSP"))
	h.fails("not in transit", dist, "user1", receive)

	h.must(lab, "user1", dispatch(dist))
	h.fails("already in transit", lab, "user1", dispatch(dist))
	h.fails("not in transit to FarmaMSP", farma, "user1", receive)
	h.must(dist, "user1", receive)

	h.fails("has to be IN_PHARMACY", dist, "user1", func(ctx ctxT) error {
		_, err := h.cc.DispenseBatch(ctx, "B1", strings.Repeat("0", 64))
		return err
	})
	h.moveTo("B1", dist, farma)
	h.fails("can only be dispensed", farma, "user1", dispatch(dist))
	h.fails("sha256", farma, "user1", func(ctx ctxT) error {
		_, err := h.cc.DispenseBatch(ctx, "B1", "juan perez")
		return err
	})
}

func TestRecall(t *testing.T) {
	h := setup(t)
	h.register("B1")
	h.must(lab, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchBatch(ctx, "B1", dist); return err })

	recall := func(ctx ctxT) error { _, err := h.cc.RecallBatch(ctx, "B1", "desvío de calidad"); return err }
	h.fails("only the regulator", lab, "user1", recall)
	h.fails("needs a reason", reg, "inspector", func(ctx ctxT) error { _, err := h.cc.RecallBatch(ctx, "B1", " "); return err })

	stub := h.must(reg, "inspector", recall)
	// In transit, the one who must co-sign the recall is the recipient that physically has it.
	if got := endorsers(t, stub, h, "B1"); strings.Join(got, ",") != "DistMSP,RegMSP" {
		t.Fatalf("recall endorsers = %v", got)
	}
	b := h.batch("B1")
	if b.State != StateRecalled || b.StateBefore != StateInTransit || b.RecallReason == "" {
		t.Fatalf("after recall: %+v", b)
	}
	h.fails("already recalled", reg, "inspector", recall)
	h.fails("not in transit", dist, "user1", func(ctx ctxT) error { _, err := h.cc.ReceiveBatch(ctx, "B1"); return err })
	h.fails("cannot change anymore", lab, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchBatch(ctx, "B1", dist); return err })

	h.register("B2")
	h.moveTo("B2", lab, dist)
	h.moveTo("B2", dist, farma)
	h.must(farma, "user1", func(ctx ctxT) error {
		_, err := h.cc.DispenseBatch(ctx, "B2", strings.Repeat("1", 64))
		return err
	})
	h.fails("already dispensed", reg, "inspector", func(ctx ctxT) error {
		_, err := h.cc.RecallBatch(ctx, "B2", "x")
		return err
	})
}

func TestTransactionsDoNotSeeTheirOwnWritesButSeeCommitted(t *testing.T) {
	// A failed transaction must leave no trace (the fake applies writes only on success).
	h := setup(t)
	h.register("B1")
	h.fails("can only dispatch", lab, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchBatch(ctx, "B1", farma); return err })
	if b := h.batch("B1"); b.State != StateRegistered {
		t.Fatalf("a failed dispatch changed the batch: %+v", b)
	}
}
