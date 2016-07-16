var Web3 = require("web3");
var net = require("net");
var BigNumber = require("bignumber.js");
var async = require("async");
var https = require("https");

var web3 = new Web3(new Web3.providers.IpcProvider("/home/fjl/.ethereum/geth.ipc", net));
var contract = web3.eth.contract([{"anonymous":false,"inputs":[{"indexed":true,"name":"addr","type":"address"}],"name":"LogVote","type":"event"}]);
var yes = contract.at("0x3039d0a94d51c67a4f35e742b571874e53467804");
var no = contract.at("0x58dd96aa829353032a21c95733ce484b949b2849");

var blacklist = {
	"0xd94c9ff168dc6aebf9b6cc86deff54f3fb0afc33": "Yunbi",
	"0x2910543af39aba0cd09dbb2d50200b3e800a63d2": "Kraken",
	"0x32be343b94f860124dc4fee278fdcbd38c102d88": "Poloniex",
	"0xcafb10ee663f465f9d10588ac44ed20ed608c11e": "Bitfinex",
	"0x91337a300e0361bddb2e377dd4e88ccb7796663d": "BTC-e",
	"0xf4fe90e63f2a90710bcc0c00f38812c4a882f2ff": "BitcoinToYou",
	"0x120a270bbc009644e35f0bb6ab13f95b8199c4ad": "Shapeshift1",
	"0x9e6316f44baeeee5d41a1070516cc5fa47baf227": "Shapeshift2",
	"0x61c808d82a3ac53231750dadc13c777b59310bd9": "f2pool",
	"0x2a65aca4d5fc5b5c859090a6c34d164135398226": "DwarfPool1",
	"0xd24400ae8bfebb18ca49be86258a3c749cf46853": "Gemini",
}

// Start counting at the creation blockNumber of yes contract, see
// http://etherscan.io/tx/0x81784fed3729b8865e90c9731167838efb14edd461599e06d9e570ece0c49980
//
// The no contract was created a few blocks later in
// http://etherscan.io/tx/0xf75f0e757bb683892b03af3e958bb657302462aaf53a89e18adf57df609037ab
var votingStartBlock = 1836214;
var votingEndBlock = 1894000;

function voteName(log) {
	if (log.address == yes.address)
		return "YES"
	else if (log.address == no.address)
		return "NO"
	else
		return log.address
}

function getVotes(startBlock, endBlock, voteName, contract, callback) {
	var filter = contract.LogVote({}, {fromBlock: startBlock, toBlock: endBlock});
	filter.get((err, votes) => {
		if (!err)
			console.log("found", votes.length, voteName, "vote events");
		callback(err, votes);
	});
}

// mergeVotes creates a map containing the earliest vote
// for each address. It also filters out votes sent by blacklisted addresses.
function mergeVotes(yesVotes, noVotes) {
	var voteMap = {};
	var numDoubleVotes = 0;
	function insert(vote) {
		var voter = vote.args.addr;
		// Apply the blacklist.
		if (blacklist[voter]) {
			console.log("ignoring", voteName(vote), "vote from blacklisted account", blacklist[voter], "at block", vote.blockNumber);
			return;
		}
		// Keep the last vote.
		if (voteMap[voter]) {
			numDoubleVotes++;
			if (vote.blockNumber < voteMap[voter].blockNumber)
				return;
		}
		voteMap[voter] = vote;
	}

	yesVotes.forEach(insert);
	noVotes.forEach(insert);
	console.log("found", numDoubleVotes, "double votes");
	return voteMap;
}

// sumBalances computes the sum of the balances of all given addresses.
function sumBalances(blockNumber, addresses, callback) {
	var total = new BigNumber(0);
	async.eachLimit(addresses, 10, (addr, asyncDone) => {
		web3.eth.getBalance(addr, blockNumber, (err, balance) => {
			if (!err)
				total = total.add(balance);
			asyncDone(err);
		});
	}, (err) => {
		callback(err, total);
	});
}

// tallyVotes sums up the balances of all voters in voteMap.
function tallyVotes(blockNumber, voteMap, callback) {
	var totals = {yes: new BigNumber(0), no: new BigNumber(0)}
	async.eachLimit(Object.getOwnPropertyNames(voteMap), 10, (voter, asyncDone) => {
		var vote = voteMap[voter];
		web3.eth.getBalance(voter, blockNumber, (err, balance) => {
			if (!err) {
				if (vote.address == yes.address)
					totals.yes = totals.yes.add(balance);
				else if (vote.address == no.address)
					totals.no = totals.no.add(balance);
				else
					console.log("ignoring non-fork vote", vote);
			}
			asyncDone(err);
		});
	}, (err) => {
		callback(err, totals);
	});
}

// getTotalSupply retrieves the total ether supply from etherchain.org.
// If etherchain is not available, the callback receives zero.
function getTotalSupply(callback) {
	var supply = new BigNumber(0);
	var options = {method: "GET", hostname: "etherchain.org", port: 443, path: "/api/supply"};
	var req = https.request(options, function(res) {
		res.setEncoding('utf8');
		res.on('data', (data) => {
			try {
				var obj = JSON.parse(data);
				if (!obj.data || !obj.data[0] || !obj.data[0].supply) {
					console.log("invalid response from etherchain:", obj);
					throw new Error("etherchain API response doesn't contain supply");
				}
				supply = new BigNumber(web3.toWei(obj.data[0].supply, "ether"));
			} catch (err) {
				return callback(err);
			}
			callback(null, supply);
		});
	});
	req.on('error', () => {
		callback(null, supply);
	});
	req.end();
}

function percent(amount, whole) {
	return amount.div(whole).mul(100).toPrecision(3) + "%";
}

function printVoteResult(results) {
	var voteTotal = results.voteBalances.yes.add(results.voteBalances.no);
	var yesEther = web3.fromWei(results.voteBalances.yes).toString();
	var yesPercent = percent(results.voteBalances.yes, voteTotal);
	var noEther = web3.fromWei(results.voteBalances.no).toString();
	var noPercent = percent(results.voteBalances.no, voteTotal);

	console.log("*** Result at block", results.endBlockNumber);
	console.log("          YES:", yesEther, "ether", "(" + yesPercent + ")");
	console.log("           NO:", noEther, "ether", "(" + noPercent + ")");
	console.log(" TOTAL AMOUNT:", web3.fromWei(voteTotal).toString(), "ether");

	// Add info about voter participation if etherchain was reachable.
	if (!results.supply.isZero()) {
		var p = percent(voteTotal, results.supply);
		var p2 = percent(voteTotal, results.supply.sub(results.blacklistBalance));
		console.log("PARTICIPATION:", p, "of all ether", "(" + p2, "excluding blacklist)");
	}
}

function main() {
	async.auto({
		endBlockNumber: (callback) => {
			web3.eth.getBlock("latest", (err, block) => {
				if (err)
					return callback(err);
				if (block.number > votingEndBlock)
					return callback(null, votingEndBlock);
				callback(null, block.number);
			});
		},
		supply: (callback) => {
			getTotalSupply(callback);
		},
		yesVotes: ["endBlockNumber", (results, callback) => {
			getVotes(votingStartBlock, results.endBlockNumber, "YES", yes, callback);
		}],
		noVotes: ["endBlockNumber", (results, callback) => {
			getVotes(votingStartBlock, results.endBlockNumber, "NO", no, callback);
		}],
		voteBalances: ["endBlockNumber", "yesVotes", "noVotes", (results, callback) => {
			var voteMap = mergeVotes(results.yesVotes, results.noVotes);
			tallyVotes(results.endBlockNumber, voteMap, callback);
		}],
		blacklistBalance: ["endBlockNumber", (results, callback) => {
			var addrs = Object.getOwnPropertyNames(blacklist);
			sumBalances(results.endBlockNumber, addrs, callback);
		}],
	}, (err, results) => {
		if (err) {
			console.log(err.stack);
			process.exit(1);
		} else {
			printVoteResult(results);
			process.exit(0);
		}
	});
}

main();
