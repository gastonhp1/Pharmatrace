package contract

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/v2/pkg/cid"
	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
	"github.com/hyperledger/fabric-protos-go-apiv2/ledger/queryresult"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// ledger is an in-memory world state shared by the fake stubs of a test, so a test can run
// several transactions in a row, as different orgs, against the same state. Each transaction
// buffers its writes and they are applied only if the transaction succeeds, like a commit.
type ledger struct {
	state      map[string][]byte
	validation map[string][]byte            // state-based endorsement policies by key
	private    map[string]map[string][]byte // collection -> key -> value
	history    map[string][]*queryresult.KeyModification
	txCount    int
	now        time.Time
}

func newLedger() *ledger {
	return &ledger{
		state:      map[string][]byte{},
		validation: map[string][]byte{},
		private:    map[string]map[string][]byte{},
		history:    map[string][]*queryresult.KeyModification{},
		now:        time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC),
	}
}

// fakeStub implements the parts of shim.ChaincodeStubInterface the chaincode uses. Calling any
// other method panics on the nil embedded interface, which makes an unexpected call obvious.
type fakeStub struct {
	shim.ChaincodeStubInterface
	l         *ledger
	txID      string
	writes    map[string][]byte // nil value = delete
	order     []string
	privW     map[string]map[string][]byte
	vparams   map[string][]byte
	transient map[string][]byte
	events    []string
	eventData [][]byte
	creator   []byte
	function  string
	args      []string
}

func (l *ledger) newTx() *fakeStub {
	l.txCount++
	l.now = l.now.Add(time.Minute)
	return &fakeStub{
		l:         l,
		txID:      fmt.Sprintf("tx%03d", l.txCount),
		writes:    map[string][]byte{},
		privW:     map[string]map[string][]byte{},
		vparams:   map[string][]byte{},
		transient: map[string][]byte{},
	}
}

// commit applies the buffered writes to the ledger.
func (s *fakeStub) commit() {
	for _, k := range s.order {
		v := s.writes[k]
		if v == nil {
			delete(s.l.state, k)
		} else {
			s.l.state[k] = v
		}
		s.l.history[k] = append(s.l.history[k], &queryresult.KeyModification{
			TxId: s.txID, Value: v, Timestamp: timestamppb.New(s.l.now), IsDelete: v == nil,
		})
	}
	for k, v := range s.vparams {
		s.l.validation[k] = v
	}
	for coll, kv := range s.privW {
		if s.l.private[coll] == nil {
			s.l.private[coll] = map[string][]byte{}
		}
		for k, v := range kv {
			s.l.private[coll][k] = v
		}
	}
}

func (s *fakeStub) GetTxID() string { return s.txID }

func (s *fakeStub) GetChannelID() string { return "pharmatrace" }

func (s *fakeStub) GetTxTimestamp() (*timestamppb.Timestamp, error) {
	return timestamppb.New(s.l.now), nil
}

func (s *fakeStub) GetState(key string) ([]byte, error) {
	// Like Fabric, a transaction does not read its own writes.
	return s.l.state[key], nil
}

func (s *fakeStub) PutState(key string, value []byte) error {
	if key == "" {
		return fmt.Errorf("empty key")
	}
	if len(value) == 0 {
		return fmt.Errorf("empty value for %q", key)
	}
	s.record(key, value)
	return nil
}

func (s *fakeStub) DelState(key string) error {
	s.record(key, nil)
	return nil
}

func (s *fakeStub) record(key string, value []byte) {
	if _, ok := s.writes[key]; !ok {
		s.order = append(s.order, key)
	}
	s.writes[key] = value
}

func (s *fakeStub) CreateCompositeKey(objectType string, attributes []string) (string, error) {
	return shim.CreateCompositeKey(objectType, attributes)
}

func (s *fakeStub) SplitCompositeKey(key string) (string, []string, error) {
	parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(key, "\x00"), "\x00"), "\x00")
	if len(parts) == 0 {
		return "", nil, fmt.Errorf("invalid composite key")
	}
	return parts[0], parts[1:], nil
}

func (s *fakeStub) GetStateByPartialCompositeKey(objectType string, attrs []string) (shim.StateQueryIteratorInterface, error) {
	prefix, err := shim.CreateCompositeKey(objectType, attrs)
	if err != nil {
		return nil, err
	}
	keys := []string{}
	for k := range s.l.state {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	it := &kvIterator{}
	for _, k := range keys {
		it.items = append(it.items, &queryresult.KV{Namespace: "pharmatrace", Key: k, Value: s.l.state[k]})
	}
	return it, nil
}

func (s *fakeStub) GetHistoryForKey(key string) (shim.HistoryQueryIteratorInterface, error) {
	return &historyIterator{items: s.l.history[key]}, nil
}

func (s *fakeStub) SetStateValidationParameter(key string, ep []byte) error {
	s.vparams[key] = ep
	return nil
}

func (s *fakeStub) GetTransient() (map[string][]byte, error) { return s.transient, nil }

func (s *fakeStub) PutPrivateData(collection, key string, value []byte) error {
	if s.privW[collection] == nil {
		s.privW[collection] = map[string][]byte{}
	}
	s.privW[collection][key] = value
	return nil
}

func (s *fakeStub) GetPrivateData(collection, key string) ([]byte, error) {
	return s.l.private[collection][key], nil
}

func (s *fakeStub) GetPrivateDataHash(collection, key string) ([]byte, error) {
	v := s.l.private[collection][key]
	if v == nil {
		return nil, nil
	}
	sum := sha256.Sum256(v)
	return sum[:], nil
}

func (s *fakeStub) SetEvent(name string, payload []byte) error {
	s.events = append(s.events, name)
	s.eventData = append(s.eventData, payload)
	return nil
}

// Used by the contract API when a transaction goes through Invoke.
func (s *fakeStub) GetFunctionAndParameters() (string, []string) { return s.function, s.args }
func (s *fakeStub) GetCreator() ([]byte, error)                  { return s.creator, nil }
func (s *fakeStub) GetArgs() [][]byte {
	out := [][]byte{[]byte(s.function)}
	for _, a := range s.args {
		out = append(out, []byte(a))
	}
	return out
}

type kvIterator struct {
	items []*queryresult.KV
	i     int
}

func (it *kvIterator) HasNext() bool { return it.i < len(it.items) }
func (it *kvIterator) Close() error  { return nil }
func (it *kvIterator) Next() (*queryresult.KV, error) {
	it.i++
	return it.items[it.i-1], nil
}

type historyIterator struct {
	items []*queryresult.KeyModification
	i     int
}

func (it *historyIterator) HasNext() bool { return it.i < len(it.items) }
func (it *historyIterator) Close() error  { return nil }
func (it *historyIterator) Next() (*queryresult.KeyModification, error) {
	it.i++
	return it.items[it.i-1], nil
}

// fakeIdentity is the client identity of a transaction.
type fakeIdentity struct {
	cid.ClientIdentity
	msp   string
	id    string
	attrs map[string]string
}

func (f fakeIdentity) GetMSPID() (string, error) { return f.msp, nil }
func (f fakeIdentity) GetID() (string, error)    { return f.id, nil }
func (f fakeIdentity) GetAttributeValue(name string) (string, bool, error) {
	v, ok := f.attrs[name]
	return v, ok, nil
}

// Users whose name starts with "iot-gateway" get the IoT gateway role in their certificate, as
// their org's CA would issue it.
func attrsFor(user string) map[string]string {
	if strings.HasPrefix(user, "iot-gateway") {
		return map[string]string{AttrRole: RoleIoTGateway}
	}
	return map[string]string{}
}

// tx runs one chaincode function as a member of an org and commits it if it succeeds.
type harness struct {
	t  *testing.T
	l  *ledger
	cc *PharmaTrace
}

func newHarness(t *testing.T) *harness {
	return &harness{t: t, l: newLedger(), cc: &PharmaTrace{}}
}

// as runs fn with a transaction context for the given org and user, commits on success and
// returns the stub so the test can inspect events and endorsement policies.
func (h *harness) as(msp, user string, fn func(ctx contractapi.TransactionContextInterface) error, transient ...map[string][]byte) (*fakeStub, error) {
	stub := h.l.newTx()
	if len(transient) > 0 {
		stub.transient = transient[0]
	}
	ctx := &contractapi.TransactionContext{}
	ctx.SetStub(stub)
	ctx.SetClientIdentity(fakeIdentity{msp: msp, id: "x509::CN=" + user + "::CN=ca." + msp, attrs: attrsFor(user)})
	err := fn(ctx)
	if err == nil {
		stub.commit()
	}
	return stub, err
}

// must is as() for steps that have to succeed.
func (h *harness) must(msp, user string, fn func(ctx contractapi.TransactionContextInterface) error, transient ...map[string][]byte) *fakeStub {
	h.t.Helper()
	stub, err := h.as(msp, user, fn, transient...)
	if err != nil {
		h.t.Fatalf("%s as %s: unexpected error: %v", msp, user, err)
	}
	return stub
}

// fails checks that a step fails with an error containing want.
func (h *harness) fails(want string, msp, user string, fn func(ctx contractapi.TransactionContextInterface) error, transient ...map[string][]byte) {
	h.t.Helper()
	_, err := h.as(msp, user, fn, transient...)
	if err == nil {
		h.t.Fatalf("%s as %s: expected an error containing %q, got none", msp, user, want)
	}
	if !strings.Contains(err.Error(), want) {
		h.t.Fatalf("%s as %s: expected an error containing %q, got %q", msp, user, want, err)
	}
}

// serializedIdentity builds what a real client sends as the creator of a transaction: its MSP ID
// and a PEM X.509 certificate, as a protobuf.
func serializedIdentity(t *testing.T, mspID, cn string, attrs map[string]string) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	if len(attrs) > 0 {
		// Fabric CA puts the attributes, as JSON, in this extension (see pkg/attrmgr).
		value, _ := json.Marshal(map[string]map[string]string{"attrs": attrs})
		tmpl.ExtraExtensions = []pkix.Extension{{Id: asn1.ObjectIdentifier{1, 2, 3, 4, 5, 6, 7, 8, 1}, Value: value}}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	sid := &msp.SerializedIdentity{Mspid: mspID, IdBytes: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
	out, err := proto.Marshal(sid)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
