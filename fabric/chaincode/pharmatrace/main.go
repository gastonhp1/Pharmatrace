// Command pharmatrace is the PharmaTrace chaincode for Hyperledger Fabric.
//
// It runs in one of two ways:
//
//   - Chaincode as a service (what fabric/network uses): set CHAINCODE_SERVER_ADDRESS and
//     CHAINCODE_ID and it listens for the peers. The chaincode is its own container, deployed and
//     upgraded like any other service, which is also how it runs on Kubernetes.
//   - Classic: without CHAINCODE_SERVER_ADDRESS it connects to the peer that launched it.
package main

import (
	"log"
	"os"
	"strconv"

	"github.com/gastonhp1/pharmatrace/fabric/chaincode/pharmatrace/contract"
	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

func main() {
	cc, err := contractapi.NewChaincode(&contract.PharmaTrace{})
	if err != nil {
		log.Panicf("could not create the chaincode: %v", err)
	}
	cc.Info.Title = "PharmaTrace"
	cc.Info.Version = "0.1.0"

	address := os.Getenv("CHAINCODE_SERVER_ADDRESS")
	if address == "" {
		if err := cc.Start(); err != nil {
			log.Panicf("could not start the chaincode: %v", err)
		}
		return
	}

	server := &shim.ChaincodeServer{
		CCID:     mustEnv("CHAINCODE_ID"),
		Address:  address,
		CC:       cc,
		TLSProps: tlsProperties(),
	}
	log.Printf("PharmaTrace chaincode listening on %s", address)
	if err := server.Start(); err != nil {
		log.Panicf("could not start the chaincode server: %v", err)
	}
}

// tlsProperties reads the chaincode server TLS settings. Local networks run without TLS between
// peer and chaincode (CHAINCODE_TLS_DISABLED=true, the default); in Kubernetes it should be on.
func tlsProperties() shim.TLSProperties {
	disabled, err := strconv.ParseBool(envOr("CHAINCODE_TLS_DISABLED", "true"))
	if err != nil {
		log.Panicf("CHAINCODE_TLS_DISABLED: %v", err)
	}
	if disabled {
		return shim.TLSProperties{Disabled: true}
	}
	props := shim.TLSProperties{
		Key:  mustRead(mustEnv("CHAINCODE_TLS_KEY")),
		Cert: mustRead(mustEnv("CHAINCODE_TLS_CERT")),
	}
	if ca := os.Getenv("CHAINCODE_CLIENT_CA_CERT"); ca != "" {
		props.ClientCACerts = mustRead(ca)
	}
	return props
}

func envOr(name, fallback string) string {
	if v, ok := os.LookupEnv(name); ok {
		return v
	}
	return fallback
}

func mustEnv(name string) string {
	v := os.Getenv(name)
	if v == "" {
		log.Panicf("%s is required", name)
	}
	return v
}

func mustRead(path string) []byte {
	data, err := os.ReadFile(path)
	if err != nil {
		log.Panicf("could not read %s: %v", path, err)
	}
	return data
}
