// Builds the single-file Sewer.exe.
//
//   Sewer.exe = [ launcher.bin ][ payload ][ uint32 payload length ]
//
// payload = uint32 "WSPK" magic, uint32 count, then per file:
//           uint32 nameLen, name bytes (ASCII), uint32 dataLen, data bytes
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SRC = process.argv[2] || path.join(__dirname, "Sewer");
const OUT = process.argv[3] || path.join(__dirname, "Sewer.exe");
const LAUNCHER = process.argv[4] || path.join(__dirname, "launcher.bin");

const names = fs
  .readdirSync(SRC)
  .filter((n) => fs.statSync(path.join(SRC, n)).isFile())
  .sort();

const parts = [];
const magic = Buffer.alloc(8);
magic.writeUInt32LE(0x504b5357, 0); // "WSPK"
magic.writeUInt32LE(names.length, 4);
parts.push(magic);

for (const name of names) {
  if (name.length > 260) throw new Error("name too long: " + name);
  const data = fs.readFileSync(path.join(SRC, name));
  const nameBuf = Buffer.from(name, "ascii");
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32LE(nameBuf.length);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length);
  parts.push(hdr, nameBuf, len, data);
}

const payload = Buffer.concat(parts);
if (payload.length > 0xffffffff) throw new Error("payload too large");
const trailer = Buffer.alloc(4);
trailer.writeUInt32LE(payload.length);

const launcher = fs.readFileSync(LAUNCHER);
const exe = Buffer.concat([launcher, payload, trailer]);
fs.writeFileSync(OUT, exe);

console.log(`packed ${names.length} files into ${path.basename(OUT)}`);
console.log(`  launcher : ${launcher.length.toLocaleString()} bytes`);
console.log(`  payload  : ${payload.length.toLocaleString()} bytes`);
console.log(`  total    : ${exe.length.toLocaleString()} bytes`);
console.log(`  sha256   : ${crypto.createHash("sha256").update(exe).digest("hex")}`);
