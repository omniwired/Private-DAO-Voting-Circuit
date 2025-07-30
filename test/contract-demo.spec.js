const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("DAO Voting Contract Demo", function () {
    let verifier;
    let daoVoting;
    let owner;
    let addr1;
    
    // Mock merkle root for testing
    const MOCK_MERKLE_ROOT = "21663839004416932945382355908790599225266501822907911457504978515578255421292";
    
    before(async function() {
        [owner, addr1] = await ethers.getSigners();
    });
    
    describe("Contract Deployment", function() {
        it("Should deploy VoteVerifier contract", async function() {
            const VoteVerifier = await ethers.getContractFactory("Groth16Verifier");
            verifier = await VoteVerifier.deploy();
            await verifier.waitForDeployment();
            
            const address = await verifier.getAddress();
            expect(address).to.not.be.null;
            expect(address).to.match(/^0x[a-fA-F0-9]{40}$/);
            
            // TODO: check version when we add it to the verifier
            // const version = await verifier.version();
            // expect(version).to.equal("MockVerifier-1.0");
        });
        
        it("Should deploy DAOVoting contract", async function() {
            const verifierAddress = await verifier.getAddress();
            
            const DAOVoting = await ethers.getContractFactory("DAOVoting");
            daoVoting = await DAOVoting.deploy(verifierAddress, MOCK_MERKLE_ROOT);
            await daoVoting.waitForDeployment();
            
            const address = await daoVoting.getAddress();
            expect(address).to.not.be.null;
            expect(address).to.match(/^0x[a-fA-F0-9]{40}$/);
        });
        
        it("Should have correct initial state", async function() {
            const merkleRoot = await daoVoting.merkleRoot();
            expect(merkleRoot).to.equal(MOCK_MERKLE_ROOT);
            
            const proposalCount = await daoVoting.proposalCount();
            expect(proposalCount).to.equal(0n);
            
            const verifierAddr = await daoVoting.verifier();
            expect(verifierAddr).to.equal(await verifier.getAddress());
        });
    });
    
    describe("Proposal Management", function() {
        it("Should create a proposal", async function() {
            const description = "Test Proposal";
            const duration = 3600; // 1 hour
            
            const tx = await daoVoting.createProposal(description, duration);
            const receipt = await tx.wait();
            
            expect(receipt.status).to.equal(1);
            
            const proposalCount = await daoVoting.proposalCount();
            expect(proposalCount).to.equal(1n);
            
            // Check proposal data
            const proposal = await daoVoting.proposals(0);
            expect(proposal.description).to.equal(description);
            expect(proposal.executed).to.be.false;
        });
        
        it("Should create multiple proposals", async function() {
            const tx1 = await daoVoting.createProposal("Proposal 2", 3600);
            const tx2 = await daoVoting.createProposal("Proposal 3", 3600);
            
            await tx1.wait();
            await tx2.wait();
            
            const proposalCount = await daoVoting.proposalCount();
            expect(proposalCount).to.equal(3n);
        });
    });
    
    describe("Voting Mechanism", function() {
        it("Should accept valid vote with mock proof", async function() {
            const proposalId = 0;
            const nullifierHash = "12345678901234567890123456789012345678901234567890123456789012345";
            const voteValue = 1; // YES
            
            // mock proof - real one would come from snarkjs but this is just for testing
            const mockProof = {
                a: [1, 2],
                b: [[3, 4], [5, 6]],
                c: [7, 8]
            };
            
            const tx = await daoVoting.vote(
                proposalId,
                nullifierHash,
                voteValue,
                mockProof.a,
                mockProof.b,
                mockProof.c
            );
            
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);
            
            // Check vote was recorded
            const votes = await daoVoting.getProposalVotes(proposalId);
            expect(votes.yes).to.equal(1n);
            expect(votes.no).to.equal(0n);
            expect(votes.abstain).to.equal(0n);
        });
        
        it("Should prevent double voting", async function() {
            const proposalId = 0;
            const nullifierHash = "12345678901234567890123456789012345678901234567890123456789012345";
            const voteValue = 1;
            
            const mockProof = {
                a: [1, 2],
                b: [[3, 4], [5, 6]],
                c: [7, 8]
            };
            
            // Second vote with same nullifier should fail
            await expect(
                daoVoting.vote(
                    proposalId,
                    nullifierHash,
                    voteValue,
                    mockProof.a,
                    mockProof.b,
                    mockProof.c
                )
            ).to.be.revertedWithCustomError(daoVoting, "NullifierAlreadyUsed");
        });
        
        it("Should track different vote types", async function() {
            const proposalId = 1; // Use second proposal
            
            // Vote YES
            await daoVoting.vote(
                proposalId,
                "11111111111111111111111111111111111111111111111111111111111111111",
                1, // YES
                [1, 2],
                [[3, 4], [5, 6]],
                [7, 8]
            );
            
            // Vote NO
            await daoVoting.vote(
                proposalId,
                "22222222222222222222222222222222222222222222222222222222222222222",
                0, // NO
                [1, 2],
                [[3, 4], [5, 6]],
                [7, 8]
            );
            
            // Vote ABSTAIN
            await daoVoting.vote(
                proposalId,
                "33333333333333333333333333333333333333333333333333333333333333333",
                2, // ABSTAIN
                [1, 2],
                [[3, 4], [5, 6]],
                [7, 8]
            );
            
            const votes = await daoVoting.getProposalVotes(proposalId);
            expect(votes.yes).to.equal(1n);
            expect(votes.no).to.equal(1n);
            expect(votes.abstain).to.equal(1n);
        });
    });
    
    describe("Error Handling", function() {
        it("Should reject invalid vote values", async function() {
            await expect(
                daoVoting.vote(
                    0,
                    "99999999999999999999999999999999999999999999999999999999999999999",
                    3, // Invalid vote value
                    [1, 2],
                    [[3, 4], [5, 6]],
                    [7, 8]
                )
            ).to.be.revertedWithCustomError(daoVoting, "InvalidVoteValue");
        });
        
        it("Should reject votes for non-existent proposals", async function() {
            await expect(
                daoVoting.vote(
                    999, // Non-existent proposal
                    "88888888888888888888888888888888888888888888888888888888888888888",
                    1,
                    [1, 2],
                    [[3, 4], [5, 6]],
                    [7, 8]
                )
            ).to.be.revertedWithCustomError(daoVoting, "ProposalDoesNotExist");
        });
    });
    
    describe("Gas Usage", function() {
        it("Should track gas usage for operations", async function() {
            // Create proposal
            const createTx = await daoVoting.createProposal("Gas Test", 3600);
            const createReceipt = await createTx.wait();
            console.log(`      Gas for proposal creation: ${createReceipt.gasUsed.toString()}`);
            
            // Cast vote
            const voteTx = await daoVoting.vote(
                await daoVoting.proposalCount() - 1n,
                "77777777777777777777777777777777777777777777777777777777777777777",
                1,
                [1, 2],
                [[3, 4], [5, 6]],
                [7, 8]
            );
            const voteReceipt = await voteTx.wait();
            console.log(`      Gas for vote casting: ${voteReceipt.gasUsed.toString()}`);
            
            // Note: With mock verifier, gas usage is lower than production
            expect(voteReceipt.gasUsed).to.be.below(150000n);
        });
    });
});