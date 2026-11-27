# Sewer — single-file launcher

## Download

**`Sewer.exe`** in the repository root (~8.7 MB). Double-click it.

No unzipping, no DLL copying. The game files, including a working `libdl.dll`, are inside.

If SmartScreen warns about an unrecognised app: **More info → Run anyway** (the file is not
code-signed).

## Why you got "entry point dlclose could not be located in libgomp-1.dll"

`libgomp-1.dll` imports four functions from `libdl.dll`. MinGW normally bundles them inside
`libgcc`; this archive shipped neither, so the loader could not satisfy `dlopen`, `dlclose`,
`dlsym`, `dlerror`.

The first version of this fix used a hand-assembled `libdl.dll`. Mistake: hand-built PE export
tables can pass Wine's loader and still be rejected by the real Windows loader, which is exactly
what happened on your machine.

`fix/libdl.dll` is now built by the MinGW-w64 linker like any normal DLL, with `libdl.c` as the
source. It depends only on `KERNEL32.dll` and `msvcrt.dll`, both present on every Windows install.

The launcher also loads it by absolute path before starting the game, so another `libdl.dll`
elsewhere on `PATH` cannot be picked up instead.

## How the single file works

```
Sewer.exe = [ launcher ][ payload ][ uint32 payload length ]
```

The launcher reads the trailer, checks for `%LOCALAPPDATA%\SewerGame\x64\sewer.exe`, unpacks the
payload there if missing, preloads `libdl.dll`, then runs the game.

The payload is a flat container (`"WSPK"`, count, then name/length/data), so no ZIP library or
`tar.exe` is involved.

## Rebuilding

```bash
# the shim
x86_64-w64-mingw32-gcc -shared -O2 -s -o fix/libdl.dll fix/libdl.c \
    -Wl,--out-implib,libdl.dll.a -lkernel32

# the launcher
x86_64-w64-mingw32-gcc -O0 -municode -mwindows -o fix/launcher.bin fix/launcher.c

# the single file
node fix/pack.js path/to/Sewer ./Sewer.exe fix/launcher.bin
```

## Verified

- All 13 embedded files unpack byte-identical to the originals.
- Game runs from the unpacked folder: `smoke ok: 2122 tris`, exit 0.
- Second launch reuses the install and goes straight to the game.

## Contents

`sewer.exe`, `libdl.dll`, `libgomp-1.dll`, `libgcc_s_seh-1.dll`, `libstdc++-6.dll`,
`libwinpthread-1.dll`, `map.bin`, `monster.bin`, and the PNG assets.
