var Web3 = require("web3");
var net = require("net");
var BigNumber = require("bignumber.js");
var async = require("async");

var web3 = new Web3(new Web3.providers.IpcProvider("/home/fjl/.ethereum/geth.ipc", net));
var contract = web3.eth.contract([{"anonymous":false,"inputs":[{"indexed":true,"name":"addr","type":"address"}],"name":"LogVote","type":"event"}]);
var yes = contract.at("0x3039d0a94d51c67a4f35e742b571874e53467804");
var no = contract.at("0x58dd96aa829353032a21c95733ce484b949b2849");

var blacklist = {
	'0xd94c9ff168dc6aebf9b6cc86deff54f3fb0afc33': "Yunbi",
	'0x2910543af39aba0cd09dbb2d50200b3e800a63d2': "Kraken",
	'0x32be343b94f860124dc4fee278fdcbd38c102d88': "Poloniex",
	'0xcafb10ee663f465f9d10588ac44ed20ed608c11e': "Bitfinex",
	'0x91337a300e0361bddb2e377dd4e88ccb7796663d': "BTC-e",
	'0xf4fe90e63f2a90710bcc0c00f38812c4a882f2ff': "BitcoinToYou",
	'0x120a270bbc009644e35f0bb6ab13f95b8199c4ad': "Shapeshift1",
	'0x9e6316f44baeeee5d41a1070516cc5fa47baf227': "Shapeshift2",
	'0x61c808d82a3ac53231750dadc13c777b59310bd9': "f2pool",
	'0x2a65aca4d5fc5b5c859090a6c34d164135398226': "DwarfPool1"
}

// Start counting at the creation blockNumber of yes contract, see
// http://etherscan.io/tx/0x81784fed3729b8865e90c9731167838efb14edd461599e06d9e570ece0c49980
//
// The no contract was created a few blocks later in
// http://etherscan.io/tx/0xf75f0e757bb683892b03af3e958bb657302462aaf53a89e18adf57df609037ab
var startBlock = 1836214;

function voteName(log) {
	if (log.address == yes.address)
		return "YES"
	else if (log.address == no.address)
		return "NO"
	else
		return log.address
}

function getVotes(voteName, contract, latestBlock, callback) {
	var filter = contract.LogVote({}, {
		fromBlock: startBlock,
		toBlock: latestBlock.number
	});
	filter.get((err, votes) => {
		console.log("found", votes.length, voteName, "votes");
		callback(err, votes);
	});
}

function sumVotes(block, yesVotes, noVotes, callback) {
	var totals = {
		yes: new BigNumber(0),
		no:  new BigNumber(0)
	}
	var earliest = {};

	function handleLog(vote, asyncDone) {
		var voter = vote.args.addr;

		// Ignore blacklisted voters.
		if (blacklist[voter]) {
			console.log("ignoring blacklisted vote", voteName(vote), "from", blacklist[voter], "at block", vote.blockNumber);
			return asyncDone();
		}

		// Prevent double votes.
		var prevVote = earliest[voter];
		if (prevVote && prevVote.blockNumber < vote.blockNumber) {
			console.log("ignoring double vote", voteName(vote), "from", voter, "at block", vote.blockNumber);
			console.log("	earlier vote was", voteName(prevVote), "at block", prevVote.blockNumber);
			return asyncDone();
		}
		earliest[voter] = vote;

		// Add the balance to the right bucket.
		web3.eth.getBalance(voter, block.number, function (err, balance) {
			if (err)
				return asyncDone(err);
			else if (vote.address == yes.address)
				totals.yes = totals.yes.add(balance);
			else if (vote.address == no.address)
				totals.no = totals.no.add(balance);
			else
				console.log("ignoring non-fork vote", vote);
			asyncDone();
		});
	}

	async.series([
		(cb) => async.eachLimit(yesVotes, 10, handleLog, cb),
		(cb) => async.eachLimit(noVotes, 10, handleLog, cb),
	], (err) => {
		callback(err, totals);
	});
}

function printVoteSum() {
	async.auto({
		latestBlock: (callback) => {
			web3.eth.getBlock("latest", callback);
		},
		yesVotes: ['latestBlock', (results, callback) => {
			getVotes("yes", yes, results.latestBlock, callback);
		}],
		noVotes: ['latestBlock', (results, callback) => {
			getVotes("no", no, results.latestBlock, callback);
		}],
		sum: ['latestBlock', 'yesVotes', 'noVotes', (results, callback) => {
			sumVotes(results.latestBlock, results.yesVotes, results.noVotes, callback);
		}],
	}, (err, results) => {
		if (err) {
			console.error(err);
			process.exit(1);
		} else {
			console.log("YES", web3.fromWei(results.sum.yes).toString(), "ether");
			console.log("NO ", web3.fromWei(results.sum.no).toString(), "ether");
			process.exit(0);
		}
	});
}

printVoteSum();
