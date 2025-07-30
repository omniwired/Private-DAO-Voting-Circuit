// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IVerifier {
    function verifyProof(
        uint[2] memory a,
        uint[2][2] memory b,
        uint[2] memory c,
        uint[4] memory input
    ) external view returns (bool);
}

contract DAOVoting {
    IVerifier public immutable verifier;
    
    struct Proposal {
        string description;
        uint256 deadline;
        uint256 yesVotes;
        uint256 noVotes;
        uint256 abstainVotes;
        bool executed;
        mapping(uint256 => bool) nullifiers;
    }
    
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => bool) public usedNullifiers;
    
    uint256 public proposalCount;
    uint256 public immutable merkleRoot;
    
    event ProposalCreated(uint256 indexed proposalId, string description, uint256 deadline);
    event VoteCast(uint256 indexed proposalId, uint256 nullifierHash, uint8 vote);
    event ProposalExecuted(uint256 indexed proposalId);
    
    error InvalidProof();
    error ProposalDoesNotExist();
    error VotingEnded();
    error NullifierAlreadyUsed();
    error InvalidVoteValue();
    error ProposalAlreadyExecuted();
    
    constructor(address _verifier, uint256 _merkleRoot) {
        verifier = IVerifier(_verifier);
        merkleRoot = _merkleRoot;
    }
    
    function createProposal(string calldata description, uint256 duration) external returns (uint256) {
        uint256 proposalId = proposalCount++;
        Proposal storage proposal = proposals[proposalId];
        proposal.description = description;
        proposal.deadline = block.timestamp + duration;
        
        emit ProposalCreated(proposalId, description, proposal.deadline);
        return proposalId;
    }
    
    function vote(
        uint256 proposalId,
        uint256 nullifierHash,
        uint8 voteValue,
        uint[2] memory a,
        uint[2][2] memory b,
        uint[2] memory c
    ) external {
        if (proposalId >= proposalCount) revert ProposalDoesNotExist();
        if (voteValue > 2) revert InvalidVoteValue();
        
        Proposal storage proposal = proposals[proposalId];
        if (block.timestamp > proposal.deadline) revert VotingEnded();
        if (proposal.nullifiers[nullifierHash]) revert NullifierAlreadyUsed();
        
        // verify zk proof
        uint[4] memory input = [
            merkleRoot,
            nullifierHash,
            proposalId,
            voteValue
        ];
        
        if (!verifier.verifyProof(a, b, c, input)) revert InvalidProof();
        
        // mark nullifier as used
        proposal.nullifiers[nullifierHash] = true;
        usedNullifiers[nullifierHash] = true; // kinda redundant but w/e
        
        // tally votes
        if (voteValue == 0) {
            proposal.noVotes++;
        } else if (voteValue == 1) {
            proposal.yesVotes++;
        } else {
            // must be 2 (abstain)
            proposal.abstainVotes++;
        }
        
        emit VoteCast(proposalId, nullifierHash, voteValue);
    }
    
    function getProposalVotes(uint256 proposalId) external view returns (
        uint256 yes,
        uint256 no,
        uint256 abstain
    ) {
        if (proposalId >= proposalCount) revert ProposalDoesNotExist();
        Proposal storage proposal = proposals[proposalId];
        return (proposal.yesVotes, proposal.noVotes, proposal.abstainVotes);
    }
    
    function executeProposal(uint256 proposalId) external {
        if (proposalId >= proposalCount) revert ProposalDoesNotExist();
        Proposal storage proposal = proposals[proposalId];
        
        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (block.timestamp <= proposal.deadline) revert VotingEnded();
        
        proposal.executed = true;
        emit ProposalExecuted(proposalId);
        
        // TODO: actually do something here lol
        // rn just marks as executed
    }
}