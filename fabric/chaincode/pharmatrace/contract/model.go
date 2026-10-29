package contract

// Everything the chaincode stores in the world state is JSON. Fields have no omitempty: the
// contract API validates what a function returns against the generated metadata, and a missing
// required field (or a nil slice serialized as null) fails that validation on a real peer.

// Org roles. The regulator is not a role in the registry: it is the RegulatorMSP organization.
const (
	RoleManufacturer = "manufacturer"
	RoleDistributor  = "distributor"
	RolePharmacy     = "pharmacy"
)

// RegulatorMSP is the MSP ID of the regulator (an ANMAT-like authority). It registers the other
// organizations, sets cold-chain policies, authorizes IoT gateways and is the only one that can
// recall a batch. It also co-endorses every write (see the endorsement policies in fabric/network).
const RegulatorMSP = "RegMSP"

// Batch states. A batch only moves forward, except RECALLED, which can happen at any point
// before it is dispensed and is final.
const (
	StateRegistered     = "REGISTERED"      // the manufacturer created it
	StateInTransit      = "IN_TRANSIT"      // dispatched, waiting for the recipient to receive it
	StateInDistribution = "IN_DISTRIBUTION" // held by a distributor (droguería)
	StateInPharmacy     = "IN_PHARMACY"     // held by a pharmacy
	StateDispensed      = "DISPENSED"       // handed to a patient
	StateRecalled       = "RECALLED"        // pulled from the market by the regulator
)

// Cargo states.
const (
	CargoOpen      = "OPEN"       // created, its batches are locked to it
	CargoInTransit = "IN_TRANSIT" // dispatched with all its batches
	CargoDelivered = "DELIVERED"  // received: the batches are free again
	CargoDissolved = "DISSOLVED"  // undone by its owner before dispatching it
)

// MaxBatchesPerCargo bounds the work (and the endorsement) of one cargo transaction.
const MaxBatchesPerCargo = 100

// Object types used to build composite keys.
const (
	objOrg        = "org"
	objBatch      = "batch"
	objOwnerIndex = "owner~batch"
	objCargo      = "cargo"
	objPolicy     = "coldpolicy"
	objAttestor   = "attestor"
	objDevice     = "device"
	objMonitoring = "monitoring"
)

// Org is an organization of the consortium and its role in the supply chain.
type Org struct {
	MSPID        string `json:"mspId"`
	Role         string `json:"role"`
	RegisteredAt string `json:"registeredAt"`
}

// Batch is a lot of a medicine as it travels from the manufacturer to the patient.
//
// The custody history is not stored here: Fabric keeps every version of the key, and
// GetBatchHistory reads it with GetHistoryForKey.
type Batch struct {
	ID            string `json:"id"`
	GTIN          string `json:"gtin"`    // product code (GS1 GTIN, as in the ANMAT traceability system)
	Product       string `json:"product"` // commercial name
	Lot           string `json:"lot"`
	ExpiryDate    string `json:"expiryDate"` // YYYY-MM-DD
	Manufacturer  string `json:"manufacturer"`
	Owner         string `json:"owner"`     // MSP ID of the org that holds it
	PendingTo     string `json:"pendingTo"` // MSP ID of the recipient while IN_TRANSIT, "" otherwise
	State         string `json:"state"`
	Cargo         string `json:"cargo"`      // cargo it travels in, "" when it moves on its own
	PatientRef    string `json:"patientRef"` // sha256 of a patient reference, set when dispensed
	RecallReason  string `json:"recallReason"`
	StateBefore   string `json:"stateBefore"` // state before the recall
	LastUpdatedAt string `json:"lastUpdatedAt"`
	LastTxID      string `json:"lastTxId"`
}

// HistoryEntry is one version of a batch, as returned by GetHistoryForKey.
type HistoryEntry struct {
	TxID      string `json:"txId"`
	Timestamp string `json:"timestamp"`
	IsDelete  bool   `json:"isDelete"`
	Batch     *Batch `json:"batch" metadata:",optional"`
}

// Cargo is a group of batches that travel together from one org to the next, with one IoT
// valija watching all of them. While a batch is in a cargo it only moves with the cargo.
type Cargo struct {
	ID        string   `json:"id"`
	Owner     string   `json:"owner"`
	PendingTo string   `json:"pendingTo"`
	BatchIDs  []string `json:"batchIds"`
	State     string   `json:"state"`
	CreatedAt string   `json:"createdAt"`
	UpdatedAt string   `json:"updatedAt"`
}

// CommercialTerms is what a seller and a buyer agreed for a batch. It travels in the transient
// map and is stored only in a private data collection shared by the two orgs: the rest of the
// channel only sees its hash.
type CommercialTerms struct {
	BatchID   string `json:"batchId"`
	Seller    string `json:"seller"`
	Buyer     string `json:"buyer"`
	UnitPrice string `json:"unitPrice"` // decimal as a string, to avoid float rounding
	Currency  string `json:"currency"`
	Quantity  int    `json:"quantity"`
}

// Device is an IoT valija. Its public key lets anyone re-check the signature of a reading.
type Device struct {
	ID                string `json:"id"`
	Org               string `json:"org"`               // MSP ID of the org that registered it
	PubKey            string `json:"pubKey"`            // P-256 X || Y, 64 bytes in hex
	CalibrationExpiry int64  `json:"calibrationExpiry"` // unix seconds
	Active            bool   `json:"active"`
	ActiveCargo       string `json:"activeCargo"` // cargo it is monitoring, "" when free
}

// ColdChainPolicy is the temperature range a cargo has to stay in. Temperatures are in
// hundredths of a degree Celsius (2.00 C = 200).
type ColdChainPolicy struct {
	ID                  string `json:"id"`
	MinTemp             int    `json:"minTemp"`
	MaxTemp             int    `json:"maxTemp"`
	MaxExcursionSeconds int    `json:"maxExcursionSeconds"` // total time allowed out of range
}

// Window is a group of readings from the IoT valija, already verified by the gateway. The raw
// readings stay off-chain; the ledger gets their Merkle root and the numbers needed to judge them.
type Window struct {
	Root             string `json:"root"` // hex, 32 bytes
	Count            int    `json:"count"`
	From             int64  `json:"from"` // unix seconds of the first reading
	To               int64  `json:"to"`   // unix seconds of the last reading
	MinTemp          int    `json:"minTemp"`
	MaxTemp          int    `json:"maxTemp"`
	ExcursionSeconds int    `json:"excursionSeconds"`
}

// Monitoring verdicts.
const (
	VerdictMonitoring  = "MONITORING"
	VerdictCompliant   = "COMPLIANT"
	VerdictCompromised = "COMPROMISED"
)

// Device events reported by the gateway.
const (
	DeviceEventLidOpened  = "LID_OPENED"
	DeviceEventShock      = "SHOCK"
	DeviceEventSealBroken = "SEAL_BROKEN"
)

// DeviceEvent is a lid opening, a shock or a broken seal, with the hash of the reading that
// showed it.
type DeviceEvent struct {
	Kind        string `json:"kind"`
	Timestamp   int64  `json:"timestamp"`
	PayloadHash string `json:"payloadHash"`
}

// Monitoring is the cold-chain session of a cargo: which valija watched it, under which policy,
// and what came out of it. Every batch of the cargo shares the verdict.
type Monitoring struct {
	CargoID          string        `json:"cargoId"`
	DeviceID         string        `json:"deviceId"`
	PolicyID         string        `json:"policyId"`
	StartedAt        string        `json:"startedAt"`
	LastWindowEnd    int64         `json:"lastWindowEnd"`
	ReadingCount     int           `json:"readingCount"`
	ExcursionSeconds int           `json:"excursionSeconds"`
	Roots            []string      `json:"roots"`
	Events           []DeviceEvent `json:"events"`
	Verdict          string        `json:"verdict"`
	Reason           string        `json:"reason"`
	Closed           bool          `json:"closed"`
}

// Attestor is an IoT gateway identity allowed to anchor readings.
type Attestor struct {
	ClientID string `json:"clientId"`
	MSPID    string `json:"mspId"`
}

// Event payloads. Fabric keeps one event per transaction, so each function emits at most one.
type batchEvent struct {
	BatchID string `json:"batchId"`
	Owner   string `json:"owner"`
	State   string `json:"state"`
	To      string `json:"to,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

type cargoEvent struct {
	CargoID  string   `json:"cargoId"`
	Owner    string   `json:"owner"`
	State    string   `json:"state"`
	To       string   `json:"to,omitempty"`
	BatchIDs []string `json:"batchIds"`
}

type coldChainEvent struct {
	CargoID          string `json:"cargoId"`
	Verdict          string `json:"verdict"`
	ExcursionSeconds int    `json:"excursionSeconds"`
	Reason           string `json:"reason,omitempty"`
}

// Event names.
const (
	EventBatchRegistered     = "BatchRegistered"
	EventBatchDispatched     = "BatchDispatched"
	EventBatchReceived       = "BatchReceived"
	EventBatchDispensed      = "BatchDispensed"
	EventBatchRecalled       = "BatchRecalled"
	EventCargoCreated        = "CargoCreated"
	EventCargoDispatched     = "CargoDispatched"
	EventCargoReceived       = "CargoReceived"
	EventReadingsAnchored    = "ReadingsAnchored"
	EventColdChainCompromise = "ColdChainCompromised"
	EventMonitoringClosed    = "MonitoringClosed"
)
