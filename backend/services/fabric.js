const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const grpc = require("@grpc/grpc-js");
const { connect, hash, signers, GatewayError, CommitError, StatusCode } = require("@hyperledger/fabric-gateway");
const { ApiError } = require("../utils/errors");

// Connection to the PharmaTrace Fabric network through the Fabric Gateway: the client talks to
// one peer of its own org, and that peer gets the endorsements from the other orgs' peers and
// sends the transaction to the orderers.
//
// The API is custodial, like the EVM version was with its private keys: it holds one identity
// per org and acts with the one that has to act (the owner of a batch, the regulator for a
// recall...). In a real consortium each org runs its own API with only its identity; nothing
// below assumes otherwise except the list of identities it loads.

// Layout of fabric/network (crypto-config.yaml and compose.yaml).
const ORGS = {
    lab: { mspId: "LabMSP", domain: "lab.pharmatrace.ar", port: 7051 },
    dist: { mspId: "DistMSP", domain: "dist.pharmatrace.ar", port: 8051 },
    farma: { mspId: "FarmaMSP", domain: "farma.pharmatrace.ar", port: 9051 },
    reg: { mspId: "RegMSP", domain: "reg.pharmatrace.ar", port: 10051 },
};
const REGULATOR = "RegMSP";

function settings(env = process.env) {
    return {
        orgsDir: env.FABRIC_ORGS_DIR || path.join(__dirname, "../../fabric/network/organizations"),
        peerHost: env.FABRIC_PEER_HOST || "localhost",
        channel: env.FABRIC_CHANNEL || "pharmatrace",
        chaincode: env.FABRIC_CHAINCODE || "pharmatrace",
        user: env.FABRIC_USER || "User1",
    };
}

const orgKeyOf = (mspId) => Object.keys(ORGS).find((k) => ORGS[k].mspId === mspId);

// "dist:User2" -> { mspId: "DistMSP", user: "User2" }
function parseActor(spec) {
    const [org, user] = String(spec).split(":");
    if (!ORGS[org]) throw new Error(`Unknown org "${org}" in "${spec}": use one of ${Object.keys(ORGS).join(", ")}`);
    return { mspId: ORGS[org].mspId, user: user || settings().user };
}

const firstFile = (dir) => {
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith("."));
    if (files.length === 0) throw new Error(`No files in ${dir}`);
    return path.join(dir, files[0]);
};

// ---------------------------------------------------------------- connections

const gateways = new Map(); // "LabMSP/User1" -> { gateway, client, contract }

function open({ mspId, user }, env = process.env) {
    const id = `${mspId}/${user}`;
    if (gateways.has(id)) return gateways.get(id);

    const org = ORGS[orgKeyOf(mspId)];
    if (!org) throw new ApiError(403, `No Fabric identity is configured for ${mspId}`);
    const cfg = settings(env);
    const orgDir = path.join(cfg.orgsDir, "peerOrganizations", org.domain);
    const userMsp = path.join(orgDir, "users", `${user}@${org.domain}`, "msp");
    const peerHost = `peer0.${org.domain}`;

    let credentials, privateKey, tlsRoot;
    try {
        credentials = fs.readFileSync(firstFile(path.join(userMsp, "signcerts")));
        privateKey = crypto.createPrivateKey(fs.readFileSync(firstFile(path.join(userMsp, "keystore"))));
        tlsRoot = fs.readFileSync(path.join(orgDir, "peers", peerHost, "tls", "ca.crt"));
    } catch (err) {
        throw new ApiError(503, `Fabric identity ${user}@${org.domain} not found under ${cfg.orgsDir} (${err.code || err.message})`);
    }

    // FABRIC_PEER_ENDPOINT_<ORG> (e.g. FABRIC_PEER_ENDPOINT_DIST=peer0-dist:7051) overrides the
    // local default, for when the API runs next to the peers (Docker, Kubernetes).
    const endpoint = env[`FABRIC_PEER_ENDPOINT_${orgKeyOf(mspId).toUpperCase()}`] || `${cfg.peerHost}:${org.port}`;
    const client = new grpc.Client(endpoint, grpc.credentials.createSsl(tlsRoot), {
        "grpc.ssl_target_name_override": peerHost,
    });
    const gateway = connect({
        client,
        identity: { mspId, credentials },
        signer: signers.newPrivateKeySigner(privateKey),
        hash: hash.sha256,
        evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
        endorseOptions: () => ({ deadline: Date.now() + 15000 }),
        submitOptions: () => ({ deadline: Date.now() + 5000 }),
        commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });
    const entry = { gateway, client, contract: gateway.getNetwork(cfg.channel).getContract(cfg.chaincode) };
    gateways.set(id, entry);
    return entry;
}

function closeAll() {
    for (const { gateway, client } of gateways.values()) {
        gateway.close();
        client.close();
    }
    gateways.clear();
}

// ---------------------------------------------------------------- errors

const CODED = /\b(NOT_FOUND|FORBIDDEN|CONFLICT|INVALID): ([^\n]*)/;
const CODE_STATUS = { NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409, INVALID: 400 };
const statusName = (code) => Object.keys(StatusCode).find((k) => StatusCode[k] === code) || String(code);

// The chaincode starts the errors a client can act on with a code (see
// fabric/chaincode/pharmatrace/contract/errors.go). They come back inside the gateway's error,
// in the message of each endorsing peer.
function toApiError(err) {
    if (err instanceof ApiError) return err;

    if (err instanceof CommitError) {
        // Two transactions touched the same key at once: the second one is invalidated.
        if (err.code === StatusCode.MVCC_READ_CONFLICT) {
            return new ApiError(409, "Another transaction changed the same data at the same time; retry");
        }
        return new ApiError(500, `Transaction ${err.transactionId} was invalidated: ${statusName(err.code)}`);
    }

    if (err instanceof GatewayError || (err && Array.isArray(err.details))) {
        const texts = [err.message, ...(err.details || []).map((d) => d.message)];
        for (const text of texts) {
            const match = CODED.exec(text || "");
            if (match) return new ApiError(CODE_STATUS[match[1]], match[2]);
        }
        if (err.code === grpc.status.UNAVAILABLE || err.code === grpc.status.DEADLINE_EXCEEDED) {
            return new ApiError(503, "The Fabric network is not reachable");
        }
    }
    return null;
}

// ---------------------------------------------------------------- the ledger interface

const decoder = new TextDecoder();
function decode(bytes) {
    const text = decoder.decode(bytes);
    if (text === "") return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

const encodeTransient = (transient) =>
    transient
        ? Object.fromEntries(Object.entries(transient).map(([k, v]) => [k, Buffer.from(typeof v === "string" ? v : JSON.stringify(v))]))
        : undefined;

// What the services use. `actor` is { mspId, user? }. Arguments are strings or anything
// JSON-serializable (objects and arrays become JSON, as the contract API expects).
function createLedger(env = process.env) {
    const actorOf = ({ mspId, user }) => ({ mspId, user: user || settings(env).user });
    const args = (list) => list.map((a) => (typeof a === "string" ? a : JSON.stringify(a)));

    async function run(fn) {
        try {
            return await fn();
        } catch (err) {
            throw toApiError(err) || err;
        }
    }

    return {
        evaluate(actor, name, list = [], { transient } = {}) {
            return run(async () => {
                const { contract } = open(actorOf(actor), env);
                return decode(await contract.evaluate(name, { arguments: args(list), transientData: encodeTransient(transient) }));
            });
        },
        // endorsingOrgs: whose peers must sign. Naming them makes the endorsement deterministic
        // and is required for private data, whose transient values must only reach members.
        submit(actor, name, list = [], { endorsingOrgs, transient } = {}) {
            return run(async () => {
                const { contract } = open(actorOf(actor), env);
                return decode(
                    await contract.submit(name, {
                        arguments: args(list),
                        transientData: encodeTransient(transient),
                        endorsingOrganizations: endorsingOrgs,
                    })
                );
            });
        },
    };
}

module.exports = { ORGS, REGULATOR, orgKeyOf, parseActor, createLedger, toApiError, closeAll, settings };
