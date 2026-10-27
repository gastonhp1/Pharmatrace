package contract

import (
	"strings"
	"testing"
)

const gatewayUser = "iot-gateway"

func gatewayID() string { return "x509::CN=" + gatewayUser + "::CN=ca." + dist }

// coldSetup leaves batch B1 dispatched to the distributor, with a 2-8 C policy that allows 30
// minutes out of range and the distributor's IoT gateway authorized.
func coldSetup(t *testing.T) *harness {
	h := setup(t)
	h.register("B1")
	h.must(reg, "admin", func(ctx ctxT) error { return h.cc.SetColdChainPolicy(ctx, "2-8C", 200, 800, 1800) })
	h.must(reg, "admin", func(ctx ctxT) error { return h.cc.RegisterAttestor(ctx, dist, gatewayID()) })
	h.must(lab, "user1", func(ctx ctxT) error { _, err := h.cc.StartMonitoring(ctx, "B1", "valija-01", "2-8C"); return err })
	return h
}

func (h *harness) anchor(w Window) (*Monitoring, *fakeStub, error) {
	var m *Monitoring
	stub, err := h.as(dist, gatewayUser, func(ctx ctxT) error {
		var err error
		m, err = h.cc.AnchorWindow(ctx, "B1", w)
		return err
	})
	return m, stub, err
}

func (h *harness) window(from, to int64, min, max, excursion int) Window {
	return Window{Root: "0x" + strings.Repeat("1f", 32), Count: 10, From: from, To: to, MinTemp: min, MaxTemp: max, ExcursionSeconds: excursion}
}

func TestPolicyRules(t *testing.T) {
	h := setup(t)
	h.fails("only the regulator", lab, "admin", func(ctx ctxT) error { return h.cc.SetColdChainPolicy(ctx, "p", 200, 800, 0) })
	h.fails("invalid temperature range", reg, "admin", func(ctx ctxT) error { return h.cc.SetColdChainPolicy(ctx, "p", 800, 200, 0) })
	h.must(reg, "admin", func(ctx ctxT) error { return h.cc.SetColdChainPolicy(ctx, "p", 200, 800, 0) })
	h.fails("already exists", reg, "admin", func(ctx ctxT) error { return h.cc.SetColdChainPolicy(ctx, "p", 100, 900, 60) })
	h.fails("only the regulator", dist, "admin", func(ctx ctxT) error { return h.cc.RegisterAttestor(ctx, dist, gatewayID()) })
}

func TestStartMonitoringRules(t *testing.T) {
	h := coldSetup(t)
	h.fails("already monitored", lab, "user1", func(ctx ctxT) error { _, err := h.cc.StartMonitoring(ctx, "B1", "valija-02", "2-8C"); return err })

	h.register("B2")
	h.fails("only the owner", farma, "user1", func(ctx ctxT) error { _, err := h.cc.StartMonitoring(ctx, "B2", "v", "2-8C"); return err })
	h.fails("does not exist", lab, "user1", func(ctx ctxT) error { _, err := h.cc.StartMonitoring(ctx, "B2", "v", "nope"); return err })
	// An authorized gateway can start it even if its org does not own the batch yet.
	h.must(dist, gatewayUser, func(ctx ctxT) error { _, err := h.cc.StartMonitoring(ctx, "B2", "v", "2-8C"); return err })
}

func TestAnchorWindows(t *testing.T) {
	h := coldSetup(t)
	now := h.l.now.Unix()

	// Only the authorized gateway identity: another user of the same org cannot anchor.
	h.fails("authorized IoT gateway", dist, "user1", func(ctx ctxT) error {
		_, err := h.cc.AnchorWindow(ctx, "B1", h.window(now-600, now-300, 300, 500, 0))
		return err
	})

	m, stub, err := h.anchor(h.window(now-600, now-300, 300, 500, 0))
	if err != nil {
		t.Fatal(err)
	}
	if m.ReadingCount != 10 || m.Verdict != VerdictMonitoring || len(m.Roots) != 1 || m.Roots[0] != strings.Repeat("1f", 32) {
		t.Fatalf("after first window: %+v", m)
	}
	if stub.events[0] != EventReadingsAnchored {
		t.Fatalf("events %v", stub.events)
	}

	cases := []struct {
		want string
		w    Window
	}{
		{"overlaps", h.window(now-400, now-200, 300, 500, 0)},
		{"future", h.window(now-200, now+3600, 300, 500, 0)},
		{"reports no excursion", h.window(now-200, now-100, 300, 950, 0)},
		{"from > to", h.window(now-100, now-200, 300, 500, 0)},
		{"empty window", Window{Root: strings.Repeat("aa", 32), Count: 0, From: now - 200, To: now - 100}},
		{"invalid root", Window{Root: strings.Repeat("0", 64), Count: 1, From: now - 200, To: now - 100}},
	}
	for _, c := range cases {
		if _, _, err := h.anchor(c.w); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v", c.want, err)
		}
	}

	// 20 minutes out of range: still within the 30 allowed.
	if m, _, err = h.anchor(h.window(now-200, now-100, 300, 950, 1200)); err != nil || m.Verdict != VerdictMonitoring {
		t.Fatalf("within budget: %+v %v", m, err)
	}
	// 15 more: 35 minutes > 30, compromised.
	m, stub, err = h.anchor(h.window(now-50, now, 300, 1000, 900))
	if err != nil {
		t.Fatal(err)
	}
	if m.Verdict != VerdictCompromised || m.ExcursionSeconds != 2100 || stub.events[0] != EventColdChainCompromise {
		t.Fatalf("over budget: %+v events %v", m, stub.events)
	}

	// Closing keeps the verdict, and a closed session takes no more windows.
	// While in transit to DistMSP, its users can close the session when they open the valija.
	h.must(lab, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchBatch(ctx, "B1", dist); return err })
	h.must(dist, "user1", func(ctx ctxT) error {
		m, err := h.cc.CloseMonitoring(ctx, "B1")
		if err == nil && (m.Verdict != VerdictCompromised || !m.Closed) {
			t.Errorf("closed: %+v", m)
		}
		return err
	})
	if _, _, err := h.anchor(h.window(now+10, now+20, 300, 500, 0)); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("anchoring after close: %v", err)
	}
}

func TestDeviceEventsAndCompliantClose(t *testing.T) {
	h := coldSetup(t)
	event := func(kind string) (*Monitoring, error) {
		var m *Monitoring
		_, err := h.as(dist, gatewayUser, func(ctx ctxT) error {
			var err error
			m, err = h.cc.ReportDeviceEvent(ctx, "B1", kind, h.l.now.Unix())
			return err
		})
		return m, err
	}
	if m, err := event(DeviceEventLidOpened); err != nil || m.Verdict != VerdictMonitoring {
		t.Fatalf("lid opened: %+v %v", m, err)
	}
	if _, err := event("EXPLODED"); err == nil {
		t.Fatal("unknown event accepted")
	}

	// Without problems, closing gives COMPLIANT. The pharmacy is not a holder: it cannot close.
	h.fails("only the holder", farma, "user1", func(ctx ctxT) error { _, err := h.cc.CloseMonitoring(ctx, "B1"); return err })
	h.must(lab, "user1", func(ctx ctxT) error {
		m, err := h.cc.CloseMonitoring(ctx, "B1")
		if err == nil && m.Verdict != VerdictCompliant {
			t.Errorf("verdict %s", m.Verdict)
		}
		return err
	})

	h2 := coldSetup(t)
	h = h2
	if m, err := event(DeviceEventSealBroken); err != nil || m.Verdict != VerdictCompromised || !strings.Contains(m.Reason, "seal") {
		t.Fatalf("seal broken: %+v %v", m, err)
	}
}

func TestRevokedAttestor(t *testing.T) {
	h := coldSetup(t)
	h.must(reg, "admin", func(ctx ctxT) error { return h.cc.RevokeAttestor(ctx, dist, gatewayID()) })
	now := h.l.now.Unix()
	if _, _, err := h.anchor(h.window(now-60, now, 300, 500, 0)); err == nil {
		t.Fatal("a revoked gateway anchored readings")
	}
}
