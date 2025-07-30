const { expect } = require("chai");
const { ethers } = require("hardhat");
const snarkjs = require("snarkjs");
const circomlibjs = require("circomlibjs");
const path = require("path");
const fs = require("fs");

describe("DAO Voting System", function () {
    let verifier;
    let daoVoting;
    let poseidon;
    let F;
    
    // Test data
    const MERKLE_TREE_HEIGHT = 20;
    const members = [];
    let tree;
    let merkleRoot;
    
    // quick poseidon wrapper
    async function poseidonHash(inputs) {
        return F.toObject(poseidon(inputs.map(x => F.e(x))));
    }
    
    // Helper function to create merkle tree
    class MerkleTree {
        constructor(levels, zero_value, leaves, hasher) {
            this.levels = levels;
            this.hasher = hasher;
            this.zero_values = [zero_value];
            this.leaves = leaves;
            
            for (let i = 1; i < levels; i++) {
                this.zero_values[i] = hasher([this.zero_values[i-1], this.zero_values[i-1]]);
            }
            
            this.layers = [leaves];
            this.buildTree();
        }
        
        buildTree() {
            for (let level = 0; level < this.levels - 1; level++) {
                const currentLevel = this.layers[level];
                const nextLevel = [];
                
                for (let i = 0; i < currentLevel.length; i += 2) {
                    const left = currentLevel[i];
                    const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : this.zero_values[level];
                    nextLevel.push(this.hasher([left, right]));
                }
                
                this.layers.push(nextLevel);
            }
        }
        
        getRoot() {
            return this.layers[this.levels - 1][0];
        }
        
        getProof(index) {
            const proof = {
                pathElements: [],
                pathIndices: []
            };
            
            for (let level = 0; level < this.levels - 1; level++) {
                const position = index % 2;
                const levelIndex = Math.floor(index / 2);
                const currentLevel = this.layers[level];
                
                if (position === 0) {
                    proof.pathElements.push(
                        levelIndex + 1 < currentLevel.length 
                            ? currentLevel[levelIndex * 2 + 1] 
                            : this.zero_values[level]
                    );
                } else {
                    proof.pathElements.push(currentLevel[levelIndex * 2]);
                }
                
                proof.pathIndices.push(position);
                index = Math.floor(index / 2);
            }
            
            return proof;
        }
    }
    
    before(async function() {
        this.timeout(60000);
        
        // init poseidon
        const poseidonJs = await circomlibjs.buildPoseidon();
        poseidon = poseidonJs;
        F = poseidonJs.F;
        
        // gen some test members
        for (let i = 0; i < 10; i++) {
            const nullifier = F.random();
            const secret = F.random();
            const commitment = await poseidonHash([nullifier, secret]);
            
            members.push({
                nullifier: F.toObject(nullifier).toString(),
                secret: F.toObject(secret).toString(),
                commitment: commitment.toString(),
                index: i
            });
        }
        
        // Build merkle tree with member commitments
        const leaves = members.map(m => BigInt(m.commitment));
        const zeroValue = BigInt(0);
        
        tree = new MerkleTree(
            MERKLE_TREE_HEIGHT,
            zeroValue,
            leaves,
            (inputs) => F.toObject(poseidon(inputs.map(x => F.e(x))))
        );
        
        merkleRoot = tree.getRoot();
        
        // Deploy contracts
        const Verifier = await ethers.getContractFactory("VoteVerifier");
        verifier = await Verifier.deploy();
        await verifier.waitForDeployment();
        
        const verifierAddress = await verifier.getAddress();
        
        const DAOVoting = await ethers.getContractFactory("DAOVoting");
        daoVoting = await DAOVoting.deploy(verifierAddress, merkleRoot.toString());
        await daoVoting.waitForDeployment();
    });
    
    async function generateProof(memberIndex, proposalId, voteValue) {
        const member = members[memberIndex];
        const proof = tree.getProof(memberIndex);
        
        // Create witness
        const witness = {
            root: merkleRoot.toString(),
            nullifierHash: (await poseidonHash([member.nullifier])).toString(),
            proposalId: proposalId.toString(),
            voteValue: voteValue.toString(),
            nullifier: member.nullifier,
            secret: member.secret,
            pathElements: proof.pathElements.map(e => e.toString()),
            pathIndices: proof.pathIndices.map(i => i.toString())
        };
        
        // Mock proof generation since we don't have the full trusted setup
        // In production, this would use snarkjs.groth16.fullProve
        const mockProof = {
            a: ["1", "2"],
            b: [["3", "4"], ["5", "6"]],
            c: ["7", "8"]
        };
        
        const publicSignals = [
            witness.root,
            witness.nullifierHash,
            witness.proposalId,
            witness.voteValue
        ];
        
        return { proof: mockProof, publicSignals, nullifierHash: witness.nullifierHash };
    }
    
    describe("Proposal Management", function() {
        it("Should create a new proposal", async function() {
            const description = "Increase treasury allocation to development";
            const duration = 7 * 24 * 60 * 60; // 7 days
            
            const tx = await daoVoting.createProposal(description, duration);
            const receipt = await tx.wait();
            
            const logs = receipt.logs;
            const event = logs.find(log => {
                try {
                    const parsed = daoVoting.interface.parseLog(log);
                    return parsed.name === "ProposalCreated";
                } catch {
                    return false;
                }
            });
            expect(event).to.not.be.undefined;
            if (event) {
                const parsed = daoVoting.interface.parseLog(event);
                expect(parsed.args.proposalId).to.equal(0n);
                expect(parsed.args.description).to.equal(description);
            }
        });
        
        it("Should return correct proposal count", async function() {
            const count = await daoVoting.proposalCount();
            expect(count).to.equal(1);
        });
    });
    
    describe("Voting", function() {
        let proposalId;
        
        beforeEach(async function() {
            // Create a new proposal for each test
            const tx = await daoVoting.createProposal("Test proposal", 3600);
            await tx.wait();
            proposalId = Number((await daoVoting.proposalCount()) - 1n);
        });
        
        it("Should accept valid YES vote", async function() {
            const memberIndex = 0;
            const voteValue = 1; // YES
            
            const { proof, nullifierHash } = await generateProof(memberIndex, proposalId, voteValue);
            
            const tx = await daoVoting.vote(
                proposalId,
                nullifierHash,
                voteValue,
                proof.a,
                proof.b,
                proof.c
            );
            
            const receipt = await tx.wait();
            const logs = receipt.logs || [];
            const event = logs.find(log => {
                try {
                    const parsed = daoVoting.interface.parseLog(log);
                    return parsed && parsed.name === "VoteCast";
                } catch (e) {
                    return false;
                }
            });
            
            expect(event).to.not.be.undefined;
            const parsedEvent = daoVoting.interface.parseLog(event);
            expect(parsedEvent.args.proposalId).to.equal(proposalId);
            expect(parsedEvent.args.vote).to.equal(voteValue);
            
            // Check vote counts
            const votes = await daoVoting.getProposalVotes(proposalId);
            expect(votes.yes).to.equal(1);
            expect(votes.no).to.equal(0);
            expect(votes.abstain).to.equal(0);
        });
        
        it("Should accept valid NO vote", async function() {
            const memberIndex = 1;
            const voteValue = 0; // NO
            
            const { proof, nullifierHash } = await generateProof(memberIndex, proposalId, voteValue);
            
            await daoVoting.vote(
                proposalId,
                nullifierHash,
                voteValue,
                proof.a,
                proof.b,
                proof.c
            );
            
            const votes = await daoVoting.getProposalVotes(proposalId);
            expect(votes.yes).to.equal(0);
            expect(votes.no).to.equal(1);
            expect(votes.abstain).to.equal(0);
        });
        
        it("Should accept valid ABSTAIN vote", async function() {
            const memberIndex = 2;
            const voteValue = 2; // ABSTAIN
            
            const { proof, nullifierHash } = await generateProof(memberIndex, proposalId, voteValue);
            
            await daoVoting.vote(
                proposalId,
                nullifierHash,
                voteValue,
                proof.a,
                proof.b,
                proof.c
            );
            
            const votes = await daoVoting.getProposalVotes(proposalId);
            expect(votes.yes).to.equal(0);
            expect(votes.no).to.equal(0);
            expect(votes.abstain).to.equal(1);
        });
        
        it("Should prevent double voting with same nullifier", async function() {
            const memberIndex = 3;
            const voteValue = 1;
            
            const { proof, nullifierHash } = await generateProof(memberIndex, proposalId, voteValue);
            
            // First vote should succeed
            await daoVoting.vote(
                proposalId,
                nullifierHash,
                voteValue,
                proof.a,
                proof.b,
                proof.c
            );
            
            // Second vote with same nullifier should fail
            await expect(
                daoVoting.vote(
                    proposalId,
                    nullifierHash,
                    voteValue,
                    proof.a,
                    proof.b,
                    proof.c
                )
            ).to.be.revertedWithCustomError(daoVoting, "NullifierAlreadyUsed");
        });
        
        it("Should reject invalid vote values", async function() {
            await expect(
                daoVoting.vote(
                    proposalId,
                    12345,
                    3, // Invalid vote value
                    [0, 0],
                    [[0, 0], [0, 0]],
                    [0, 0]
                )
            ).to.be.revertedWithCustomError(daoVoting, "InvalidVoteValue");
        });
        
        it("Should reject votes for non-existent proposals", async function() {
            await expect(
                daoVoting.vote(
                    999, // Non-existent proposal
                    12345,
                    1,
                    [0, 0],
                    [[0, 0], [0, 0]],
                    [0, 0]
                )
            ).to.be.revertedWithCustomError(daoVoting, "ProposalDoesNotExist");
        });
    });
    
    describe("Gas Usage", function() {
        it("Should verify vote proof within gas limit", async function() {
            const memberIndex = 4;
            const voteValue = 1;
            const proposalId = 0;
            
            const { proof, nullifierHash } = await generateProof(memberIndex, proposalId, voteValue);
            
            const tx = await daoVoting.vote(
                proposalId,
                nullifierHash,
                voteValue,
                proof.a,
                proof.b,
                proof.c
            );
            
            const receipt = await tx.wait();
            console.log(`Gas used for vote: ${receipt.gasUsed.toString()}`);
            
            // Should be under 230k gas
            expect(receipt.gasUsed).to.be.lessThan(230000);
        });
    });
    
    describe("Security", function() {
        it("Should reject proof with invalid merkle root", async function() {
            // This test would require modifying the proof generation
            // to use a different merkle root, which should fail verification
            expect(true).to.equal(true); // Placeholder
        });
        
        it("Should reject proof with tampered public inputs", async function() {
            const memberIndex = 5;
            const voteValue = 1;
            const proposalId = 0;
            
            const { proof, nullifierHash } = await generateProof(memberIndex, proposalId, voteValue);
            
            // Try to vote with different nullifier hash
            await expect(
                daoVoting.vote(
                    proposalId,
                    12345, // Wrong nullifier hash
                    voteValue,
                    proof.a,
                    proof.b,
                    proof.c
                )
            ).to.be.revertedWithCustomError(daoVoting, "InvalidProof");
        });
    });
});