const { ethers } = require("ethers");

// Merkle tree compatible with ColdChainMonitor.verifyReading: sibling pairs are hashed in
// sorted order, so a proof is just the list of siblings (no left/right flags). When a level has
// an odd number of nodes the last one is carried up unchanged, without duplicating it.

function hashPair(a, b) {
    return BigInt(a) <= BigInt(b)
        ? ethers.keccak256(ethers.concat([a, b]))
        : ethers.keccak256(ethers.concat([b, a]));
}

// leaves: array of 0x-prefixed 32-byte hashes. Returns { root, proof(index) }.
function buildTree(leaves) {
    if (!Array.isArray(leaves) || leaves.length === 0) {
        throw new Error("A Merkle tree needs at least one leaf");
    }

    const layers = [leaves.slice()];
    while (layers[layers.length - 1].length > 1) {
        const level = layers[layers.length - 1];
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
        }
        layers.push(next);
    }

    return {
        root: layers[layers.length - 1][0],
        proof(index) {
            if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
                throw new Error("Leaf index out of range");
            }
            const proof = [];
            let position = index;
            for (let depth = 0; depth < layers.length - 1; depth++) {
                const sibling = position ^ 1;
                if (sibling < layers[depth].length) proof.push(layers[depth][sibling]);
                position = Math.floor(position / 2);
            }
            return proof;
        },
    };
}

function verifyProof(leaf, proof, root) {
    let hash = leaf;
    for (const sibling of proof) hash = hashPair(hash, sibling);
    return hash.toLowerCase() === root.toLowerCase();
}

module.exports = { buildTree, verifyProof };
