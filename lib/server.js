/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var dns = require('dns');
var url = require('url');

var named = require('named');
var nzk = require('node-zookeeper-client');

var zk = require('./zk');


///--- Globals

var ARecord = named.ARecord;
var SRVRecord = named.SRVRecord;


///--- Helpers

// Fisher-Yates shuffle
// http://sedition.com/perl/javascript-fy.html
function shuffle(arr) {
        if (arr.length === 0)
                return (arr);

        var i = arr.length;
        while (--i > 0) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = arr[i];
                arr[i] = arr[j];
                arr[j] = tmp;
        }

        return (arr);
}

function isSuffix(suffix, str) {
        var idx = str.lastIndexOf(suffix);
        return (idx >= 0 && idx + suffix.length === str.length);
}

function stripSuffix(suffix, str) {
        if (isSuffix(suffix, str))
                return (str.slice(0, str.length - suffix.length) + '...');
        else
                return (str);
}

function resolve(options, query, cb) {
        query.response.header.ra = 0;
        var domain = query.name();

        var service, protocol;
        var srvmatch = domain.match(/^(_[^_.]*)[.](_[^_.]*)[.](.*)/);
        if (query.type() === 'SRV' ||
            (query.type() === 'ANY' && srvmatch)) {
                if (!srvmatch || srvmatch[3].length < 1) {
                        query._log.debug('not a valid SRV lookup domain');
                        query.setError('eserver');
                        query.respond();
                        cb();
                        return;
                }
                service = srvmatch[1];
                protocol = srvmatch[2];
                domain = srvmatch[3];
        }

        var stripped;
        if (false) {
                if (isSuffix('.' + options.dnsDomain, domain)) {
                        stripped = stripSuffix('.' + options.dnsDomain, domain);
                } else {
                        query._log.trace('not within dns domain suffix');
                        query.setError('eserver');
                        query.respond();
                        cb();
                        return;
                }
                var dcsuff = options.dnsDomain + '.' + options.datacenterName;
                if (isSuffix(options.dnsDomain, stripped) ||
                    isSuffix(dcsuff, stripped)) {
                        query._log.trace('doubled-up dns domain suffix');
                        query.setError('eserver');
                        query.respond();
                        cb();
                        return;
                }
        }

        query._log = query._log.child({
                query: {
                        srv: service ? (service + '.' + protocol) : undefined,
                        name: stripped ? stripped : domain,
                        type: query.type()
                }
        }, true);

        if (!options.zkClient()) {
                query._log.error('no ZooKeeper client');
                query.setError('eserver');
                query.respond();
                cb();
                return;
        }

        var req = {
                cache: options.cache,
                log: query._log,
                query: query,
                stamp: query._stamp,
                zkClient: options.zkClient()
        };

        if (domain.length < 1) {
                req.log.debug('request for an empty name: this client is ' +
                    'probably misbehaving');
                query.setError('eserver');
                query.respond();
                cb();
                return;
        }

        domain = domain.toLowerCase();
        if (/[^a-z0-9_.-]/.test(domain)) {
                req.log.debug('request for an invalid name: this client is ' +
                    'probably misbehaving');
                query.setError('eserver');
                query.respond();
                cb();
                return;
        }

        req.domain = domain;
        zk.resolveName(req, function (err, record) {
                if (err && (typeof (err.getCode) !== 'function' ||
                        err.getCode() !== nzk.Exception.NO_NODE)) {

                        req.log.error(err, 'error talking to ZK');
                        query.setError('eserver');
                } else if (err && err.getCode() === nzk.Exception.NO_NODE) {
                        req.log.trace(err, 'node not found in ZK');
                        //Recursion will take care of answering the query.
                        if (options.recursion) {
                                options.recursion.resolve(query, cb);
                                return;
                        }
                        /*
                         * You might expect we would return an NXDOMAIN or
                         * NODATA response here.
                         *
                         * Many of our resolvers use binder as a recursive
                         * nameserver, higher up their priority list than public
                         * DNS. This means that if we serve them such a response
                         * here for a name we don't handle, they will
                         * immediately return an error to their users and not
                         * try public DNS.
                         *
                         * If we return SERVFAIL though, they will try the next
                         * server, which is the behaviour we want (even though
                         * as a result we're not RFC compliant).
                         */
                        query.setError('servfail');
                } else {
                        if (typeof (record.type) !== 'string' ||
                            record[record.type] === undefined ||
                            record[record.type] === null ||
                            typeof (record[record.type]) !== 'object') {
                                req.log.error({
                                        record: record
                                }, 'invalid ZK service record');
                                query.setError('servfail');
                                req.stamp('pre-resp');
                                query.respond();
                                cb();
                                return;
                        }

                        var addr;

                        /*
                         * Default the TTL to 30 seconds (the default ZK
                         * session timeout). If the record has an explicit TTL,
                         * it may be written on the root object, or on the
                         * type-specific sub-object (record[record.type]).
                         * This is all an historical mess, but we take the TTL
                         * from the deepest object.
                         */
                        var ttl = 30;
                        if (record.ttl !== undefined)
                            ttl = record.ttl;
                        if (record[record.type].ttl !== undefined)
                            ttl = record[record.type].ttl;

                        if (service !== undefined &&
                            record.type !== 'service') {
                                /*
                                 * The user asked for an SRV record on something
                                 * that isn't a valid service (e.g. it's a
                                 * specific instance of it). We know we own this
                                 * name, so we can safely return a NODATA
                                 * response.
                                 */
                                query.setError('noerror');
                                req.stamp('build_response');
                                query.respond();
                                cb();
                                return;
                        }
                        switch (record.type) {
                        case 'database':
                                var _u = url.parse(record.database.primary);
                                addr = _u.hostname;
                                query.addAnswer(domain, new ARecord(addr), ttl);
                                break;

                        case 'db_host':
                        case 'host':
                        case 'load_balancer':
                        case 'moray_host':
                        case 'redis_host':
                                addr = record[record.type].address;
                                query.addAnswer(domain, new ARecord(addr), ttl);
                                break;

                        case 'service':
                                var s = record.service.service;
                                if (!s || typeof (s) !== 'object') {
                                        req.log.error({
                                                record: record
                                        }, 'invalid ZK service record');
                                        query.setError('servfail');
                                        break;
                                }
                                /*
                                 * For service-type records, the TTL may also
                                 * be written on record.service.service.
                                 */
                                if (s.ttl !== undefined)
                                    ttl = s.ttl;

                                if (service !== undefined &&
                                    (service !== s.srvce ||
                                    protocol !== s.proto)) {
                                        /*
                                         * The user asked for a SRV record for
                                         * a service/protocol name that didn't
                                         * match the one registered. We know
                                         * we own this name, though, so serve
                                         * them an NXDOMAIN.
                                         */
                                        query.setError('nxdomain');
                                        break;
                                }
                                // Inefficient, but easy to reason about.
                                var recs = record.children.filter(
                                    function (sub) {
                                        return (sub.type === 'load_balancer' ||
                                                sub.type === 'moray_host' ||
                                                sub.type === 'ops_host' ||
                                                sub.type === 'rr_host' ||
                                                sub.type === 'redis_host');
                                });
                                recs = shuffle(recs);
                                for (var i = 0; i < recs.length; ++i) {
                                        var host = recs[i];
                                        if (!host[host.type]) {
                                                //500 this request...
                                                query.setError('eserver');
                                                req.log.error({
                                                        query: query,
                                                        record: record
                                                }, 'bad zk info');
                                                break;
                                        }
                                        var a = host[host.type].address;
                                        if (a === null) {
                                                continue;
                                        }
                                        var ports = host[host.type].ports;
                                        if (ports === undefined ||
                                            ports.length < 1)
                                                ports = [s.port];
                                        var ar, sr, nm;
                                        var rttl = 30;
                                        if (host.ttl !== undefined)
                                            rttl = host.ttl;
                                        if (host[host.type].ttl !== undefined)
                                            rttl = host[host.type].ttl;
                                        if (service !== undefined) {
                                                nm = host.name + '.' + domain;
                                                ports.forEach(function (p) {
                                                        sr = new SRVRecord(
                                                            nm, p);
                                                        query.addAnswer(
                                                            query.name(), sr,
                                                            ttl);
                                                });
                                                ar = new ARecord(a);
                                                query.addAdditional(nm, ar,
                                                    rttl);
                                        } else {
                                                /*
                                                 * If we're serving plain A
                                                 * records for a service, they
                                                 * represent both the list of
                                                 * who's in the service AND
                                                 * what IP they have. So we
                                                 * need to use the smallest
                                                 * of the two TTLs.
                                                 */
                                                if (ttl < rttl)
                                                        rttl = ttl;
                                                ar = new ARecord(a);
                                                query.addAnswer(domain, ar,
                                                    rttl);
                                        }
                                }
                                break;

                        default:
                                req.log.error({
                                        record: record
                                }, 'record type in ZK is unknown');
                                break;
                        }
                }
                req.stamp('pre-resp');
                query.respond();
                cb();
        });
}



///--- API

function createServer(options) {
        assert.object(options, 'options');
        assert.object(options.log, 'options.log');
        assert.optionalObject(options.recursion, 'options.recursion');

        var server = named.createServer({
                name: options.name || 'binder',
                log: options.log
        });

        server.on('query', function onQuery(query, cb) {
                var lastStamp = new Date();
                query._start = lastStamp;
                query._times = {};
                query._stamp = function (name) {
                        var now = new Date();
                        query._times[name] = now - lastStamp;
                        lastStamp = now;
                };
                query._log = options.log.child({
                        req_id: query.id,
                        client: query.src.address,
                        port: query.src.port + '/' + query.src.family,
                        query: { name: query.name(), type: query.type() },
                        edns: (query.response.header.arCount > 0)
                }, true);
                switch (query.type()) {
                case 'A':
                case 'SRV':
                        resolve(options, query, cb);
                        break;

                default:
                        // Anything unsupported we tell the client the truth
                        query.setError('enotimp');
                        query.respond();
                        cb();
                        break;
                }
        });

        server.on('after', function (query, bytes) {
                query._stamp('log-after');
                var lat = (new Date()) - query._start;
                var loglevel = 'info';
                if (lat > 1000)
                        loglevel = 'warn';

                query._log[loglevel]({
                        rcode: query.error(),
                        answers: query.answers().map(function (r) {
                                var ret = r.type;
                                if (r.type === 'SRV') {
                                        var t = r.record.target;
                                        if (options.dnsDomain) {
                                                t = stripSuffix(
                                                    '.' + options.dnsDomain, t);
                                        }
                                        ret += ' ' + t + ':' +
                                            r.record.port;
                                } else if (r.type === 'A' ||
                                    r.type === 'AAAA') {
                                        ret += ' ' + r.record.target;
                                } else {
                                        var obj = {};
                                        Object.keys(r.record).forEach(
                                            function (k) {
                                                obj[k] = r.record[k];
                                        });
                                        obj.type = r.type;
                                        return (obj);
                                }
                                return (ret);
                        }),
                        additional: query.response.additional.filter(
                            function (r) {
                                return (r.rtype !==
                                    named.Protocol.queryTypes.OPT);
                        }).map(function (r) {
                                var ret = named.Protocol.queryTypes[r.rtype];
                                if (ret === 'A' || ret === 'AAAA') {
                                        var n = r.name;
                                        if (options.dnsDomain) {
                                                n = stripSuffix(
                                                    '.' + options.dnsDomain, n);
                                        }
                                        ret = n + ' ' + ret + ' ' +
                                            r.rdata.target;
                                } else {
                                        var obj = {};
                                        Object.keys(r.rdata).forEach(
                                            function (k) {
                                                obj[k] = r.rdata[k];
                                        });
                                        obj.type = ret;
                                        return (obj);
                                }
                                return (ret);
                        }),
                        latency: lat,
                        timers: query._times
                }, 'DNS query');
        });

        server.start = function start(callback) {
                var done = 0;
                server.listenUdp({
                        port: options.port,
                        address: options.host
                }, function () {
                        options.log.info({
                                host: options.host,
                                port: options.port
                        }, 'UDP DNS service started');
                        if (++done >= 2 && typeof (callback) === 'function')
                                callback();
                });
                server.listenTcp({
                        port: options.port,
                        address: options.host
                }, function () {
                        options.log.info({
                                host: options.host,
                                port: options.port
                        }, 'TCP DNS service started');
                        if (++done >= 2 && typeof (callback) === 'function')
                                callback();
                });
        };

        server.stop = function stop(callback) {
                server.close(callback);
        };

        return (server);
}

///--- Exports

module.exports = {

        createServer: createServer

};
