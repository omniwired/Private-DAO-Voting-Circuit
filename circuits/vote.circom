pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/gates.circom";

template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component hashers[levels];
    component selectors[levels];
    component binaryCheckers[levels];
    
    signal currentLevel[levels + 1];
    currentLevel[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // Constrain pathIndices to be binary (0 or 1)
        binaryCheckers[i] = Num2Bits(1);
        binaryCheckers[i].in <== pathIndices[i];
        
        selectors[i] = MultiMux1(2);
        selectors[i].c[0][0] <== currentLevel[i];
        selectors[i].c[0][1] <== pathElements[i];
        selectors[i].c[1][0] <== pathElements[i];
        selectors[i].c[1][1] <== currentLevel[i];
        selectors[i].s <== pathIndices[i];
        
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== selectors[i].out[0];
        hashers[i].inputs[1] <== selectors[i].out[1];
        
        currentLevel[i + 1] <== hashers[i].out;
    }

    root === currentLevel[levels];
}


template CommitmentHasher() {
    signal input nullifier;
    signal input secret;
    signal output commitment;
    signal output nullifierHash;

    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== nullifier;
    commitmentHasher.inputs[1] <== secret;
    commitment <== commitmentHasher.out;

    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHash <== nullifierHasher.out;
}

template Vote(levels) {
    // Public inputs
    signal input root;
    signal input nullifierHash;
    signal input proposalId;
    signal input voteValue; // 0 = no, 1 = yes, 2 = abstain
    
    // Private inputs
    signal input nullifier;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // Verify vote value is valid (0, 1, or 2) using polynomial constraint
    voteValue * (voteValue - 1) * (voteValue - 2) === 0;

    // Ensure nullifier and secret are non-zero to prevent weak commitments
    component nullifierCheck = IsZero();
    nullifierCheck.in <== nullifier;
    nullifierCheck.out === 0; // Assert nullifier is NOT zero
    
    component secretCheck = IsZero();
    secretCheck.in <== secret;
    secretCheck.out === 0; // Assert secret is NOT zero

    // Ensure proposalId is non-zero to prevent invalid proposal references
    component proposalIdCheck = IsZero();
    proposalIdCheck.in <== proposalId;
    proposalIdCheck.out === 0; // Assert proposalId is NOT zero

    // Compute commitment and nullifier hash
    component hasher = CommitmentHasher();
    hasher.nullifier <== nullifier;
    hasher.secret <== secret;

    // Verify nullifier hash matches
    hasher.nullifierHash === nullifierHash;

    // Create the leaf for the merkle tree
    // The leaf includes the proposalId to ensure votes are proposal-specific
    component leafHasher = Poseidon(2);
    leafHasher.inputs[0] <== hasher.commitment;
    leafHasher.inputs[1] <== proposalId;

    // Verify merkle proof
    component tree = MerkleTreeChecker(levels);
    tree.leaf <== leafHasher.out;
    tree.root <== root;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

}

component main {public [root, nullifierHash, proposalId, voteValue]} = Vote(20);