# Sewer: libdl.dll missing on launch

## Symptom

Launching `sewer.exe` on Windows fails before the window opens:

```
The code execution cannot proceed because libdl.dll was not found.
Reinstalling the program may fix this problem.
```

(Or `libdl.dll` is reported as missing from `libgomp-1.dll`.)

## Cause

`Sewer-release.zip` contains a MinGW-w64 (UCRT, x86-64) build. The Dependency Walker view
of the archive looks like this:

| Module             | Imports                                            |
| ------------------ | -------------------------------------------------- |
| `sewer.exe`        | libgcc_s_seh-1, libgomp-1, libstdc++-6, user32, gdi32, gdiplus, opengl32, winmm, kernel32 |
| `libstdc++-6.dll`  | libgcc_s_seh-1, libwinpthread-1                     |
| `libgomp-1.dll`    | **libdl.dll**, libgcc_s_seh-1, libwinpthread-1      |
| `libgcc_s_seh-1`   | libwinpthread-1                                     |
| `libwinpthread-1`  | (system DLLs only)                                  |

`libgomp-1.dll` (the GCC OpenMP runtime) is the only module that needs `libdl.dll`, and it
uses just four functions:

```
dlopen
dlerror
dlsym
dlclose
```

MinGW normally provides those inside `libgcc` (statically linked, or as a `libdl.dll` that
some packaging scripts forget to copy). The release zip ships `libgcc_s_seh-1.dll` but not
`libdl.dll`, so Windows can't resolve the import and refuses to start the game.

## Fix

Add `libdl.dll` next to `sewer.exe`:

```
Sewer/
  sewer.exe
  libdl.dll        <-- add this
  libstdc++-6.dll
  libgcc_s_seh-1.dll
  libgomp-1.dll
  libwinpthread-1.dll
  ...assets...
```

`fix/libdl.dll` is a 6 KB, dependency-free shim built for this exact situation. It exports
`dlopen`, `dlerror`, `dlsym` and `dlclose`, implemented as thin wrappers over
`LoadLibraryA`, `GetProcAddress`, `FreeLibrary` and `FormatMessageA`. That is all
`libgomp` needs; the program never loads extra modules through `dlopen` at runtime, so a
real `libdl` is not required.

Drop it in with Explorer, or from a terminal:

```bat
copy /y libdl.dll "C:\path\to\Sewer\libdl.dll"
```

### Rebuilding the shim

`fix/build-libdl.js` regenerates the DLL (Node.js 18+, no compiler needed):

```bat
node build-libdl.js "C:\path\to\Sewer"
```

It scans the DLLs/EXEs in the target folder, collects whatever they import from `libdl.dll`
and emits a matching PE32+ export table, so it keeps working if the release is rebuilt with
a different libgomp.

## Verified

- `libdl.dll` is PE32+ / machine 0x8664 with sections `.text`, `.idata`, `.edata` and
  `.reloc` (base relocations), so it loads safely under ASLR.
- Its export table resolves `dlopen`, `dlerror`, `dlsym`, `dlclose`, which covers 100% of
  `libgomp-1.dll`'s `libdl.dll` imports (checked by parsing the PE import tables of every
  binary in the archive).
- All other imports (`sewer.exe` → OpenGL32/GDI+/GDI32/USER32/WINMM, the MinGW runtime
  DLL chain, and the UCRT `api-ms-win-crt-*` APIs, which are built into Windows 10/11) are
  satisfied by files already in the zip plus the OS.

## Alternative (if you build from source)

Pass the linker flag `-static-libgcc -static` (or at least `-static-libgcc`) to embed
libdl/libgomp and the runtime DLLs, so no external DLLs are needed at all.
