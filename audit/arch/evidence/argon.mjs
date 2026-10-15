import { argon2id } from "/home/user/paperkite-hq/stork/node_modules/@noble/hashes/argon2.js";
import * as nc from "node:crypto";
const salt = new Uint8Array(32);
let t = performance.now();
argon2id("correct horse battery staple", salt, { m: 65536, t: 3, p: 1, dkLen: 32 });
console.log("noble argon2id 64MiB t=3:", Math.round(performance.now() - t), "ms (synchronous, blocks event loop)");
console.log("node:crypto argon2Sync available:", typeof nc.argon2Sync, "(Node 24.7+ has native argon2)");
