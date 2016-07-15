var Web3       = require("web3");
var net        = require("net");
var BigNumber  = require("bignumber.js");
var async      = require("async");

var web3       = new Web3(new Web3.providers.IpcProvider("/home/fjl/.ethereum/geth.ipc", net));
var contract   = web3.eth.contract([{"anonymous":false,"inputs":[{"indexed":true,"name":"addr","type":"address"}],"name":"LogVote","type":"event"}]);
var yes        = contract.at("0x3039d0a94d51c67a4f35e742b571874e53467804");
var no         = contract.at("0x58dd96aa829353032a21c95733ce484b949b2849");

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
		fromBlock: latestBlock.number - 600000,
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

	function handleLog(log, asyncDone) {
		// Prevent double votes.
		var voter = log.args.addr;
		var prevVote = earliest[voter];
		if (prevVote && prevVote.blockNumber < log.blockNumber) {
			console.log("ignoring double vote", voteName(log), "from", voter, "at block", log.blockNumber);
			console.log("	earlier vote was", voteName(prevVote), "at block", prevVote.blockNumber);
			return asyncDone();
		}
		earliest[voter] = log;

		// Add the balance to the right bucket.
		web3.eth.getBalance(voter, block.number, function (err, balance) {
			if (err)
				return asyncDone(err);
			else if (log.address == yes.address)
				totals.yes = totals.yes.add(balance);
			else if (log.address == no.address)
				totals.no = totals.no.add(balance);
			else
				console.log("ignoring non-fork vote", log);
			asyncDone(null);
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
