package contract

import (
	"strings"
	"testing"
)

func (h *harness) createCargo(msp, id string, batches ...string) {
	h.t.Helper()
	h.must(msp, "user1", func(ctx ctxT) error { _, err := h.cc.CreateCargo(ctx, id, batches); return err })
}

func (h *harness) cargo(id string) *Cargo {
	h.t.Helper()
	var c *Cargo
	h.must(reg, "auditor", func(ctx ctxT) error {
		var err error
		c, err = h.cc.ReadCargo(ctx, id)
		return err
	})
	return c
}

func TestCargoTrip(t *testing.T) {
	h := setup(t)
	h.register("B1")
	h.register("B2")
	h.createCargo(lab, "C1", "B1", "B2")
	if b := h.batch("B1"); b.Cargo != "C1" || b.State != StateRegistered {
		t.Fatalf("batch in an open cargo: %+v", b)
	}

	// A batch in a cargo only moves with it.
	h.fails("travels in cargo C1", lab, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchBatch(ctx, "B1", dist); return err })

	stub := h.must(lab, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchCargo(ctx, "C1", dist); return err })
	for _, id := range []string{"B1", "B2"} {
		if b := h.batch(id); b.State != StateInTransit || b.PendingTo != dist {
			t.Fatalf("%s after dispatching the cargo: %+v", id, b)
		}
		if got := endorsers(t, stub, h, id); strings.Join(got, ",") != "DistMSP,RegMSP" {
			t.Fatalf("%s endorsers after dispatch = %v", id, got)
		}
	}
	h.fails("receive the cargo", dist, "user1", func(ctx ctxT) error { _, err := h.cc.ReceiveBatch(ctx, "B1"); return err })
	h.fails("not in transit to FarmaMSP", farma, "user1", func(ctx ctxT) error { _, err := h.cc.ReceiveCargo(ctx, "C1"); return err })

	h.must(dist, "user1", func(ctx ctxT) error { _, err := h.cc.ReceiveCargo(ctx, "C1"); return err })
	if c := h.cargo("C1"); c.State != CargoDelivered || c.Owner != dist || c.PendingTo != "" {
		t.Fatalf("cargo after receive: %+v", c)
	}
	for _, id := range []string{"B1", "B2"} {
		if b := h.batch(id); b.State != StateInDistribution || b.Owner != dist || b.Cargo != "" {
			t.Fatalf("%s after receiving the cargo: %+v", id, b)
		}
	}
	// Free again: the distributor can send one of them on its own.
	h.moveTo("B1", dist, farma)
	h.fails("is DELIVERED", dist, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchCargo(ctx, "C1", farma); return err })
}

func TestCargoRules(t *testing.T) {
	h := setup(t)
	h.register("B1")
	h.register("B2")
	create := func(msp, id string, batches ...string) func(ctx ctxT) error {
		return func(ctx ctxT) error { _, err := h.cc.CreateCargo(ctx, id, batches); return err }
	}
	h.fails("between 1 and 100", lab, "user1", create(lab, "C1"))
	h.fails("repeated", lab, "user1", create(lab, "C1", "B1", "B1"))
	h.fails("belongs to LabMSP", dist, "user1", create(dist, "C1", "B1"))
	h.fails("NOT_FOUND", lab, "user1", create(lab, "C1", "B1", "nope"))
	h.createCargo(lab, "C1", "B1")
	h.fails("already exists", lab, "user1", create(lab, "C1", "B2"))
	h.fails("already in cargo C1", lab, "user1", create(lab, "C2", "B1"))
	h.fails("FORBIDDEN", dist, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchCargo(ctx, "C1", dist); return err })
	h.fails("can only dispatch to a distributor", lab, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchCargo(ctx, "C1", farma); return err })
}

func TestRecalledBatchInCargo(t *testing.T) {
	h := setup(t)
	h.register("B1")
	h.register("B2")
	h.createCargo(lab, "C1", "B1", "B2")
	h.must(reg, "inspector", func(ctx ctxT) error { _, err := h.cc.RecallBatch(ctx, "B2", "desvío"); return err })

	// An open cargo with a recalled batch cannot leave; dissolving it frees the good batch.
	h.fails("was recalled", lab, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchCargo(ctx, "C1", dist); return err })
	h.must(lab, "user1", func(ctx ctxT) error { _, err := h.cc.DissolveCargo(ctx, "C1"); return err })
	if b := h.batch("B1"); b.Cargo != "" {
		t.Fatalf("B1 still locked: %+v", b)
	}
	h.createCargo(lab, "C2", "B1")

	// Recalled on the way: it still arrives, and the recipient takes custody.
	h.register("B3")
	h.createCargo(lab, "C3", "B3")
	h.must(lab, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchCargo(ctx, "C3", dist); return err })
	h.must(reg, "inspector", func(ctx ctxT) error { _, err := h.cc.RecallBatch(ctx, "B3", "desvío"); return err })
	h.must(dist, "user1", func(ctx ctxT) error { _, err := h.cc.ReceiveCargo(ctx, "C3"); return err })
	if b := h.batch("B3"); b.Owner != dist || b.State != StateRecalled || b.Cargo != "" {
		t.Fatalf("B3 after receiving a cargo with it recalled: %+v", b)
	}
}
