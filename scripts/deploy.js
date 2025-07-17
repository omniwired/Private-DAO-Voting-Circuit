const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
    console.log("🚀 Starting deployment...\n");
    
    // Get the contract factories
    const VoteVerifier = await ethers.getContractFactory("VoteVerifier");
    const DAOVoting = await ethers.getContractFactory("DAOVoting");
    
    // Load members to get merkle root
    const membersFile = path.join(__dirname, "../data/members.json");
    let merkleRoot = "0";
    
    if (fs.existsSync(membersFile)) {
        const members = JSON.parse(fs.readFileSync(membersFile, 'utf8'));
        if (members.length > 0) {
            // In a real deployment, you'd compute the actual merkle root
            // For now, we'll use a placeholder
            merkleRoot = "21663839004416932945382355908790599225266501822907911457504978515578255421292";
            console.log(`📋 Found ${members.length} members in registry`);
        }
    } else {
        console.log("⚠️  No members found. Using empty merkle root.");
    }
    
    // Deploy VoteVerifier
    console.log("📝 Deploying VoteVerifier...");
    const verifier = await VoteVerifier.deploy();
    await verifier.deployed();
    console.log(`✅ VoteVerifier deployed to: ${verifier.address}`);
    
    // Deploy DAOVoting
    console.log("📝 Deploying DAOVoting...");
    const daoVoting = await DAOVoting.deploy(verifier.address, merkleRoot);
    await daoVoting.deployed();
    console.log(`✅ DAOVoting deployed to: ${daoVoting.address}`);
    
    // Save deployment info
    const deploymentInfo = {
        network: await ethers.provider.getNetwork(),
        contracts: {
            VoteVerifier: {
                address: verifier.address,
                transactionHash: verifier.deployTransaction.hash
            },
            DAOVoting: {
                address: daoVoting.address,
                transactionHash: daoVoting.deployTransaction.hash
            }
        },
        merkleRoot: merkleRoot,
        deployedAt: new Date().toISOString()
    };
    
    const deploymentFile = path.join(__dirname, "../deployment.json");
    fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
    
    console.log("\n🎉 Deployment completed successfully!");
    console.log("📄 Deployment info saved to:", deploymentFile);
    console.log("\nContract addresses:");
    console.log(`   VoteVerifier: ${verifier.address}`);
    console.log(`   DAOVoting: ${daoVoting.address}`);
}

main().catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
});