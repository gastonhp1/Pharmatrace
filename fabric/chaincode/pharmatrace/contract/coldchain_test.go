package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

const gatewayUser = "iot-gateway"

var testPubKey = strings.Repeat("ab", 64)

// coldSetup leaves cargo C1 (batch B1) open at the lab, a 2-8 C policy that allows 30 minutes out
// of range, the distributor's valija-01 registered and its IoT gateway authorized, and C1
// monitored by valija-01.
func coldSetup(t *testing.T) *harness {
	h := setup(t)
	h.register("B1")
	h.createCargo(lab, "C1", "B1")
	h.must(reg, "admin", func(ctx ctxT) error { return h.cc.SetColdChainPolicy(ctx, "2-8C", 200, 800, 1800) })
	h.must(reg, "admin", func(ctx ctxT) error { _, err := h.cc.AuthorizeGatewayOrg(ctx, dist); return err })
	h.registerDevice("valija-01")
	h.must(lab, "user1", func(ctx ctxT) error { _, err := h.cc.StartMonitoring(ctx, "C1", "valija-01", "2-8C"); return err })
	return h
}

func (h *harness) registerDevice(id string) {
	h.t.Helper()
	expiry := h.l.now.Unix() + 365*24*3600
	h.must(dist, "user1", func(ctx ctxT) error { _, err := h.cc.RegisterDevice(ctx, id, "0x"+testPubKey, expiry); return err })
}

func (h *harness) device(id string) *Device {
	h.t.Helper()
	var d *Device
	h.must(reg, "auditor", func(ctx ctxT) error {
		var err error
		d, err = h.cc.GetDevice(ctx, id)
		return err
	})
	return d
}

func (h *harness) anchor(w Window) (*Monitoring, *fakeStub, error) {
	var m *Monitoring
	stub, err := h.as(dist, gatewayUser, func(ctx ctxT) error {
		var err error
		m, err = h.cc.AnchorWindow(ctx, "C1", w)
		return err
	})
	return m, stub, err
}

func (h *harness) window(from, to int64, min, max, excursion int) Window {
	return Window{Root: "0x" + strings.Repeat("1f", 32), Count: 10, From: from, To: to, MinTemp: min, MaxTemp: max, ExcursionSeconds: excursion}
}

func TestDevices(t *testing.T) {
	h := setup(t)
	future := h.l.now.Unix() + 3600
	register := func(msp, id, key string, expiry int64) func(ctx ctxT) error {
		return func(ctx ctxT) error { _, err := h.cc.RegisterDevice(ctx, id, key, expiry); return err }
	}
	h.fails("FORBIDDEN", "NopeMSP", "user1", register("NopeMSP", "v1", testPubKey, future))
	h.fails("pubKey", dist, "user1", register(dist, "v1", "abcd", future))
	h.fails("calibration already expired", dist, "user1", register(dist, "v1", testPubKey, h.l.now.Unix()-1))
	h.must(dist, "user1", register(dist, "v1", testPubKey, future))
	h.fails("already exists", lab, "user1", register(lab, "v1", testPubKey, future))
	if d := h.device("v1"); d.Org != dist || !d.Active || d.PubKey != testPubKey {
		t.Fatalf("device: %+v", d)
	}
	h.fails("belongs to DistMSP", lab, "user1", func(ctx ctxT) error { _, err := h.cc.SetDeviceActive(ctx, "v1", false); return err })
	h.must(reg, "admin", func(ctx ctxT) error { _, err := h.cc.SetDeviceActive(ctx, "v1", false); return err })
}

func TestPolicyRules(t *testing.T) {
	h := setup(t)
	h.fails("only the regulator", lab, "admin", func(ctx ctxT) error { return h.cc.SetColdChainPolicy(ctx, "p", 200, 800, 0) })
	h.fails("invalid temperature range", reg, "admin", func(ctx ctxT) error { return h.cc.SetColdChainPolicy(ctx, "p", 800, 200, 0) })
	h.must(reg, "admin", func(ctx ctxT) error { return h.cc.SetColdChainPolicy(ctx, "p", 200, 800, 0) })
	h.fails("already exists", reg, "admin", func(ctx ctxT) error { return h.cc.SetColdChainPolicy(ctx, "p", 100, 900, 60) })
	h.fails("only the regulator", dist, "admin", func(ctx ctxT) error { _, err := h.cc.AuthorizeGatewayOrg(ctx, dist); return err })
	h.fails("NOT_FOUND", reg, "admin", func(ctx ctxT) error { _, err := h.cc.AuthorizeGatewayOrg(ctx, "NopeMSP"); return err })
}

func TestStartMonitoringRules(t *testing.T) {
	h := coldSetup(t)
	if d := h.device("valija-01"); d.ActiveCargo != "C1" {
		t.Fatalf("device after start: %+v", d)
	}
	h.fails("already monitored", lab, "user1", func(ctx ctxT) error { _, err := h.cc.StartMonitoring(ctx, "C1", "valija-02", "2-8C"); return err })

	h.register("B2")
	h.createCargo(lab, "C2", "B2")
	start := func(msp, user, device, policy string) func(ctx ctxT) error {
		return func(ctx ctxT) error { _, err := h.cc.StartMonitoring(ctx, "C2", device, policy); return err }
	}
	h.fails("only the owner", farma, "user1", start(farma, "user1", "valija-01", "2-8C"))
	h.fails("policy nope does not exist", lab, "user1", start(lab, "user1", "valija-01", "nope"))
	h.fails("already monitoring cargo C1", lab, "user1", start(lab, "user1", "valija-01", "2-8C"))
	h.fails("device valija-02 does not exist", lab, "user1", start(lab, "user1", "valija-02", "2-8C"))
	h.registerDevice("valija-02")
	h.fails("is monitoring cargo C1", dist, "user1", func(ctx ctxT) error { _, err := h.cc.SetDeviceActive(ctx, "valija-01", false); return err })
	h.must(dist, "user1", func(ctx ctxT) error { _, err := h.cc.SetDeviceActive(ctx, "valija-02", false); return err })
	h.fails("not operational", lab, "user1", start(lab, "user1", "valija-02", "2-8C"))
	h.must(dist, "user1", func(ctx ctxT) error { _, err := h.cc.SetDeviceActive(ctx, "valija-02", true); return err })
	// An authorized gateway can start it even if its org does not own the cargo.
	h.must(dist, gatewayUser, start(dist, gatewayUser, "valija-02", "2-8C"))
}

func TestAnchorWindows(t *testing.T) {
	h := coldSetup(t)
	now := h.l.now.Unix()

	// Only the authorized gateway identity: another user of the same org cannot anchor.
	h.fails("FORBIDDEN: only an authorized IoT gateway", dist, "user1", func(ctx ctxT) error {
		_, err := h.cc.AnchorWindow(ctx, "C1", h.window(now-600, now-300, 300, 500, 0))
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

	// While in transit, the recipient closes it when it opens the valija; the verdict stays and
	// the valija is free again.
	h.must(lab, "user1", func(ctx ctxT) error { _, err := h.cc.DispatchCargo(ctx, "C1", dist); return err })
	h.fails("only the holder", farma, "user1", func(ctx ctxT) error { _, err := h.cc.CloseMonitoring(ctx, "C1"); return err })
	h.must(dist, "user1", func(ctx ctxT) error {
		m, err := h.cc.CloseMonitoring(ctx, "C1")
		if err == nil && (m.Verdict != VerdictCompromised || !m.Closed) {
			t.Errorf("closed: %+v", m)
		}
		return err
	})
	if d := h.device("valija-01"); d.ActiveCargo != "" {
		t.Fatalf("device not freed: %+v", d)
	}
	if _, _, err := h.anchor(h.window(now+10, now+20, 300, 500, 0)); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("anchoring after close: %v", err)
	}
}

func TestDeviceEventsAndCompliantClose(t *testing.T) {
	h := coldSetup(t)
	event := func(kind, hash string) (*Monitoring, error) {
		var m *Monitoring
		_, err := h.as(dist, gatewayUser, func(ctx ctxT) error {
			var err error
			m, err = h.cc.ReportDeviceEvent(ctx, "C1", kind, h.l.now.Unix(), hash)
			return err
		})
		return m, err
	}
	hash := strings.Repeat("cd", 32)
	if m, err := event(DeviceEventLidOpened, hash); err != nil || m.Verdict != VerdictMonitoring || len(m.Events) != 1 || m.Events[0].Kind != DeviceEventLidOpened {
		t.Fatalf("lid opened: %+v %v", m, err)
	}
	if _, err := event("EXPLODED", hash); err == nil {
		t.Fatal("unknown event accepted")
	}
	if _, err := event(DeviceEventShock, "nope"); err == nil {
		t.Fatal("bad payload hash accepted")
	}

	h.must(lab, "user1", func(ctx ctxT) error {
		m, err := h.cc.CloseMonitoring(ctx, "C1")
		if err == nil && m.Verdict != VerdictCompliant {
			t.Errorf("verdict %s", m.Verdict)
		}
		return err
	})

	h = coldSetup(t)
	if m, err := event(DeviceEventSealBroken, hash); err != nil || m.Verdict != VerdictCompromised || !strings.Contains(m.Reason, "seal") {
		t.Fatalf("seal broken: %+v %v", m, err)
	}
}

func TestVerifyReading(t *testing.T) {
	h := coldSetup(t)
	// Same tree as backend/iot/merkle.js: sorted pairs, odd node carried up.
	leaf := func(i byte) []byte { s := sha256.Sum256([]byte{i}); return s[:] }
	l0, l1, l2 := leaf(0), leaf(1), leaf(2)
	n01 := hashPair(l0, l1)
	root := hashPair(n01, l2)

	now := h.l.now.Unix()
	w := h.window(now-60, now, 300, 500, 0)
	w.Root = hex.EncodeToString(root)
	w.Count = 3
	if _, _, err := h.anchor(w); err != nil {
		t.Fatal(err)
	}

	verify := func(index int, l []byte, proof ...[]byte) bool {
		var ok bool
		h.must(reg, "auditor", func(ctx ctxT) error {
			p := []string{}
			for _, x := range proof {
				p = append(p, "0x"+hex.EncodeToString(x))
			}
			var err error
			ok, err = h.cc.VerifyReading(ctx, "C1", index, hex.EncodeToString(l), p)
			return err
		})
		return ok
	}
	if !verify(0, l1, l0, l2) || !verify(0, l2, n01) {
		t.Fatal("a valid proof did not verify")
	}
	if verify(0, leaf(9), l0, l2) {
		t.Fatal("a wrong leaf verified")
	}
	h.fails("no anchor 1", reg, "auditor", func(ctx ctxT) error {
		_, err := h.cc.VerifyReading(ctx, "C1", 1, hex.EncodeToString(l0), []string{})
		return err
	})
}

func TestGatewayAuthorization(t *testing.T) {
	h := coldSetup(t)
	now := h.l.now.Unix()
	anchorAs := func(msp, user string) error {
		_, err := h.as(msp, user, func(ctx ctxT) error {
			_, err := h.cc.AnchorWindow(ctx, "C1", h.window(now-60, now, 300, 500, 0))
			return err
		})
		return err
	}
	// The role without an authorized org is not enough...
	if err := anchorAs(lab, "iot-gateway-lab"); err == nil {
		t.Fatal("a gateway of an org the regulator did not authorize anchored readings")
	}
	// ...and neither is the org without the role in the certificate.
	if err := anchorAs(dist, "user1"); err == nil {
		t.Fatal("a dist user without the iot-gateway role anchored readings")
	}
	// Any certificate with the role works: a second gateway needs no transaction, just the CA.
	if err := anchorAs(dist, "iot-gateway-2"); err != nil {
		t.Fatalf("a second gateway of DistMSP: %v", err)
	}
	h.must(reg, "admin", func(ctx ctxT) error { return h.cc.RevokeGatewayOrg(ctx, dist) })
	if err := anchorAs(dist, "iot-gateway"); err == nil {
		t.Fatal("a gateway anchored after its org was revoked")
	}
}
