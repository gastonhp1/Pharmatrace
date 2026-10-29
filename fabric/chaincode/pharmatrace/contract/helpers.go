package contract

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/v2/pkg/statebased"
	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// ---------------------------------------------------------------- identity

// clientMSP is the organization of whoever signed the proposal. In Fabric the identity comes from
// the X.509 certificate of the client, issued by its org's CA: there are no wallets or addresses.
func clientMSP(ctx contractapi.TransactionContextInterface) (string, error) {
	msp, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return "", fmt.Errorf("could not read the client MSP: %w", err)
	}
	return msp, nil
}

// clientID is the unique ID of the client certificate (subject + issuer), base64 encoded.
func clientID(ctx contractapi.TransactionContextInterface) (string, error) {
	id, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return "", fmt.Errorf("could not read the client ID: %w", err)
	}
	return id, nil
}

// clientRole is the pharmatrace.role attribute of the client certificate, or "" if it has none.
// Fabric CA writes the attributes in an X.509 extension that only the issuing CA can set, so an
// identity cannot give itself a role.
func clientRole(ctx contractapi.TransactionContextInterface) (string, error) {
	role, _, err := ctx.GetClientIdentity().GetAttributeValue(AttrRole)
	if err != nil {
		return "", fmt.Errorf("could not read the certificate attributes: %w", err)
	}
	return role, nil
}

func requireRegulator(ctx contractapi.TransactionContextInterface) error {
	msp, err := clientMSP(ctx)
	if err != nil {
		return err
	}
	if msp != RegulatorMSP {
		return forbidden("only the regulator (%s) can do this, caller is %s", RegulatorMSP, msp)
	}
	return nil
}

// orgRole returns the role of an org in the registry, or "" if it is not registered.
func orgRole(ctx contractapi.TransactionContextInterface, msp string) (string, error) {
	var org Org
	found, err := getJSON(ctx, objOrg, []string{msp}, &org)
	if err != nil || !found {
		return "", err
	}
	return org.Role, nil
}

// nextRole is the only role a batch can be handed to from each role.
var nextRole = map[string]string{
	RoleManufacturer: RoleDistributor,
	RoleDistributor:  RolePharmacy,
}

// stateHeldBy is the state a batch takes when an org with that role receives it.
var stateHeldBy = map[string]string{
	RoleDistributor: StateInDistribution,
	RolePharmacy:    StateInPharmacy,
}

// ---------------------------------------------------------------- state

func key(ctx contractapi.TransactionContextInterface, objectType string, attrs []string) (string, error) {
	k, err := ctx.GetStub().CreateCompositeKey(objectType, attrs)
	if err != nil {
		return "", invalid("could not build the %s key: %v", objectType, err)
	}
	return k, nil
}

// getJSON reads a key and decodes it into out. It returns false if the key does not exist.
func getJSON(ctx contractapi.TransactionContextInterface, objectType string, attrs []string, out any) (bool, error) {
	k, err := key(ctx, objectType, attrs)
	if err != nil {
		return false, err
	}
	data, err := ctx.GetStub().GetState(k)
	if err != nil {
		return false, fmt.Errorf("could not read %s: %w", k, err)
	}
	if data == nil {
		return false, nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return false, fmt.Errorf("corrupt %s record: %w", objectType, err)
	}
	return true, nil
}

func putJSON(ctx contractapi.TransactionContextInterface, objectType string, attrs []string, value any) error {
	k, err := key(ctx, objectType, attrs)
	if err != nil {
		return err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(k, data)
}

func emit(ctx contractapi.TransactionContextInterface, name string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return ctx.GetStub().SetEvent(name, data)
}

// txTime is the timestamp the client put in the proposal. Chaincode must never use time.Now():
// every endorsing peer has to compute exactly the same result.
func txTime(ctx contractapi.TransactionContextInterface) (time.Time, error) {
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return time.Time{}, fmt.Errorf("could not read the transaction timestamp: %w", err)
	}
	return ts.AsTime().UTC(), nil
}

func txTimeString(ctx contractapi.TransactionContextInterface) (string, error) {
	t, err := txTime(ctx)
	if err != nil {
		return "", err
	}
	return t.Format(time.RFC3339), nil
}

// ---------------------------------------------------------------- endorsement

// setBatchEndorsement makes the batch key require the endorsement of its holder AND the
// regulator (state-based endorsement). From then on, a transaction that writes this batch is only
// valid if peers of both orgs signed it, whatever the chaincode-level policy says.
func setBatchEndorsement(ctx contractapi.TransactionContextInterface, batchKey, holderMSP string) error {
	ep, err := statebased.NewStateEP(nil)
	if err != nil {
		return err
	}
	orgs := []string{holderMSP}
	if holderMSP != RegulatorMSP {
		orgs = append(orgs, RegulatorMSP)
	}
	if err := ep.AddOrgs(statebased.RoleTypePeer, orgs...); err != nil {
		return err
	}
	policy, err := ep.Policy()
	if err != nil {
		return err
	}
	return ctx.GetStub().SetStateValidationParameter(batchKey, policy)
}
