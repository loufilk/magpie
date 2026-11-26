// Isolate the real diagnostic CLI from sockets, Docker and external HTTP.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

dns.lookup = async () => [];
dgram.createSocket = () => {
  const socket = new EventEmitter();
  socket.bind = () => queueMicrotask(() => socket.emit('error', Object.assign(new Error('Test socket disabled'), { code: 'EACCES' })));
  socket.close = () => {};
  return socket;
};
childProcess.spawnSync = () => ({ status: 1, stdout: '' });
syncBuiltinESMExports();

const status = JSON.parse(process.env.ANTSEED_DIAGNOSTIC_TEST_STATUS);
const httpStatus = Number(process.env.ANTSEED_DIAGNOSTIC_TEST_HTTP_STATUS ?? 200);
const replies = new Map([
  ['http://127.0.0.1:28377/_antseed/status', status],
  ['http://127.0.0.1:28377/_antseed/peers', []],
  ['http://127.0.0.1:28377/v1/models?type=text', { data: [] }],
  ['https://antscan.co/api/marketplace?limit=1', {}],
]);
let unexpectedRequest = false;
globalThis.fetch = async (url, init) => {
  try {
    assert.equal(init?.method, 'GET');
    assert.ok(replies.has(url), `Unexpected diagnostic request: ${url}`);
  } catch (error) {
    unexpectedRequest = true;
    throw error;
  }
  return Response.json(replies.get(url), { status: url.endsWith('/_antseed/status') ? httpStatus : 200 });
};
process.on('exit', () => { if (unexpectedRequest) process.exitCode = 1; });
