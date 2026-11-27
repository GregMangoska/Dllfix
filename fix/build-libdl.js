// Build a minimal, self-contained libdl.dll (PE32+ / x86-64) for the MinGW-w64 build of
// libgomp-1.dll shipped with Sewer.
//
// Why: libgomp-1.dll imports libdl.dll (dlopen, dlerror, dlsym, dlclose). MinGW's libdl is
// usually folded into libgcc, so the archive ships without it and Windows fails to start the
// game with "libdl.dll was not found".
//
// The shim forwards the four functions to LoadLibraryA / GetProcAddress / FreeLibrary and
// tracks the last error string for dlerror().
//
// Usage: node build-libdl.js [releaseFolder]
"use strict";
const fs = require("fs");
const path = require("path");

const OUT_DIR = process.argv[2] || path.join(__dirname, "Sewer");
const OUT_FILE = path.join(OUT_DIR, "libdl.dll");

// ----------------------------------------------------------------- PE reading
function sectionsOf(b) {
  const pe = b.readUInt32LE(0x3c);
  const n = b.readUInt16LE(pe + 6);
  const opt = pe + 24;
  const st = opt + b.readUInt16LE(pe + 20);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = st + i * 40;
    out.push({
      va: b.readUInt32LE(o + 12),
      vs: b.readUInt32LE(o + 8),
      raw: b.readUInt32LE(o + 20),
      rs: b.readUInt32LE(o + 16),
    });
  }
  return out;
}

function importsOf(b) {
  const pe = b.readUInt32LE(0x3c);
  const opt = pe + 24;
  const off = b.readUInt16LE(opt) === 0x20b ? 112 : 96;
  const impRVA = b.readUInt32LE(opt + off + 8);
  const secs = sectionsOf(b);
  const r2o = (r) => {
    for (const s of secs) if (r >= s.va && r < s.va + Math.max(s.vs, s.rs)) return s.raw + (r - s.va);
    return -1;
  };
  const out = [];
  let p = r2o(impRVA);
  while (p > 0) {
    const nameRVA = b.readUInt32LE(p + 12);
    if (!nameRVA) break;
    const o = r2o(nameRVA);
    const dll = b.toString("ascii", o, b.indexOf(0, o));
    let q = r2o(b.readUInt32LE(p));
    while (q > 0) {
      const v = Number(b.readBigUInt64LE(q));
      if (v === 0) break;
      if (!(v < 0)) {
        const h = r2o(v);
        out.push({ dll, fn: b.toString("latin1", h + 2, b.indexOf(0, h + 2)) });
      }
      q += 8;
    }
    p += 20;
  }
  return out;
}

// -------------------------------------------------- what does the game need?
const needed = new Set();
for (const f of fs.readdirSync(OUT_DIR)) {
  if (!/\.(dll|exe)$/i.test(f)) continue;
  for (const e of importsOf(fs.readFileSync(path.join(OUT_DIR, f)))) {
    if (e.dll.toLowerCase() === "libdl.dll") needed.add(e.fn);
  }
}
if (needed.size === 0) {
  console.error("no module in " + OUT_DIR + " imports libdl.dll");
  process.exit(1);
}
const exportsList = [...needed].sort();
const stubNames = [...exportsList];
const unknown = exportsList.filter((n) => !["dlopen", "dlerror", "dlsym", "dlclose"].includes(n));
if (unknown.length) {
  console.error("libdl.dll is expected to export more than dl*: " + unknown.join(", "));
  process.exit(1);
}

// ------------------------------------------------------------ code generation
// All code is x86-64, Windows x64 calling convention (rcx, rdx, r8, r9), 16-byte aligned stack.
//
//   g_lastError  char[MAX_PATH is overkill] -> we store the DLL name of the failed dlopen
//   dlopen(file, flags)  : LoadLibraryA(file); on NULL remember error text; return handle
//   dlerror()            : return pointer to stored text (or NULL when empty) and clear it
//   dlsym(handle, name)  : GetProcAddress(handle, name)
//   dlclose(handle)      : FreeLibrary(handle); return 0 on success, -1 on failure
const stubSize = 64; // max bytes per stub
const stubAlign = 16;
const MAXERR = 192; // buffer for the formatted error message
const TEXTVIRT = 0x1000; // RVA where the .text section will live (first section)
const textVA = TEXTVIRT;

const text = [];
const sym = {};
// fixeds: code bytes first, real VAs patched once the layout is known
const fixeds = [];
function here() {
  return text.length;
}
function bytes(...b) {
  text.push(...b);
}
// emits "ff 15 disp32" (call [rip+d]), "ff 25 disp32" (jmp [rip+d]) or "lea r*, [rip+d]"
function rel32(targetSymbol) {
  fixeds.push({ at: text.length, target: targetSymbol });
  const buf = Buffer.alloc(4);
  text.push(...buf);
}

// start every stub at a 16-byte boundary
function beginStub(name) {
  while (text.length % stubAlign !== 0) text.push(0xcc);
  sym[name] = here();
}

// --- dlopen ---------------------------------------------------------------
beginStub("dlopen");
bytes(0x48, 0x83, 0xec, 0x38); // sub rsp, 0x38
bytes(0xff, 0x15);
rel32("impLag"); // call [rip+LoadLibraryA]
bytes(0x48, 0x85, 0xc0); // test rax, rax
bytes(0x0f, 0x85);
const jeOk = here(); // jne ok (rel32 patched below)
bytes(0, 0, 0, 0);
bytes(0xff, 0x15);
rel32("impGle"); // call [rip+GetLastError]
bytes(0x89, 0xc1); // mov ecx, eax
bytes(0x48, 0x8d, 0x15);
rel32("lastError"); // lea rdx, [rip+lastError]
bytes(0x41, 0xb8);
{
  const b = Buffer.alloc(4);
  b.writeUInt32LE(MAXERR);
  text.push(...b);
} // mov r8d, MAXERR
bytes(0xff, 0x15);
rel32("impFma"); // call [rip+FormatMessageA]
{
  const b = Buffer.alloc(4);
  b.writeInt32LE(here() - (jeOk + 4));
  for (let i = 0; i < 4; i++) text[jeOk + i] = b[i];
}
bytes(0x48, 0x83, 0xc4, 0x38); // add rsp, 0x38
bytes(0xc3); // ret
if (text.length - sym.dlopen > stubSize) throw new Error("dlopen stub too big");

// --- dlerror --------------------------------------------------------------
beginStub("dlerror");
bytes(0x48, 0x8d, 0x05);
rel32("lastError"); // lea rax, [rip+lastError]
bytes(0x80, 0x38, 0x00); // cmp byte [rax], 0
bytes(0x75, 0x02); // jne done
bytes(0x31, 0xc0); // xor eax, eax (return NULL when no error is recorded)
bytes(0xc3); // ret
if (text.length - sym.dlerror > stubSize) throw new Error("dlerror stub too big");

// --- dlsym ----------------------------------------------------------------
beginStub("dlsym");
bytes(0xff, 0x25);
rel32("impGpa"); // jmp [rip+GetProcAddress]
if (text.length - sym.dlsym > stubSize) throw new Error("dlsym stub too big");

// --- dlclose --------------------------------------------------------------
beginStub("dlclose");
bytes(0xff, 0x25);
rel32("impFree"); // jmp [rip+FreeLibrary]
if (text.length - sym.dlclose > stubSize) throw new Error("dlclose stub too big");

const textBytes = text.length;
const pad = (n) => (n + 0xf) & ~0xf;
const textSize = Math.max(pad(textBytes), ...exportsList.map(() => stubSize));

// ------------------------------------------------------------- section setup
const ALIGN = 0x1000;
const FILEALIGN = 0x200;
const round = (v, a) => Math.ceil(v / a) * a;

const k32 = ["LoadLibraryA", "GetProcAddress", "FreeLibrary", "GetLastError", "FormatMessageA"];
const lastErrorRVA = TEXTVIRT + textSize; // keep it inside .text to avoid an extra section
const totalTextRVA = round(lastErrorRVA + MAXERR, 0x10);

let va = TEXTVIRT + totalTextRVA;
va = round(va, ALIGN);
const idataVA = va;

// .idata layout: descriptors | thunk arrays | IAT | names | hint/name entries
let c = idataVA + 40; // one descriptor + null terminator
const alignTo = (n) => (c = round(c, n));
const descVA = idataVA;
alignTo(8);
const thunkVA = c;
c += (k32.length + 1) * 8;
alignTo(8);
const iatVA = c;
c += (k32.length + 1) * 8;
const dllNameVA = c;
c += "KERNEL32.dll".length + 1;
const hintVA = {};
for (const f of k32) {
  alignTo(2);
  hintVA[f] = c;
  c += 2 + f.length + 1;
}
const idataSize = c - idataVA;
const idataFileSize = round(idataSize, FILEALIGN);
va = round(idataVA + idataSize, ALIGN);

const edataVA = va;
let e = edataVA + 40;
const aofVA = e;
e += exportsList.length * 4;
const aonVA = e;
e += exportsList.length * 4;
const aooVA = e;
e += exportsList.length * 2;
const expDllNameVA = e;
e += "libdl.dll".length + 1;
const expNameVA = {};
for (const n of exportsList) {
  expNameVA[n] = e;
  e += n.length + 1;
}
const edataSize = e - edataVA;
const edataFileSize = round(edataSize, FILEALIGN);
va = round(edataVA + edataSize, ALIGN);

// absolute VAs for rip-relative references used by the code
sym.impLag = iatVA + k32.indexOf("LoadLibraryA") * 8;
sym.impGpa = iatVA + k32.indexOf("GetProcAddress") * 8;
sym.impFree = iatVA + k32.indexOf("FreeLibrary") * 8;
sym.impGle = iatVA + k32.indexOf("GetLastError") * 8;
sym.impFma = iatVA + k32.indexOf("FormatMessageA") * 8;
sym.lastError = lastErrorRVA;

const code = Buffer.alloc(totalTextRVA);
Buffer.from(text).copy(code);
for (const f of fixeds) {
  const fieldRVA = TEXTVIRT + f.at;
  code.writeInt32LE(sym[f.target] - (fieldRVA + 4), f.at);
}

// ---------------------------------------------------------------- emit image
const headersSize = FILEALIGN;
// base relocations: absolute addresses that point into .idata (the import descriptors and
// thunk tables). Without this the loader may refuse to relocate the image under ASLR.
const relocEntries = []; // {rva, type}
const addReloc = (rva, type) => relocEntries.push({ rva, type });
// import descriptors carry absolute 32-bit RVAs
addReloc(descVA + 0, 3); // OriginalFirstThunk
addReloc(descVA + 12, 3); // Name
addReloc(descVA + 16, 3); // FirstThunk (IAT)
// thunk arrays and IAT hold real addresses: IMAGE_REL_BASED_DIR64 entries
for (const f of k32) {
  addReloc(thunkVA + k32.indexOf(f) * 8, 10);
  addReloc(iatVA + k32.indexOf(f) * 8, 10);
}
const relocBlock = Buffer.alloc(8 + relocEntries.length * 2);
relocBlock.writeUInt32LE(0, 0); // page RVA (patched below)
relocBlock.writeUInt32LE(relocBlock.length, 4);
relocEntries.forEach((e, i) => {
  relocBlock.writeUInt16LE((e.type << 12) | (e.rva & 0xfff), 8 + i * 2);
});
const relocVA = round(edataVA + edataSize, ALIGN);
relocBlock.writeUInt32LE(relocVA, 0);
const secs = [
  { name: ".text", va: textVA, data: code, flags: 0x60000020 },
  { name: ".idata", va: idataVA, data: Buffer.alloc(idataFileSize), flags: 0xc0000040 },
  { name: ".edata", va: edataVA, data: Buffer.alloc(edataFileSize), flags: 0x40000040 },
  { name: ".reloc", va: relocVA, data: Buffer.alloc(round(relocBlock.length, FILEALIGN)), flags: 0x42000040 },
];
relocBlock.copy(secs[3].data, 0);
let fp = headersSize;
for (const s of secs) {
  s.file = fp;
  fp += s.data.length;
}
const sizeOfImageFinal = round(relocVA + relocBlock.length, ALIGN);
const img = Buffer.alloc(fp);
const va2file = (rva) => {
  for (const s of secs) if (rva >= s.va && rva < s.va + s.data.length) return s.file + (rva - s.va);
  return -1;
};


// .idata content
const idataB = secs[1].data;
const put = (rva, buf) => buf.copy(idataB, rva - idataVA);
put(dllNameVA, Buffer.from("KERNEL32.dll\0", "ascii"));
k32.forEach((f, i) => {
  put(hintVA[f], Buffer.concat([Buffer.from([0, 0]), Buffer.from(f + "\0", "ascii")]));
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(hintVA[f]));
  put(thunkVA + i * 8, b);
  put(iatVA + i * 8, b);
});
put(descVA, Buffer.from([
  ...le32(thunkVA), ...le32(0), ...le32(0), ...le32(dllNameVA), ...le32(iatVA),
]));
function le32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

// .edata content
const edB = secs[2].data;
const putE = (rva, buf) => buf.copy(edB, rva - edataVA);
{
  const h = Buffer.alloc(40);
  h.writeUInt32LE(expDllNameVA, 12); // name RVA
  h.writeUInt32LE(1, 16); // ordinal base
  h.writeUInt32LE(exportsList.length, 20); // number of functions
  h.writeUInt32LE(exportsList.length, 24); // number of names
  h.writeUInt32LE(aofVA, 28);
  h.writeUInt32LE(aonVA, 32);
  h.writeUInt32LE(aooVA, 36);
  putE(edataVA, h);
  putE(expDllNameVA, Buffer.from("libdl.dll\0", "ascii"));
  exportsList.forEach((n, i) => {
    putE(aofVA + i * 4, le32(TEXTVIRT + sym[n]));
    putE(aonVA + i * 4, le32(expNameVA[n]));
    const o = Buffer.alloc(2);
    o.writeUInt16LE(i);
    putE(aooVA + i * 2, o);
    putE(expNameVA[n], Buffer.from(n + "\0", "ascii"));
  });
}

// headers
img.write("MZ", 0, "ascii");
img.writeUInt32LE(0x40, 0x3c);
img.write("PE\0\0", 0x40, "ascii");
const coff = 0x44;
img.writeUInt16LE(0x8664, coff);
img.writeUInt16LE(secs.length, coff + 2);
img.writeUInt16LE(240, coff + 16);
img.writeUInt16LE(0x2102, coff + 18); // EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE | DLL
const O = coff + 20;
img.writeUInt16LE(0x20b, O);
img.writeUInt32LE(secs[0].data.length, O + 4); // size of code
img.writeUInt32LE(sizeOfImageFinal - headersSize - secs[0].data.length, O + 8); // initialized data
img.writeUInt32LE(0, O + 12); // uninitialized data
img.writeUInt32LE(0, O + 16); // entry point (no DllMain)
img.writeUInt32LE(textVA, O + 20); // base of code
img.writeBigUInt64LE(0x10000000n, O + 24); // ImageBase
img.writeUInt32LE(ALIGN, O + 32);
img.writeUInt32LE(FILEALIGN, O + 36);
img.writeUInt16LE(6, O + 40);
img.writeUInt16LE(0, O + 42);
img.writeUInt32LE(0, O + 44);
img.writeUInt32LE(0, O + 48);
img.writeUInt32LE(0, O + 52);
img.writeUInt32LE(sizeOfImageFinal, O + 56);
img.writeUInt32LE(headersSize, O + 60);
img.writeUInt16LE(3, O + 68);
img.writeUInt16LE(0x40, O + 70); // DYNAMIC_BASE
img.writeBigUInt64LE(0x100000n, O + 72);
img.writeBigUInt64LE(0x1000n, O + 80);
img.writeBigUInt64LE(0x100000n, O + 88);
img.writeUInt32LE(0, O + 96);
img.writeUInt32LE(16, O + 108);
const dd = (i, rva, size) => {
  img.writeUInt32LE(rva, O + 112 + i * 8);
  img.writeUInt32LE(size, O + 112 + i * 8 + 4);
};
dd(0, edataVA, edataSize);
dd(1, idataVA, idataSize);
dd(5, relocVA, relocBlock.length); // base relocations
dd(12, iatVA, (k32.length + 1) * 8);

const sh = O + 240;
secs.forEach((s, i) => {
  const o = sh + i * 40;
  img.write(s.name.padEnd(8, "\0"), o, 8, "ascii");
  img.writeUInt32LE(s.name === ".text" ? totalTextRVA : s.data.length, o + 8);
  img.writeUInt32LE(s.va, o + 12);
  img.writeUInt32LE(s.data.length, o + 16);
  img.writeUInt32LE(s.file, o + 20);
  img.writeUInt32LE(s.flags, o + 36);
});

// write sections last, after .idata/.edata contents were filled in
for (const s of secs) s.data.copy(img, s.file);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, img);
console.log(`wrote ${OUT_FILE} (${img.length} bytes), exports: ${exportsList.join(", ")}`);
