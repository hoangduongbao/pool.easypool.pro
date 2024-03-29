var fs = require('fs');
var net = require('net');
var crypto = require('crypto');

var async = require('async');
var bignum = require('bignum');
var multiHashing = require('multi-hashing');
var cnUtil = require('cryptonote-util');

// Must exactly be 8 hex chars, already lowercased before test
var noncePattern = new RegExp("^[0-9a-f]{8}$");

//SSL for claymore
var tls = require('tls');

// keccak to calculate blockid
//var keccak256 = require('js-sha3').keccak256;

var threadId = '(Thread ' + process.env.forkId + ') ';

var logSystem = 'pool';
require('./exceptionWriter.js')(logSystem);

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);
var utils = require('./utils.js');
Buffer.prototype.toByteArray = function () {
  return Array.prototype.slice.call(this, 0)
}

var log = function(severity, system, text, data){
    global.log(severity, system, threadId + text, data);
};

var cryptoNight = multiHashing['cryptonight'];

var diff1 = bignum('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16);

var instanceId = crypto.randomBytes(4);

var validBlockTemplates = [];
var currentBlockTemplate;
var currentBlockHeight = 0;
var currentBlockHash = "";

var connectedMiners = {};

var bannedIPs = {};
var perIPStats = {};

var shareTrustEnabled = config.poolServer.shareTrust && config.poolServer.shareTrust.enabled;
var shareTrustStepFloat = shareTrustEnabled ? config.poolServer.shareTrust.stepDown / 100 : 0;
var shareTrustMinFloat = shareTrustEnabled ? config.poolServer.shareTrust.min / 100 : 0;


var banningEnabled = config.poolServer.banning && config.poolServer.banning.enabled;

setInterval(function(){
    var now = Date.now() / 1000 | 0;
    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        if(!miner.noRetarget) {
            miner.retarget(now);
        }
    }
}, config.poolServer.varDiff.retargetTime * 1000);


/* Every 30 seconds clear out timed-out miners and old bans */
setInterval(function(){
    var now = Date.now();
    var timeout = config.poolServer.minerTimeout * 1000;
    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        if (now - miner.lastBeat > timeout){
            log('warn', logSystem, 'Miner timed out and disconnected %s@%s', [miner.login, miner.ip]);
            delete connectedMiners[minerId];
        }
    }

    if (banningEnabled){
        for (ip in bannedIPs){
            var banTime = bannedIPs[ip];
            if (now - banTime > config.poolServer.banning.time * 1000) {
                delete bannedIPs[ip];
                delete perIPStats[ip];
                log('info', logSystem, 'Ban dropped for %s', [ip]);
            }
        }
    }

}, 30000);


process.on('message', function(message) {
    switch (message.type) {
        case 'banIP':
            bannedIPs[message.ip] = Date.now();
            break;
    }
});


function IsBannedIp(ip){
    if (!banningEnabled || !bannedIPs[ip]) return false;

    var bannedTime = bannedIPs[ip];
    var bannedTimeAgo = Date.now() - bannedTime;
    var timeLeft = config.poolServer.banning.time * 1000 - bannedTimeAgo;
    if (timeLeft > 0){
        return true;
    }
    else {
        delete bannedIPs[ip];
        log('info', logSystem, 'Ban dropped for %s', [ip]);
        return false;
    }
}


function BlockTemplate(template){
    this.blob = template.blocktemplate_blob;
    this.blockhashingblob = template.blockhashing_blob;
    this.prev_hash = template.prev_hash
    this.difficulty = template.difficulty;
    this.height = template.height;
    this.epoch = template.epoch;
    this.reserveOffset =template.reserved_offset; //in the getwork


    this.hashingbuffer = new Buffer(this.blockhashingblob, 'hex');
    instanceId.copy(this.hashingbuffer, this.reserveOffset + 4, 0, 3);
        
//    instanceId.copy(this.buffer, this.reserveOffset + 4, 0, 3);
//    this.previous_hash = new Buffer(32);
//    this.buffer.copy(this.previous_hash,0,7,39);
    this.extraNonce = 0;
}
BlockTemplate.prototype = {
    nextBlob: function(){
        this.hashingbuffer.writeUInt32BE(++this.extraNonce, this.reserveOffset);
        return this.hashingbuffer.toString('hex');
    }
};



function getBlockTemplate(callback){
    apiInterfaces.rpcDaemon('getblocktemplate', {reserve_size: 8, wallet_address: config.poolServer.poolAddress}, callback);
}

function getBlockCount(callback){
    apiInterfaces.rpcDaemon('getheight', null, callback);
}

function getBlockHash(callback){
    apiInterfaces.rpcDaemon('on_getblockhash', [currentBlockHeight - 1], callback);
}

function jobLoop()
{
    jobRefresh();
    setTimeout(function(){ jobLoop(); }, config.poolServer.blockRefreshInterval);
}

var jobRefreshCompleteCallback = null;
function jobRefreshError(text, error)
{
    log('error', logSystem, text, [error]);
    if(jobRefreshCompleteCallback != null)
        jobRefreshCompleteCallback(false);
}

var jobRefreshCounter = 0;
function jobRefresh(state){
    state = state || "check_force";

    switch(state){
    case "check_force":
        if(jobRefreshCounter % config.poolServer.blockRefreshForce == 0)
            jobRefresh("get_template");
        else
            jobRefresh("check_count");
        jobRefreshCounter++;
        break;

    case "check_count":
    case "check_hash":
    case "get_template":
        jobRefreshCounter=0;
        getBlockTemplate(function(error, result){
            if(error) {
		jobRefreshError('Error polling getblocktemplate %j', error);
                return;
            }

            currentBlockHeight = result.height;
            currentBlockHash = result.prev_hash;

            var buffer = new Buffer(result.blocktemplate_blob, 'hex');
            var previous_hash = new Buffer(32);
            buffer.copy(previous_hash,0,7,39);
            if (!currentBlockTemplate ||  result.prev_hash != currentBlockTemplate.prev_hash){
                log('info', logSystem, 'New block to mine at height %d w/ difficulty of %d', [result.height, result.difficulty]);
                processBlockTemplate(result);
            } else if ( (result.epoch - currentBlockTemplate.epoch) >= 3 ){ // refresh job every 5 secs
                 processBlockTemplate(result);
            }

            if(jobRefreshCompleteCallback != null)
                jobRefreshCompleteCallback(true);
        });
    }
}



function processBlockTemplate(template){

    if (currentBlockTemplate)
        validBlockTemplates.push(currentBlockTemplate);

    if (validBlockTemplates.length > 3)
        validBlockTemplates.shift();

    currentBlockTemplate = new BlockTemplate(template);

    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        miner.pushMessage('job', miner.getJob());
    }
}



(function init(){
    jobRefreshCompleteCallback = function(sucessful){
        if (!sucessful){
            log('error', logSystem, 'Could not start pool');
            return;
        }
        startPoolServerTcp(function(successful){ });
        jobRefreshCompleteCallback = null;
    };

    jobLoop();
})();

var VarDiff = (function(){
    var variance = config.poolServer.varDiff.variancePercent / 100 * config.poolServer.varDiff.targetTime;
    return {
        variance: variance,
        bufferSize: config.poolServer.varDiff.retargetTime / config.poolServer.varDiff.targetTime * 4,
        tMin: config.poolServer.varDiff.targetTime - variance,
        tMax: config.poolServer.varDiff.targetTime + variance,
        maxJump: config.poolServer.varDiff.maxJump
    };
})();

function Miner(id, login, workerName, pass, ip, startingDiff, noRetarget, pushMessage){
    this.id = id;
    this.login = login;
    this.pass = pass;
    this.ip = ip;
    this.pushMessage = pushMessage;
    this.heartbeat();
    this.noRetarget = noRetarget;
    this.difficulty = startingDiff;
    this.workerName = workerName;
    this.validJobs = [];

    // Vardiff related variables
    this.shareTimeRing = utils.ringBuffer(16);
    this.lastShareTime = Date.now() / 1000 | 0;

    this.validShares = 0;
    this.invalidShares = 0;

    if (shareTrustEnabled) {
        this.trust = {
            threshold: config.poolServer.shareTrust.threshold,
            probability: 1,
            penalty: 0
        };
    }
}
Miner.prototype = {
    retarget: function(now){

        var options = config.poolServer.varDiff;

        var sinceLast = now - this.lastShareTime;
        var decreaser = sinceLast > VarDiff.tMax;

        var avg = this.shareTimeRing.avg(decreaser ? sinceLast : null);
        var newDiff;

        var direction;

        if (avg > VarDiff.tMax && this.difficulty > options.minDiff){
            newDiff = options.targetTime / avg * this.difficulty;
            newDiff = newDiff > options.minDiff ? newDiff : options.minDiff;
            direction = -1;
        }
        else if (avg < VarDiff.tMin && this.difficulty < options.maxDiff){
            newDiff = options.targetTime / avg * this.difficulty;
            newDiff = newDiff < options.maxDiff ? newDiff : options.maxDiff;
            direction = 1;
        }
        else{
            return;
        }

        if (Math.abs(newDiff - this.difficulty) / this.difficulty * 100 > options.maxJump){
            var change = options.maxJump / 100 * this.difficulty * direction;
            newDiff = this.difficulty + change;
        }

        this.setNewDiff(newDiff);
        this.shareTimeRing.clear();
        if (decreaser) this.lastShareTime = now;
    },
    setNewDiff: function(newDiff){
        newDiff = Math.round(newDiff);
        if (this.difficulty === newDiff) return;
        log('info', logSystem, 'Retargetting difficulty %d to %d for %s', [this.difficulty, newDiff, this.login]);
        this.pendingDifficulty = newDiff;
        this.pushMessage('job', this.getJob());
    },
    heartbeat: function(){
        this.lastBeat = Date.now();
    },
    getTargetHex: function(){
        if (this.pendingDifficulty){
            this.lastDifficulty = this.difficulty;
            this.difficulty = this.pendingDifficulty;
            this.pendingDifficulty = null;
        }

        var padded = new Buffer(32);
        padded.fill(0);

        var diffBuff = diff1.div(this.difficulty).toBuffer();
        diffBuff.copy(padded, 32 - diffBuff.length);

        var buff = padded.slice(0, 4);
        var buffArray = buff.toByteArray().reverse();
        var buffReversed = new Buffer(buffArray);
        this.target = buffReversed.readUInt32BE(0);
        var hex = buffReversed.toString('hex');
        return hex;
    },
    getJob: function(){
        if (this.prev_hash === currentBlockTemplate.prev_hash && this.epoch === currentBlockTemplate.epoch  && !this.pendingDifficulty) {

            return {
                blob: '',
                job_id: '',
                target: ''
            };
        }
        
        var blob = currentBlockTemplate.nextBlob();
        this.lastBlockHeight = currentBlockTemplate.height;
        this.prev_hash = currentBlockTemplate.prev_hash;
        var target = this.getTargetHex();

        var newJob = {
            id: utils.uid(),
            extraNonce: currentBlockTemplate.extraNonce,
            height: currentBlockTemplate.height,
            epoch: currentBlockTemplate.epoch,
            difficulty: this.difficulty,
            diffHex: this.diffHex,
            prev_hash: this.prev_hash,
            submissions: []
        };

        this.validJobs.push(newJob);

        if (this.validJobs.length > 4)
            this.validJobs.shift();


        return {
            blob: blob,
            job_id: newJob.id,
            target: target,
            id: this.id
        };
    },
    checkBan: function(validShare){
        if (!banningEnabled) return;
        // Store valid/invalid shares per IP (already initialized with 0s)
        // Init global per-IP shares stats
        if (!perIPStats[this.ip]){
            perIPStats[this.ip] = { validShares: 0, invalidShares: 0 };
        }
        var stats = perIPStats[this.ip];
        validShare ? stats.validShares++ : stats.invalidShares++;

        if (stats.validShares + stats.invalidShares >= config.poolServer.banning.checkThreshold){
            if (stats.invalidShares / stats.validShares >= config.poolServer.banning.invalidPercent / 100){
                log('warn', logSystem, 'Banned %s@%s', [this.login, this.ip]);
                bannedIPs[this.ip] = Date.now();
                delete connectedMiners[this.id];
                process.send({type: 'banIP', ip: this.ip});
            }
            else{
                stats.invalidShares = 0;
                stats.validShares = 0;
            }
        }
    }
};



function recordShareData(miner, job, shareDiff, blockCandidate, hashHex, shareType, blockTemplate){

    var dateNow = Date.now();
    var dateNowSeconds = dateNow / 1000 | 0;
    // Expire the stats per unique worker after 7 days. Note that an
    // address and IP can have multiple workers (e.g. one process for CPU and
    // one for GPU).
    var uniqueWorkerTtl = 86400 * 7;
    var uniqueWorkerKey = [config.coin, 'unique_workers', miner.login, miner.id, miner.ip].join(':');

    var redisCommands = [
        ['hincrby', config.coin + ':shares:roundCurrent', miner.login, job.difficulty],
        ['zadd', config.coin + ':hashrate', dateNowSeconds, [job.difficulty, miner.login, dateNow].join(':')],
        ['zadd', config.coin + ':hashrate', dateNowSeconds, [job.difficulty, miner.login + '+' + miner.workerName, dateNow].join(':')],
        ['hincrby', config.coin + ':workers:' + miner.login, 'hashes', job.difficulty],
        ['hset', config.coin + ':workers:' + miner.login, 'lastShare', dateNowSeconds],
        ['hset', uniqueWorkerKey, 'lastShare', dateNowSeconds],
        ['hset', uniqueWorkerKey, 'address', miner.login],
        ['expire', uniqueWorkerKey, uniqueWorkerTtl]
    ];

    if (blockCandidate){
        redisCommands.push(['hset', config.coin + ':stats', 'lastBlockFound', Date.now()]);
        redisCommands.push(['rename', config.coin + ':shares:roundCurrent', config.coin + ':shares:round' + job.height]);
        redisCommands.push(['hgetall', config.coin + ':shares:round' + job.height]);
    }

    redisClient.multi(redisCommands).exec(function(err, replies){
        if (err){
            log('error', logSystem, 'Failed to insert share data into redis %j \n %j', [err, redisCommands]);
            return;
        }
        if (blockCandidate){
            var workerShares = replies[replies.length - 1];
            var totalShares = Object.keys(workerShares).reduce(function(p, c){
                return p + parseInt(workerShares[c]);
            }, 0);
            redisClient.zadd(config.coin + ':blocks:candidates', job.height, [
                hashHex,
                Date.now() / 1000 | 0,
                blockTemplate.difficulty,
                totalShares
            ].join(':'), function(err, result){
                if (err){
                    log('error', logSystem, 'Failed inserting block candidate %s \n %j', [hashHex, err]);
                }
            });
        }

    });

    log('info', logSystem, 'Accepted %s share at difficulty %d/%d from %s@%s', [shareType, job.difficulty, shareDiff, miner.login, miner.ip]);

}

function processShare(miner, job, blockTemplate, nonce, resultHash){
    var template = new Buffer(blockTemplate.hashingbuffer.length);
    blockTemplate.hashingbuffer.copy(template);


    //    instanceId.copy(template, blockTemplate.reserveOffset + 4, 0, 3);
    //    console.log(template.toString('hex'));
    //    template.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset);

    //instanceId.copy(template, blockTemplate.reserveOffset + 4, 0, 3); // copy instance ID
    template.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset); // set extra nonce


    nonce_buf = new Buffer(nonce, 'hex');
    nonce_buf.copy(template, 39 , 0, 4);

     //var shareBuffer = cnUtil.construct_block_blob(template, new Buffer(nonce, 'hex'));
    shareBuffer = template


    var convertedBlob;
    var hash;
    var shareType;

    if (shareTrustEnabled && miner.trust.threshold <= 0 && miner.trust.penalty <= 0 && Math.random() > miner.trust.probability){
        hash = new Buffer(resultHash, 'hex');
        shareType = 'trusted';
    }
    else {
        //convertedBlob = cnUtil.convert_blob(shareBuffer);
        hash = cryptoNight(shareBuffer);
        shareType = 'valid';
    }

    

    if (hash.toString('hex') !== resultHash) {
        log('warn', logSystem, 'Bad hash from miner %s@%s', [miner.login, miner.ip]);
        return false;
    }

    var hashArray = hash.toByteArray().reverse();
    var hashNum = bignum.fromBuffer(new Buffer(hashArray));
    var hashDiff = diff1.div(hashNum);



    if (hashDiff.ge(blockTemplate.difficulty)){

        apiInterfaces.rpcDaemon('submitblock', [blockTemplate.blob, shareBuffer.toString('hex')], function(error, result){
            if (error || result.status!=="OK"){
		

                log('error', logSystem, 'Error submitting block at height %d from %s@%s, share type: "%s" - %j', [job.height, miner.login, miner.ip, shareType, error]);
                recordShareData(miner, job, hashDiff.toString(), false, null, shareType);
            }
            else{
                //var blockFastHash = cnUtil.get_block_id(shareBuffer).toString('hex');
                log('error', logSystem, 'OK submitting block at height %d from %s@%s, share type: "%s" - %j', [job.height, miner.login, miner.ip, shareType, error]);
                recordShareData(miner, job, hashDiff.toString(), false, null, shareType);

                //var blockFastHash = keccak256(shareBuffer).toString('hex');
                log('info', logSystem,
                    'Block %s found at height %d by miner %s@%s - submit result: %j',
                    // [blockFastHash.substr(0, 6), job.height, miner.login, miner.ip, result]
                   [result.blid, job.height, miner.login, miner.ip, result]
                );
                recordShareData(miner, job, hashDiff.toString(), true, result.blid, shareType, blockTemplate);
                jobRefresh("get_template");
            }
        });
    }

    else if (hashDiff.lt(job.difficulty)){
        log('warn', logSystem, 'Rejected low difficulty share of %s from %s@%s', [hashDiff.toString(), miner.login, miner.ip]);
        return false;
    }
    else{
        recordShareData(miner, job, hashDiff.toString(), false, null, shareType);
    }

    return true;
}


function handleMinerMethod(method, params, ip, portData, sendReply, pushMessage){


    var miner = connectedMiners[params.id];
    // Check for ban here, so preconnected attackers can't continue to screw you
    if (IsBannedIp(ip)){
        sendReply('your IP is banned');
        return;
    }
    switch(method){
        case 'login':
            var login = params.login;
            if (!login){
                sendReply('missing login');
                return;
            }

            var difficulty = portData.difficulty;
            var workerName = "unknown";
            var noRetarget = false;
            // Grep the worker name.
            var workerNameCharPos = login.indexOf('+');
            if (workerNameCharPos != -1) {
              workerName = login.substr(workerNameCharPos + 1);
              login = login.substr(0, workerNameCharPos);
              log('info', logSystem, 'Miner %s uses worker name: %s',  [login, workerName]);
            }
            if(config.poolServer.fixedDiff.enabled) {
                var fixedDiffCharPos = login.indexOf(config.poolServer.fixedDiff.addressSeparator);
                if(fixedDiffCharPos != -1) {
                    noRetarget = true;
                    difficulty = login.substr(fixedDiffCharPos + 1);
                    if(difficulty < config.poolServer.varDiff.minDiff) {
                        difficulty = config.poolServer.varDiff.minDiff;
                    }
                    login = login.substr(0, fixedDiffCharPos);
                    log('info', logSystem, 'Miner difficulty fixed to %s',  [difficulty]);
                }
            }

            // Check that the address prefix is sane.
            //var addressPrefix = cnUtil.address_decode(new Buffer(login)).toString();
            //if (config.poolServer.allowedMinerAddressPrefixes.indexOf(addressPrefix) == -1) {
            //    sendReply('invalid address used');
            //    return;
            //}

            var minerId = utils.uid();
            miner = new Miner(minerId, login, workerName, params.pass, ip, difficulty, noRetarget, pushMessage);
            connectedMiners[minerId] = miner;
            
            sendReply(null, {
                id: minerId,
                job: miner.getJob(),
                status: 'OK'
            });
            log('info', logSystem, 'Miner connected %s@%s',  [login, miner.ip]);
            break;
        case 'getjob':
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();
            sendReply(null, miner.getJob());
            break;
        case 'submit':
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();

            var job = miner.validJobs.filter(function(job){
                return job.id === params.job_id;
            })[0];

            if (!job){
                sendReply('Invalid job id');
                return;
            }

	    params.nonce = params.nonce.substr(0, 8).toLowerCase();
            if (!noncePattern.test(params.nonce)) {
                 var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
                log('warn', logSystem, 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + minerText);
                 perIPStats[miner.ip] = { validShares: 0, invalidShares: 999999 };
                 miner.checkBan(false);
                 sendReply('Duplicate share');
                 return;
            }

            if (job.submissions.indexOf(params.nonce) !== -1){
                var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
                log('warn', logSystem, 'Duplicate share: ' + JSON.stringify(params) + ' from ' + minerText);
                perIPStats[miner.ip] = { validShares: 0, invalidShares: 999999 };
                miner.checkBan(false);
                sendReply('Duplicate share');
                return;
            }

            job.submissions.push(params.nonce);

            var blockTemplate = currentBlockTemplate.epoch === job.epoch ? currentBlockTemplate : validBlockTemplates.filter(function(t){
                return t.epoch === job.epoch;
            })[0];

            if (!blockTemplate){
                var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
                log('warn', logSystem, 'Block expired, Height: ' + job.height + ' from ' + minerText);
                sendReply('Block expired');
                return;
            }

            var shareAccepted = processShare(miner, job, blockTemplate, params.nonce, params.result);
            miner.checkBan(shareAccepted);

            if (shareTrustEnabled){
                if (shareAccepted){
                    miner.trust.probability -= shareTrustStepFloat;
                    if (miner.trust.probability < shareTrustMinFloat)
                        miner.trust.probability = shareTrustMinFloat;
                    miner.trust.penalty--;
                    miner.trust.threshold--;
                }
                else{
                    log('warn', logSystem, 'Share trust broken by %s@%s', [miner.login, miner.ip]);
                    miner.trust.probability = 1;
                    miner.trust.penalty = config.poolServer.shareTrust.penalty;
                }
            }

			if (!shareAccepted){
                sendReply('Low difficulty share');
                return;
            }

            var now = Date.now() / 1000 | 0;
            miner.shareTimeRing.append(now - miner.lastShareTime);
            miner.lastShareTime = now;
            //miner.retarget(now);

            sendReply(null, {status: 'OK'});
            break;
        case 'keepalived' :
        if (!miner){
              sendReply('Unauthenticated');
              return;
          }
         miner.heartbeat();
         sendReply(null, { status:'KEEPALIVED'
         });
         break;
        default:
            sendReply("invalid method");
            var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
            log('warn', logSystem, 'Invalid method: %s (%j) from %s', [method, params, minerText]);
            break;
    }
}


var httpResponse = ' 200 OK\nContent-Type: text/plain\nContent-Length: 20\n\nmining server online';


function startPoolServerTcp(callback){
    async.each(config.poolServer.ports, function(portData, cback){
        var handleMessage = function(socket, jsonData, pushMessage){
            if (!jsonData.id) {
                log('warn', logSystem, 'Miner RPC request missing RPC id');
                return;
            }
            else if (!jsonData.method) {
                log('warn', logSystem, 'Miner RPC request missing RPC method');
                return;
            }
            else if (!jsonData.params) {
                log('warn', logSystem, 'Miner RPC request missing RPC params');
                return;
            }

            var sendReply = function(error, result){
                if(!socket.writable) return;
                var sendData = JSON.stringify({
                    id: jsonData.id,
                    jsonrpc: "2.0",
                    error: error ? {code: -1, message: error} : null,
                    result: result
                }) + "\n";
                socket.write(sendData);
            };

            handleMinerMethod(jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, pushMessage);
        };

        var socketResponder = function(socket){
            socket.setKeepAlive(true);
            socket.setEncoding('utf8');

            var dataBuffer = '';

            var pushMessage = function(method, params){
                if(!socket.writable) return;
                var sendData = JSON.stringify({
                    jsonrpc: "2.0",
                    method: method,
                    params: params
                }) + "\n";
                socket.write(sendData);
            };

            socket.on('data', function(d){
                dataBuffer += d;
                if (Buffer.byteLength(dataBuffer, 'utf8') > 10240){ //10KB
                    dataBuffer = null;
                    log('warn', logSystem, 'Socket flooding detected and prevented from %s', [socket.remoteAddress]);
                    socket.destroy();
                    return;
                }
                if (dataBuffer.indexOf('\n') !== -1){
                    var messages = dataBuffer.split('\n');
                    var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                    for (var i = 0; i < messages.length; i++){
                        var message = messages[i];
                        if (message.trim() === '') continue;
                        var jsonData;
                        try{
                            jsonData = JSON.parse(message);
                        }
                        catch(e){
                            if (message.indexOf('GET /') === 0) {
                                if (message.indexOf('HTTP/1.1') !== -1) {
                                    socket.end('HTTP/1.1' + httpResponse);
                                    break;
                                }
                                else if (message.indexOf('HTTP/1.0') !== -1) {
                                    socket.end('HTTP/1.0' + httpResponse);
                                    break;
                                }
                            }

                            log('warn', logSystem, 'Malformed message from %s: %s', [socket.remoteAddress, message]);
                            socket.destroy();

                            break;
                        }
                        handleMessage(socket, jsonData, pushMessage);
                    }
                    dataBuffer = incomplete;
                }
            }).on('error', function(err){
                if (err.code !== 'ECONNRESET')
                    log('warn', logSystem, 'Socket error from %s %j', [socket.remoteAddress, err]);
            }).on('close', function(){
                pushMessage = function(){};
            });

        };

        if(portData.type === 'SSL') {
          var options = {
            key: fs.readFileSync(config.poolServer.sslKey),
            cert: fs.readFileSync(config.poolServer.sslCert)
          };
          tls.createServer(options, socketResponder).listen(portData.port, function (error, result) {
            if (error) {
              log('error', logSystem, 'SSL Could not start server listening on port %d, error: $j', [portData.port, error]);
              cback(true);
              return;
            }
            log('info', logSystem, 'SSL Started server listening on port %d', [portData.port]);
            cback();
          });
        }
        else {
          net.createServer(socketResponder).listen(portData.port, function (error, result) {
            if (error) {
              log('error', logSystem, 'Could not start server listening on port %d, error: $j', [portData.port, error]);
              cback(true);
              return;
            }
          log('info', logSystem, 'Started server listening on port %d', [portData.port]);
          cback();
        });
      }



    }, function(err){
        if (err)
            callback(false);
        else
            callback(true);
    });
}
