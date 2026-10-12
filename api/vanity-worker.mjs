// The `…ads` grinder (a worker thread of api/vanity.mjs): one key per message, as 64 bytes (seed + public key).
import { parentPort, workerData } from 'node:worker_threads';
import crypto from 'node:crypto';

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** The last n base58 characters of 32 bytes: the suffix is the low digits of the big number, no full encode needed. */
function tail(bytes, n) {
  let x = BigInt(`0x${Buffer.from(bytes).toString('hex')}`), out = '';
  for (let i = 0; i < n; i++) { out = A[Number(x % 58n)] + out; x /= 58n; }
  return out;
}
const { suffix } = workerData;
parentPort.on('message', () => {
  for (;;) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    if (tail(pub, suffix.length) !== suffix) continue;
    const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16);
    parentPort.postMessage(Buffer.concat([seed, pub]));
    return;
  }
});
