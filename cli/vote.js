#!/usr/bin/env node

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');
const circomlibjs = require('circomlibjs');
const { ethers } = require('ethers');

const program = new Command();

// Configuration
const CONFIG = {
    rpcUrl: process.env.RPC_URL || 'http://localhost:8545',
    contractAddress: process.env.DAO_VOTING_ADDRESS,
    merkleTreeHeight: 20,
    membersFile: path.join(__dirname, '../data/members.json'),
    votesFile: path.join(__dirname, '../data/votes.json')
};

// Helper functions
async function loadMembers() {
    if (!fs.existsSync(CONFIG.membersFile)) {
        return [];
    }
    return JSON.parse(fs.readFileSync(CONFIG.membersFile, 'utf8'));
}

async function saveMembers(members) {
    const dir = path.dirname(CONFIG.membersFile);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG.membersFile, JSON.stringify(members, null, 2));
}

async function initPoseidon() {
    const poseidonJs = await circomlibjs.buildPoseidon();
    return poseidonJs;
}

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

// Commands
program
    .name('dao-vote')
    .description('CLI for private DAO voting')
    .version('1.0.0');

program
    .command('generate-member')
    .description('Generate a new DAO member identity')
    .option('-n, --name <name>', 'Member name')
    .action(async (options) => {
        console.log('🔑 Generating new member identity...');
        
        const poseidonJs = await initPoseidon();
        const F = poseidonJs.F;
        const poseidon = poseidonJs;
        
        const nullifier = F.random();
        const secret = F.random();
        const commitment = F.toObject(poseidon([nullifier, secret]));
        
        const member = {
            name: options.name || `Member-${Date.now()}`,
            nullifier: F.toObject(nullifier).toString(),
            secret: F.toObject(secret).toString(),
            commitment: commitment.toString(),
            createdAt: new Date().toISOString()
        };
        
        const members = await loadMembers();
        member.index = members.length;
        members.push(member);
        await saveMembers(members);
        
        console.log('✅ Member generated successfully!');
        console.log(`Name: ${member.name}`);
        console.log(`Index: ${member.index}`);
        console.log(`Commitment: ${member.commitment}`);
        console.log('\n⚠️  Keep your nullifier and secret safe!');
    });

program
    .command('list-members')
    .description('List all DAO members')
    .action(async () => {
        const members = await loadMembers();
        
        if (members.length === 0) {
            console.log('No members found. Generate some with: dao-vote generate-member');
            return;
        }
        
        console.log('📋 DAO Members:\n');
        members.forEach(member => {
            console.log(`[${member.index}] ${member.name}`);
            console.log(`    Commitment: ${member.commitment}`);
            console.log(`    Created: ${member.createdAt}\n`);
        });
    });

program
    .command('cast')
    .description('Cast a vote on a proposal')
    .requiredOption('-p, --proposal <id>', 'Proposal ID', parseInt)
    .requiredOption('-v, --vote <value>', 'Vote value (yes/no/abstain)')
    .requiredOption('-m, --member <index>', 'Member index', parseInt)
    .action(async (options) => {
        console.log('🗳️  Casting vote...\n');
        
        // Validate vote value
        const voteMap = { 'no': 0, 'yes': 1, 'abstain': 2 };
        if (!voteMap.hasOwnProperty(options.vote.toLowerCase())) {
            console.error('❌ Invalid vote value. Use: yes, no, or abstain');
            process.exit(1);
        }
        const voteValue = voteMap[options.vote.toLowerCase()];
        
        // Load member data
        const members = await loadMembers();
        if (options.member >= members.length) {
            console.error('❌ Invalid member index');
            process.exit(1);
        }
        const member = members[options.member];
        
        // Initialize Poseidon
        const poseidonJs = await initPoseidon();
        const F = poseidonJs.F;
        const poseidon = poseidonJs;
        
        // Build merkle tree
        const leaves = members.map(m => BigInt(m.commitment));
        const tree = new MerkleTree(
            CONFIG.merkleTreeHeight,
            BigInt(0),
            leaves,
            (inputs) => F.toObject(poseidon(inputs.map(x => F.e(x))))
        );
        
        const merkleRoot = tree.getRoot();
        const proof = tree.getProof(options.member);
        
        // Generate nullifier hash
        const nullifierHash = F.toObject(poseidon([F.e(member.nullifier)]));
        
        // Create witness
        const witness = {
            root: merkleRoot.toString(),
            nullifierHash: nullifierHash.toString(),
            proposalId: options.proposal.toString(),
            voteValue: voteValue.toString(),
            nullifier: member.nullifier,
            secret: member.secret,
            pathElements: proof.pathElements.map(e => e.toString()),
            pathIndices: proof.pathIndices.map(i => i.toString())
        };
        
        console.log('📝 Vote details:');
        console.log(`   Member: ${member.name}`);
        console.log(`   Proposal: ${options.proposal}`);
        console.log(`   Vote: ${options.vote.toUpperCase()}`);
        console.log(`   Nullifier Hash: ${nullifierHash}`);
        
        // Generate proof
        console.log('\n🔐 Generating zero-knowledge proof...');
        
        const wasmPath = path.join(__dirname, '../build/vote_js/vote.wasm');
        const zkeyPath = path.join(__dirname, '../build/vote.zkey');
        
        if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
            console.error('❌ Circuit not compiled. Run: npm run compile');
            process.exit(1);
        }
        
        const { proof: snarkProof, publicSignals } = await snarkjs.groth16.fullProve(
            witness,
            wasmPath,
            zkeyPath
        );
        
        console.log('✅ Proof generated successfully!');
        
        // Save vote data
        const votesDir = path.dirname(CONFIG.votesFile);
        if (!fs.existsSync(votesDir)) {
            fs.mkdirSync(votesDir, { recursive: true });
        }
        
        const voteData = {
            proposalId: options.proposal,
            memberName: member.name,
            memberIndex: options.member,
            vote: options.vote,
            nullifierHash: nullifierHash.toString(),
            proof: {
                a: [snarkProof.pi_a[0], snarkProof.pi_a[1]],
                b: [[snarkProof.pi_b[0][1], snarkProof.pi_b[0][0]], 
                    [snarkProof.pi_b[1][1], snarkProof.pi_b[1][0]]],
                c: [snarkProof.pi_c[0], snarkProof.pi_c[1]]
            },
            timestamp: new Date().toISOString()
        };
        
        const votes = fs.existsSync(CONFIG.votesFile) 
            ? JSON.parse(fs.readFileSync(CONFIG.votesFile, 'utf8'))
            : [];
        votes.push(voteData);
        fs.writeFileSync(CONFIG.votesFile, JSON.stringify(votes, null, 2));
        
        console.log('\n📄 Vote proof saved to:', CONFIG.votesFile);
        
        // If contract address is set, submit to blockchain
        if (CONFIG.contractAddress) {
            console.log('\n📡 Submitting vote to blockchain...');
            // Contract interaction code would go here
            console.log('⚠️  Contract submission not implemented in demo');
        }
    });

program
    .command('verify')
    .description('Verify a vote proof')
    .requiredOption('-i, --index <index>', 'Vote index in votes.json', parseInt)
    .action(async (options) => {
        console.log('🔍 Verifying vote proof...\n');
        
        const votes = fs.existsSync(CONFIG.votesFile) 
            ? JSON.parse(fs.readFileSync(CONFIG.votesFile, 'utf8'))
            : [];
            
        if (options.index >= votes.length) {
            console.error('❌ Invalid vote index');
            process.exit(1);
        }
        
        const vote = votes[options.index];
        
        // Load verification key
        const vkeyPath = path.join(__dirname, '../build/verification_key.json');
        if (!fs.existsSync(vkeyPath)) {
            console.error('❌ Verification key not found. Run: npm run compile');
            process.exit(1);
        }
        
        const vKey = JSON.parse(fs.readFileSync(vkeyPath, 'utf8'));
        
        // Reconstruct public signals
        const members = await loadMembers();
        const poseidonJs = await initPoseidon();
        const F = poseidonJs.F;
        const poseidon = poseidonJs;
        
        const leaves = members.map(m => BigInt(m.commitment));
        const tree = new MerkleTree(
            CONFIG.merkleTreeHeight,
            BigInt(0),
            leaves,
            (inputs) => F.toObject(poseidon(inputs.map(x => F.e(x))))
        );
        
        const merkleRoot = tree.getRoot();
        const voteValueMap = { 'no': 0, 'yes': 1, 'abstain': 2 };
        
        const publicSignals = [
            merkleRoot.toString(),
            vote.nullifierHash,
            vote.proposalId.toString(),
            voteValueMap[vote.vote].toString()
        ];
        
        // Verify proof
        const isValid = await snarkjs.groth16.verify(vKey, publicSignals, vote.proof);
        
        console.log('📋 Vote details:');
        console.log(`   Proposal: ${vote.proposalId}`);
        console.log(`   Member: ${vote.memberName}`);
        console.log(`   Vote: ${vote.vote.toUpperCase()}`);
        console.log(`   Timestamp: ${vote.timestamp}`);
        console.log(`\n🔐 Proof verification: ${isValid ? '✅ VALID' : '❌ INVALID'}`);
    });

program
    .command('tally')
    .description('Tally votes for a proposal')
    .requiredOption('-p, --proposal <id>', 'Proposal ID', parseInt)
    .action(async (options) => {
        console.log(`📊 Tallying votes for proposal ${options.proposal}...\n`);
        
        const votes = fs.existsSync(CONFIG.votesFile) 
            ? JSON.parse(fs.readFileSync(CONFIG.votesFile, 'utf8'))
            : [];
            
        const proposalVotes = votes.filter(v => v.proposalId === options.proposal);
        
        if (proposalVotes.length === 0) {
            console.log('No votes found for this proposal');
            return;
        }
        
        const tally = {
            yes: 0,
            no: 0,
            abstain: 0
        };
        
        const nullifiers = new Set();
        
        proposalVotes.forEach(vote => {
            // Check for duplicate nullifiers (double voting)
            if (nullifiers.has(vote.nullifierHash)) {
                console.log(`⚠️  Duplicate vote detected from ${vote.memberName}`);
                return;
            }
            nullifiers.add(vote.nullifierHash);
            
            tally[vote.vote]++;
        });
        
        console.log('🗳️  Vote Results:');
        console.log(`   YES:     ${tally.yes} votes`);
        console.log(`   NO:      ${tally.no} votes`);
        console.log(`   ABSTAIN: ${tally.abstain} votes`);
        console.log(`   TOTAL:   ${tally.yes + tally.no + tally.abstain} votes`);
        
        const total = tally.yes + tally.no;
        if (total > 0) {
            const yesPercentage = (tally.yes / total * 100).toFixed(1);
            console.log(`\n📈 Approval rate: ${yesPercentage}% (excluding abstentions)`);
        }
    });

program.parse();