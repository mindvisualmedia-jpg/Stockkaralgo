'use strict';
/**
 * brokers/endpoint.js — the ONE place that decides which host a broker call
 * goes to, and the ONE place that locks that decision down.
 *
 * Production is byte-identical to hard-coded hosts: every endpoint resolves to
 * the broker's real API over https:443.
 *
 * THREE LOCKS so a user's app can NEVER talk to anything but the real broker
 * (proved by test/transport-lock.test.js):
 *   1. an override is ignored unless STOCKKAR_TEST_INTERNALS=1 - set only
 *      inside a test process; no app, installer or deploy sets it;
 *   2. the host must be LOOPBACK (127.0.0.1 / ::1 / localhost) - a public
 *      hostname is refused outright, so a stray or hostile env var can never
 *      redirect real orders;
 *   3. anything refused falls back to the real host and says so, loudly.
 *
 * Env per broker (test only): STOCKKAR_<KEY>_API_HOST / _PORT / _PROTO.
 */
const http = require('http');
const https = require('https');

const LOOPBACK = /^(127\.0\.0\.1|::1|localhost)$/i;

function endpointFor(key, realHost) {
  const real = { hostname: realHost, port: 443, proto: 'https', real: true };
  const host = process.env['STOCKKAR_' + key + '_API_HOST'];
  if (!host) return real;
  const testProc = process.env.STOCKKAR_TEST_INTERNALS === '1';
  const loopback = LOOPBACK.test(String(host).trim());
  if (!testProc || !loopback) {
    console.log('[SECURITY] STOCKKAR_' + key + '_API_HOST=' + host + ' IGNORED ('
      + (!testProc ? 'not a test process' : 'not loopback') + ') - using the real broker ' + realHost);
    return real;
  }
  const ep = {
    hostname: String(host).trim(),
    port: Number(process.env['STOCKKAR_' + key + '_API_PORT'] || 443),
    proto: process.env['STOCKKAR_' + key + '_API_PROTO'] === 'http' ? 'http' : 'https',
    real: false,
  };
  console.log('[TEST] ' + key + ' transport points at ' + ep.hostname + ':' + ep.port + ' (fake broker harness) - NO REAL ORDERS');
  return ep;
}

const transportFor = (ep) => ((ep && ep.proto === 'http') ? http : https);

module.exports = { endpointFor, transportFor };
