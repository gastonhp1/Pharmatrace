package contract

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// These tests go through the contract API like a peer does: function name and string arguments
// in, JSON out, with the caller taken from a real serialized X.509 identity. They catch what the
// direct calls cannot: metadata generation, argument parsing and validation of return values
// against the generated schema (a nil slice or a missing field fails on a real peer).

type invoker struct {
	t  *testing.T
	l  *ledger
	cc *contractapi.ContractChaincode
	id map[string][]byte
}

func newInvoker(t *testing.T) *invoker {
	cc, err := contractapi.NewChaincode(&PharmaTrace{})
	if err != nil {
		t.Fatalf("the contract API rejected the chaincode: %v", err)
	}
	return &invoker{t: t, l: newLedger(), cc: cc, id: map[string][]byte{}}
}

func (iv *invoker) call(msp, fn string, args ...string) (string, int32) {
	iv.t.Helper()
	if iv.id[msp] == nil {
		iv.id[msp] = serializedIdentity(iv.t, msp, "user1@"+strings.ToLower(msp))
	}
	stub := iv.l.newTx()
	stub.creator = iv.id[msp]
	stub.function = fn
	stub.args = args
	resp := iv.cc.Invoke(stub)
	if resp.Status == shim.OK {
		stub.commit()
		return string(resp.Payload), resp.Status
	}
	return resp.Message, resp.Status
}

func (iv *invoker) ok(msp, fn string, args ...string) string {
	iv.t.Helper()
	out, status := iv.call(msp, fn, args...)
	if status != shim.OK {
		iv.t.Fatalf("%s %s(%v): status %d: %s", msp, fn, args, status, out)
	}
	return out
}

func TestInvokeThroughContractAPI(t *testing.T) {
	iv := newInvoker(t)
	iv.ok(reg, "RegisterOrg", lab, RoleManufacturer)
	iv.ok(reg, "RegisterOrg", dist, RoleDistributor)

	out := iv.ok(lab, "RegisterBatch", "B1", "07791234567890", "Insulina", "L1", "2028-03-31")
	var b Batch
	if err := json.Unmarshal([]byte(out), &b); err != nil || b.Owner != lab || b.PendingTo != "" {
		t.Fatalf("RegisterBatch returned %s (%v)", out, err)
	}

	iv.ok(lab, "DispatchBatch", "B1", dist)
	iv.ok(dist, "ReceiveBatch", "B1")

	out = iv.ok(reg, "GetBatchHistory", "B1")
	var history []HistoryEntry
	if err := json.Unmarshal([]byte(out), &history); err != nil || len(history) != 3 {
		t.Fatalf("history: %s (%v)", out, err)
	}

	out = iv.ok(reg, "BatchesByOwner", farma) // empty list must serialize as [], not null
	if out != "[]" {
		t.Fatalf("BatchesByOwner for an org without batches returned %q", out)
	}

	// Cold chain with a struct argument passed as JSON.
	iv.ok(reg, "SetColdChainPolicy", "2-8C", "200", "800", "1800")
	who := iv.ok(dist, "WhoAmI")
	var me Attestor
	if err := json.Unmarshal([]byte(who), &me); err != nil || me.MSPID != dist || me.ClientID == "" {
		t.Fatalf("WhoAmI: %s", who)
	}
	iv.ok(reg, "RegisterAttestor", dist, me.ClientID)
	out = iv.ok(dist, "StartMonitoring", "B1", "valija-01", "2-8C")
	if !strings.Contains(out, `"roots":[]`) {
		t.Fatalf("a new monitoring must have an empty roots list: %s", out)
	}
	now := iv.l.now.Unix()
	window, _ := json.Marshal(Window{Root: strings.Repeat("ab", 32), Count: 5, From: now - 300, To: now, MinTemp: 400, MaxTemp: 500})
	iv.ok(dist, "AnchorWindow", "B1", string(window))

	// Errors come back as a non-OK status with the chaincode's message.
	if msg, status := iv.call(dist, "RegisterBatch", "B2", "07791234567890", "X", "L", "2028-01-01"); status == shim.OK || !strings.Contains(msg, "only a manufacturer") {
		t.Fatalf("expected a permission error, got %d %s", status, msg)
	}
	if _, status := iv.call(lab, "SetColdChainPolicy", "x", "not-a-number", "1", "1"); status == shim.OK {
		t.Fatal("a non-numeric argument was accepted")
	}
}
