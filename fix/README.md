# Sewer — single-file launcher

## Download

`Sewer.exe` in the repository root (about 8.3 MB). Download it and double-click. Nothing else to
install, unzip, or copy — the game files, including the missing `libdl.dll`, are embedded.

On first launch it unpacks everything to `%LOCALAPPDATA%\SewerGame\x64` and starts the game.
Later launches skip the unpack and go straight to the game.

If Windows SmartScreen says "Windows protected your PC", choose **More info → Run anyway**; the
executable is not code-signed.

## Why the original release failed

The release zip was missing `libdl.dll`. `libgomp-1.dll` (the OpenMP runtime) imports
`dlopen`, `dlerror`, `dlsym` and `dlclose` from it, so Windows refused to start `sewer.exe` with
"libdl.dll was not found", or — if some unrelated `libdl.dll` was picked up from `PATH` —
"the procedure entry point dlclose could not be located".

`libdl.dll` in this folder is a 6 KB shim that exports exactly those four functions, built for
this archive's x86-64/UCRT `libgomp-1.dll`.

## How the single file works

```
Sewer.exe = [ launcher ][ payload ][ uint32 payload length ]
```

The launcher reads the 4-byte length trailer, checks for
`%LOCALAPPDATA%\SewerGame\x64\sewer.exe`, and unpacks the payload there if missing, then runs it
with whatever arguments you passed.

The payload is a flat container — `"WSPK"`, file count, then name/length/data per file — so the
launcher needs no ZIP library and no `tar.exe`.

## Rebuilding

Needs `x86_64-w64-mingw32-gcc` and Node.js:

```bash
x86_64-w64-mingw32-gcc -O0 -municode -mwindows -o launcher.bin fix/launcher.c
node fix/pack.js path/to/Sewer ./Sewer.exe ./launcher.bin
```

`pack.js` takes `[sourceFolder] [outputExe] [launcherExe]`.

To regenerate the shim from a release folder:

```bash
node fix/build-libdl.js path/to/Sewer
```

## Verified

- All 13 embedded files unpack byte-identical to the originals.
- Second launch reuses the existing install and launches directly.
- `sewer.exe` runs from the unpacked folder: `smoke ok: 2122 tris`, exit 0.
- Without `libdl.dll` the game fails to start (exit 53), confirming the shim is the fix.

## Contents

`sewer.exe`, `libdl.dll`, `libgomp-1.dll`, `libgcc_s_seh-1.dll`, `libstdc++-6.dll`,
`libwinpthread-1.dll`, `map.bin`, `monster.bin`, and the PNG assets.
