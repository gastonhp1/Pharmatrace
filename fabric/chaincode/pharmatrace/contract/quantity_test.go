package contract

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

const patientA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func (h *harness) split(msp, id, newID string, quantity int) *fakeStub {
	h.t.Helper()
	return h.must(msp, "user1", func(ctx ctxT) error { _, err := h.cc.SplitBatch(ctx, id, newID, quantity); return err })
}

func ids(batches []*Batch) string {
	out := []string{}
	for _, b := range batches {
		out = append(out, b.ID)
	}
	return strings.Join(out, ",")
}

func TestRegisterNeedsAQuantity(t *testing.T) {
	h := setup(t)
	for _, q := range []int{0, -5, MaxBatchQuantity + 1} {
		h.fails("quantity has to be between 1", lab, "user1", func(ctx ctxT) error {
			_, err := h.cc.RegisterBatch(ctx, "B9", "07791234567890", "Insulina", "L1", "2028-03-31", q)
			return err
		})
	}
	h.register("B1")
	if b := h.batch("B1"); b.Quantity != 1000 || b.Dispensed != 0 || b.ParentID != "" {
		t.Fatalf("registered batch: %+v", b)
	}
}

func TestSplitBatch(t *testing.T) {
	h := setup(t)
	h.register("B1")
	h.moveTo("B1", lab, dist)

	stub := h.split(dist, "B1", "B1-F1", 300)
	if stub.events[0] != EventBatchSplit {
		t.Fatalf("events %v", stub.events)
	}
	var event batchEvent
	if err := json.Unmarshal(stub.eventData[0], &event); err != nil {
		t.Fatal(err)
	}
	if event.BatchID != "B1" || event.NewBatchID != "B1-F1" || event.Quantity != 300 || event.Owner != dist {
		t.Fatalf("split event: %+v", event)
	}
	parent, part := h.batch("B1"), h.batch("B1-F1")
	if parent.Quantity != 700 {
		t.Fatalf("parent after the split: %+v", parent)
	}
	if part.Quantity != 300 || part.ParentID != "B1" || part.Owner != dist || part.State != StateInDistribution ||
		part.Lot != parent.Lot || part.GTIN != parent.GTIN || part.ExpiryDate != parent.ExpiryDate || part.Manufacturer != lab {
		t.Fatalf("split part: %+v", part)
	}
	// The part has its own endorsement policy (holder + regulator) and shows up with its owner.
	if got := endorsers(t, stub, h, "B1-F1"); strings.Join(got, ",") != "DistMSP,RegMSP" {
		t.Fatalf("endorsers of the part = %v", got)
	}
	h.must(reg, "auditor", func(ctx ctxT) error {
		owned, err := h.cc.BatchesByOwner(ctx, dist)
		if err != nil {
			return err
		}
		if ids(owned) != "B1,B1-F1" {
			return fmt.Errorf("dist holds %s", ids(owned))
		}
		splits, err := h.cc.BatchSplits(ctx, "B1")
		if err != nil || ids(splits) != "B1-F1" {
			return fmt.Errorf("splits of B1: %v %v", ids(splits), err)
		}
		return nil
	})

	// The part travels on its own; the rest stays.
	h.moveTo("B1-F1", dist, farma)
	if b := h.batch("B1-F1"); b.Owner != farma || b.State != StateInPharmacy {
		t.Fatalf("part at the pharmacy: %+v", b)
	}
	if b := h.batch("B1"); b.Owner != dist || b.Quantity != 700 {
		t.Fatalf("parent after the part left: %+v", b)
	}
}

func TestSplitRules(t *testing.T) {
	h := setup(t)
	h.register("B1")
	split := func(msp, id, newID string, q int) func(ctx ctxT) error {
		return func(ctx ctxT) error { _, err := h.cc.SplitBatch(ctx, id, newID, q); return err }
	}
	h.fails("belongs to LabMSP", dist, "user1", split(dist, "B1", "X", 10))
	h.fails("between 1 and 999", lab, "user1", split(lab, "B1", "X", 0))
	h.fails("between 1 and 999", lab, "user1", split(lab, "B1", "X", 1000))
	h.fails("invalid batch ID", lab, "user1", split(lab, "B1", " ", 10))
	h.fails("invalid batch ID", lab, "user1", split(lab, "B1", "B1", 10))
	h.register("B2")
	h.fails("B2 already exists", lab, "user1", split(lab, "B1", "B2", 10))

	h.must(lab, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchBatch(ctx, "B1", dist); return err })
	h.fails("in transit to DistMSP", lab, "user1", split(lab, "B1", "X", 10))

	h.createCargo(lab, "C1", "B2")
	h.fails("travels in cargo C1", lab, "user1", split(lab, "B2", "X", 10))

	// Down to one unit, nothing left to split.
	h.register("B3")
	h.split(lab, "B3", "B3-a", 999)
	h.fails("1 unit left", lab, "user1", split(lab, "B3", "X", 1))

	h.must(reg, "inspector", func(ctx ctxT) error { _, err := h.cc.RecallBatch(ctx, "B3", "x"); return err })
	h.fails("RECALLED and cannot change", lab, "user1", split(lab, "B3-a", "X", 1))
}

func TestDispenseUnits(t *testing.T) {
	h := setup(t)
	h.register("B1")
	h.moveTo("B1", lab, dist)
	h.split(dist, "B1", "B1-F1", 30)
	h.moveTo("B1-F1", dist, farma)

	dispense := func(q int, ref string) func(ctx ctxT) error {
		return func(ctx ctxT) error { _, err := h.cc.DispenseUnits(ctx, "B1-F1", q, ref); return err }
	}
	h.fails("between 1 and 30", farma, "user1", dispense(0, patientA))
	h.fails("between 1 and 30", farma, "user1", dispense(31, patientA))
	h.fails("sha256", farma, "user1", dispense(2, "juan"))
	h.fails("belongs to FarmaMSP", dist, "user1", dispense(2, patientA))
	h.fails("IN_PHARMACY", dist, "user1", func(ctx ctxT) error { _, err := h.cc.DispenseUnits(ctx, "B1", 2, patientA); return err })

	stub := h.must(farma, "user1", dispense(2, patientA))
	var event batchEvent
	if err := json.Unmarshal(stub.eventData[0], &event); err != nil || event.Quantity != 2 {
		t.Fatalf("dispensed event: %s %v", stub.eventData[0], err)
	}
	if b := h.batch("B1-F1"); b.Quantity != 28 || b.Dispensed != 2 || b.State != StateInPharmacy || b.PatientRef != patientA {
		t.Fatalf("after dispensing 2: %+v", b)
	}
	// The rest, in one go.
	h.must(farma, "user1", func(ctx ctxT) error {
		_, err := h.cc.DispenseBatch(ctx, "B1-F1", strings.Repeat("b", 64))
		return err
	})
	if b := h.batch("B1-F1"); b.Quantity != 0 || b.Dispensed != 30 || b.State != StateDispensed {
		t.Fatalf("after dispensing the rest: %+v", b)
	}
	h.fails("DISPENSED and cannot change", farma, "user1", dispense(1, patientA))

	h.must(reg, "auditor", func(ctx ctxT) error {
		list, err := h.cc.Dispensations(ctx, "B1-F1")
		if err != nil {
			return err
		}
		if len(list) != 2 || list[0].Quantity+list[1].Quantity != 30 || list[0].Pharmacy != farma {
			return fmt.Errorf("dispensations: %+v %+v", list[0], list[1])
		}
		return nil
	})
}

func TestBatchWithoutQuantity(t *testing.T) {
	// Batches registered before quantities existed: they move and are dispensed whole.
	h := setup(t)
	h.must(lab, "user1", func(ctx ctxT) error {
		if err := putJSON(ctx, objBatch, []string{"OLD"}, Batch{ID: "OLD", GTIN: "07791234567890", Product: "X", Lot: "L", ExpiryDate: "2028-01-31", Manufacturer: lab, Owner: lab, State: StateRegistered}); err != nil {
			return err
		}
		return h.cc.moveOwnerIndex(ctx, "OLD", "", lab)
	})
	h.fails("no quantity recorded: it can only move whole", lab, "user1", func(ctx ctxT) error { _, err := h.cc.SplitBatch(ctx, "OLD", "X", 1); return err })
	h.moveTo("OLD", lab, dist)
	h.moveTo("OLD", dist, farma)
	h.fails("no quantity recorded: dispense it whole", farma, "user1", func(ctx ctxT) error { _, err := h.cc.DispenseUnits(ctx, "OLD", 1, patientA); return err })
	h.must(farma, "user1", func(ctx ctxT) error { _, err := h.cc.DispenseBatch(ctx, "OLD", patientA); return err })
	if b := h.batch("OLD"); b.State != StateDispensed || b.Quantity != 0 || b.Dispensed != 0 {
		t.Fatalf("legacy batch dispensed: %+v", b)
	}
}

func TestRecallReachesTheSplits(t *testing.T) {
	h := setup(t)
	h.register("B1")
	h.moveTo("B1", lab, dist)
	h.split(dist, "B1", "B1-F1", 300)
	h.split(dist, "B1", "B1-F2", 100)
	h.moveTo("B1-F1", dist, farma)
	h.split(farma, "B1-F1", "B1-F1-a", 10)
	// B1-F2 is on its way to the pharmacy; B1-F1-a was fully dispensed.
	h.must(dist, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchBatch(ctx, "B1-F2", farma); return err })
	h.must(farma, "user1", func(ctx ctxT) error { _, err := h.cc.DispenseBatch(ctx, "B1-F1-a", patientA); return err })
	h.must(farma, "user1", func(ctx ctxT) error { _, err := h.cc.DispenseUnits(ctx, "B1-F1", 5, patientA); return err })

	h.must(reg, "auditor", func(ctx ctxT) error {
		all, err := h.cc.BatchDescendants(ctx, "B1")
		if err != nil || ids(all) != "B1-F1,B1-F2,B1-F1-a" {
			return fmt.Errorf("descendants of B1: %s %v", ids(all), err)
		}
		return nil
	})

	// Recalling a part reaches only that part and what was split from it.
	h.must(reg, "inspector", func(ctx ctxT) error { _, err := h.cc.RecallBatch(ctx, "B1-F2", "golpe en el transporte"); return err })
	if b := h.batch("B1"); b.State != StateInDistribution {
		t.Fatalf("parent after recalling a part: %+v", b)
	}

	// Recalling the batch the manufacturer registered recalls the whole lot.
	stub := h.must(reg, "inspector", func(ctx ctxT) error { _, err := h.cc.RecallBatch(ctx, "B1", "desvío de calidad del lote"); return err })
	var event batchEvent
	if err := json.Unmarshal(stub.eventData[0], &event); err != nil {
		t.Fatal(err)
	}
	if strings.Join(event.Recalled, ",") != "B1,B1-F1" || strings.Join(event.Holders, ",") != "DistMSP,FarmaMSP" {
		t.Fatalf("recall event: %+v", event)
	}
	if b := h.batch("B1-F1"); b.State != StateRecalled || b.StateBefore != StateInPharmacy || b.Quantity != 285 || b.Dispensed != 5 || b.RecallReason != "desvío de calidad del lote" {
		t.Fatalf("recalled part: %+v", b)
	}
	if got := endorsers(t, stub, h, "B1-F1"); strings.Join(got, ",") != "FarmaMSP,RegMSP" {
		t.Fatalf("endorsers of a recalled part = %v", got)
	}
	if b := h.batch("B1-F1-a"); b.State != StateDispensed {
		t.Fatalf("a dispensed part is not recalled: %+v", b)
	}
	if b := h.batch("B1-F2"); b.RecallReason != "golpe en el transporte" {
		t.Fatalf("an already recalled part keeps its reason: %+v", b)
	}
	h.fails("already recalled", reg, "inspector", func(ctx ctxT) error { _, err := h.cc.RecallBatch(ctx, "B1", "otra vez"); return err })
}

func TestRecallWithNothingLeft(t *testing.T) {
	h := setup(t)
	h.register("B1")
	h.moveTo("B1", lab, dist)
	h.moveTo("B1", dist, farma)
	h.split(farma, "B1", "B1-a", 10)
	h.must(farma, "user1", func(ctx ctxT) error { _, err := h.cc.DispenseBatch(ctx, "B1", patientA); return err })
	h.must(farma, "user1", func(ctx ctxT) error { _, err := h.cc.DispenseBatch(ctx, "B1-a", patientA); return err })
	h.fails("already dispensed or recalled", reg, "inspector", func(ctx ctxT) error { _, err := h.cc.RecallBatch(ctx, "B1", "x"); return err })
	h.fails("B1-a was already dispensed", reg, "inspector", func(ctx ctxT) error { _, err := h.cc.RecallBatch(ctx, "B1-a", "x"); return err })
}

func TestRecallIsBounded(t *testing.T) {
	h := setup(t)
	h.register("B1")
	for i := 0; i < MaxRecallBatches; i++ {
		h.split(lab, "B1", fmt.Sprintf("B1-%03d", i), 1)
	}
	h.fails("recall them in parts", reg, "inspector", func(ctx ctxT) error { _, err := h.cc.RecallBatch(ctx, "B1", "x"); return err })
	// The parts can still be recalled one by one.
	h.must(reg, "inspector", func(ctx ctxT) error { _, err := h.cc.RecallBatch(ctx, "B1-000", "x"); return err })
}
