var request = require('request');
var stringifySafe = require('json-stringify-safe');
var _ = require("lodash");

exports.version = require('../package.json').version;

var LogzioLogger = function (options) {
    if (!options || !options.token)
        throw new Error('You are required to supply a token for logging.');

    if (options.protocol && options.protocol != 'http' && options.protocol != 'https')
        throw new Error('Invalid protocol defined');

    this.token = options.token;
    this.protocol = options.protocol || 'http';
    this.host = options.host || 'listener-4.logz.io';
    this.port = this.protocol == 'http' ? 8070 : 8071;
    this.userAgent = 'Logzio-Logger NodeJS';
    this.type = options.type || 'nodejs';
    this.sendIntervalMs = options.sendIntervalMs || 10*1000;
    this.bufferSize = options.bufferSize || 100;
    this.debug = options.debug || false;
    this.numberOfRetries = options.numberOfRetries || 3;
    this.callback = options.callback || this._defaultCallback;
    this.timeout = options.timeout;
    // build the url for logging
    this.url = this.protocol + '://' + this.host + ':' + this.port + '?token=' + this.token;

    this.messages = [];
    this.bulkId = 1;
    this.extraFields = options.extraFields || {};
};

exports.createLogger = function (options) {
    var l = new LogzioLogger(options);
    l._timerSend();
    return l;
};

var jsonToString = exports.jsonToString = function(json) {
    try {
        return JSON.stringify(json);
    }
    catch(ex) {
        return stringifySafe(msg, null, null, function() { });
    }
};

LogzioLogger.prototype._defaultCallback = function(err) {
    if (err) {
        console.error("logzio-logger error: "+err, err);
    }
};

LogzioLogger.prototype._timerSend = function() {
    if (this.messages.length > 0) {
        this._debug("Woke up and saw " + this.messages.length + " messages to send. Sending now...");
        this._popMsgsAndSend();
    }
    var mythis = this;
    setTimeout(
        function() {
            mythis._timerSend();
        },
        this.sendIntervalMs
    );
};

LogzioLogger.prototype.log = function(msg) {
    if (typeof msg === 'string') {
        msg = {message: msg};
        if (this.type) msg.type = this.type;
    }
    msg = _.assign(msg, this.extraFields);
    msg.type = this.type;

    this.messages.push(msg);
    if (this.messages.length >= this.bufferSize) {
        this._debug("Buffer is full - sending bulk");
        this._popMsgsAndSend();
    }
};

LogzioLogger.prototype._popMsgsAndSend = function() {
    var bulk = this._createBulk(this.messages);
    this._debug("Sending bulk #"+bulk.id);
    this._send(bulk);
    this.messages = [];
};

LogzioLogger.prototype._createBulk = function(msgs) {
    var bulk = {};
    // creates a new copy of the array. Objects references are copied (no deep copy)
    bulk.msgs = msgs.slice();
    bulk.attemptNumber = 1;
    bulk.sleepUntilNextRetry = 2*1000;
    bulk.id = this.bulkId++;

    return bulk;
};

LogzioLogger.prototype._messagesToBody = function(msgs) {
    var body = "";
    for (var i = 0; i < msgs.length; i++) {
        body = body + jsonToString(msgs[i]) + "\n";
    }
    return body;
};

LogzioLogger.prototype._debug = function(msg) {
    if (this.debug) console.log("logzio-nodejs: "+msg);
};

LogzioLogger.prototype._send = function(bulk) {
    var mythis = this;
    function tryAgainIn(sleepTimeMs) {
        mythis._debug("Bulk #"+bulk.id+" - Trying again in "+sleepTimeMs+ "[ms], attempt no. "+bulk.attemptNumber);
        setInterval(function() {
            mythis._send(bulk);
        }, sleepTimeMs);
    }

    var body = this._messagesToBody(bulk.msgs);
    var options = {
        uri: this.url,
        body: body,
        headers: {
            'host': this.host,
            'accept': '*/*',
            'user-agent': this.userAgent,
            'content-type': 'text/plain',
            'content-length': Buffer.byteLength(body)
        }
    };
    if (typeof this.timeout != 'undefined') {
        options.timeout = this.timeout;
    }

    var callback = this.callback;
    try {
        request.post(options, function (err, res, body) {
            if (err) {
                // In rare cases server is busy
                if (err.code === 'ETIMEDOUT' || err.code == 'ECONNRESET'){
                    if (bulk.attemptNumber >= mythis.numberOfRetries) {
                        callback(new Error("Failed after "+bulk.attemptNumber+" retries on error = "+err, err));
                    } else {
                        var sleepTimeMs = bulk.sleepUntilNextRetry;
                        bulk.sleepUntilNextRetry = bulk.sleepUntilNextRetry * 2;
                        bulk.attemptNumber++;
                        tryAgainIn(sleepTimeMs)
                    }
                } else {
                    callback(err);
                }
            } else {
                var responseCode = res.statusCode.toString();
                if (responseCode !== '200') {
                    callback(new Error('There was a problem with the request.\nResponse: ' + responseCode + ": " + body.toString()));
                } else {
                    mythis._debug("Bulk #"+bulk.id+" - sent successfully");
                    callback();
                }
            }

        });
    }
    catch (ex) {
        callback(ex);
    }
};
