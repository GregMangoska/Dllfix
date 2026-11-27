/* Self-extracting single-file launcher for Sewer.
 *
 * Produced file layout:
 *     [ this launcher ][ payload names+data ][ payload directory ][ uint32 payload length ]
 *
 * Rather than depend on tar.exe or a zip library, the payload is a flat, self-describing blob:
 *
 *     uint32 count
 *     repeated { uint32 nameLength, char name[nameLength], uint32 dataLength, byte data[dataLength] }
 *
 * The launcher streams it out of its own executable into the install folder, so it works on every
 * Windows from Vista onwards with no external tools.
 */
#define WIN32_LEAN_AND_MEAN
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define TRAILER_SIZE 4 /* uint32 payload length, last 4 bytes of the file */
#define CHUNK (256 * 1024)
#define PATH_CAP 1024
#define MAX_ENTRIES 4096
#define MAX_NAME 260

static void show_error(const wchar_t *message, DWORD code) {
    wchar_t text[1200];
    _snwprintf(text, 1200, L"%ls (code %lu)", message, (unsigned long)code);
    MessageBoxW(NULL, text, L"Sewer", MB_ICONERROR | MB_OK);
    ExitProcess(1);
}

static BOOL read_at(HANDLE file, LONGLONG offset, void *buffer, DWORD len) {
    LARGE_INTEGER pos;
    DWORD got, total = 0;
    pos.QuadPart = offset;
    if (!SetFilePointerEx(file, pos, NULL, FILE_BEGIN)) return FALSE;
    while (total < len) {
        if (!ReadFile(file, (char *)buffer + total, len - total, &got, NULL)) return FALSE;
        if (got == 0) return FALSE;
        total += got;
    }
    return TRUE;
}

static void make_dirs(const wchar_t *path) {
    wchar_t buffer[PATH_CAP];
    wchar_t *p;
    wcsncpy(buffer, path, PATH_CAP - 1);
    buffer[PATH_CAP - 1] = 0;
    for (p = buffer + 3; *p; ++p) {
        if (*p == L'\\') {
            *p = 0;
            CreateDirectoryW(buffer, NULL);
            *p = L'\\';
        }
    }
    CreateDirectoryW(buffer, NULL);
}

static BOOL is_file(const wchar_t *path) {
    DWORD a = GetFileAttributesW(path);
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

/* Unpacks the payload at `offset` (length `size`) into `dir`. */
static void unpack(HANDLE self, LONGLONG offset, DWORD size, const wchar_t *dir) {
    DWORD magic = 0, count = 0, i;
    char *buffer = (char *)malloc(CHUNK);
    if (!buffer) show_error(L"Not enough memory to unpack the game.", ERROR_NOT_ENOUGH_MEMORY);

    if (!read_at(self, offset, &magic, 4) || magic != 0x504b5357u /* "WSPK" */)
        show_error(L"This file is incomplete. Download Sewer.exe again.", ERROR_FILE_CORRUPT);

    if (!read_at(self, offset + 4, &count, 4) || count == 0 || count > MAX_ENTRIES)
        show_error(L"This file is incomplete. Download Sewer.exe again.", ERROR_FILE_CORRUPT);

    offset += 8;
    for (i = 0; i < count; i++) {
        DWORD nameLen = 0, dataLen = 0, written = 0;
        char name[MAX_NAME + 1];
        wchar_t path[PATH_CAP];
        wchar_t wideName[MAX_NAME + 1];
        HANDLE out;

        if (!read_at(self, offset, &nameLen, 4) || nameLen == 0 || nameLen > MAX_NAME) break;
        offset += 4;
        if (!read_at(self, offset, name, nameLen)) break;
        name[nameLen] = 0;
        offset += nameLen;
        if (!read_at(self, offset, &dataLen, 4)) break;
        offset += 4;

        MultiByteToWideChar(CP_ACP, 0, name, -1, wideName, MAX_NAME + 1);
        _snwprintf(path, PATH_CAP, L"%ls\\%ls", dir, wideName);

        out = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
        if (out == INVALID_HANDLE_VALUE)
            show_error(L"Could not write the game files.\n\n"
                       L"Move Sewer.exe to your Desktop or Documents and try again.", GetLastError());

        while (written < dataLen) {
            DWORD want = (dataLen - written) > CHUNK ? CHUNK : (dataLen - written);
            if (!read_at(self, offset, buffer, want) ||
                !WriteFile(out, buffer, want, &want, NULL) || want == 0) {
                CloseHandle(out);
                free(buffer);
                show_error(L"The program file is incomplete.\nDownload Sewer.exe again.", ERROR_FILE_CORRUPT);
            }
            written += want;
            offset += want;
        }
        CloseHandle(out);
    }
    free(buffer);
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE prev, PWSTR args, int show) {
    wchar_t selfPath[PATH_CAP];
    wchar_t installDir[PATH_CAP];
    wchar_t gameExe[PATH_CAP];
    wchar_t cmd[PATH_CAP * 2];
    LARGE_INTEGER fileSize;
    LONGLONG payloadStart;
    DWORD payloadSize = 0;
    HANDLE self;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    DWORD exitCode = 0;
    (void)instance;
    (void)prev;
    (void)show;

    if (GetModuleFileNameW(NULL, selfPath, PATH_CAP) == 0)
        show_error(L"Could not determine where the program is located.", GetLastError());

    self = CreateFileW(selfPath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (self == INVALID_HANDLE_VALUE) show_error(L"Could not open the program file.", GetLastError());

    if (!GetFileSizeEx(self, &fileSize) || fileSize.QuadPart <= TRAILER_SIZE)
        show_error(L"The program file is incomplete.\nDownload Sewer.exe again.", ERROR_FILE_CORRUPT);

    if (!read_at(self, fileSize.QuadPart - TRAILER_SIZE, &payloadSize, TRAILER_SIZE) ||
        payloadSize == 0 || payloadSize >= fileSize.QuadPart)
        show_error(L"The program file is incomplete.\nDownload Sewer.exe again.", ERROR_FILE_CORRUPT);

    payloadStart = fileSize.QuadPart - TRAILER_SIZE - payloadSize;

    /* Install into %LOCALAPPDATA%\SewerGame so the folder holding Sewer.exe stays clean. */
    if (!GetEnvironmentVariableW(L"LOCALAPPDATA", installDir, PATH_CAP))
        show_error(L"Could not locate your local application data folder.", GetLastError());
    wcsncat(installDir, L"\\SewerGame\\x64", PATH_CAP - wcslen(installDir) - 1);
    make_dirs(installDir);

    _snwprintf(gameExe, PATH_CAP, L"%ls\\sewer.exe", installDir);

    if (!is_file(gameExe)) {
        unpack(self, payloadStart, payloadSize, installDir);
        if (!is_file(gameExe))
            show_error(L"The game files could not be unpacked.\nDownload Sewer.exe again.", ERROR_FILE_CORRUPT);
    }
    CloseHandle(self);

    _snwprintf(cmd, PATH_CAP * 2, L"\"%ls\"%ls", gameExe, args ? args : L"");

    ZeroMemory(&si, sizeof si);
    si.cb = sizeof si;
    if (!CreateProcessW(gameExe, cmd, NULL, NULL, FALSE, 0, NULL, installDir, &si, &pi))
        show_error(L"Could not start the game.", GetLastError());

    WaitForSingleObject(pi.hProcess, INFINITE);
    GetExitCodeProcess(pi.hProcess, &exitCode);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return (int)exitCode;
}
