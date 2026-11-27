/*
 * libdl.dll - dlopen/dlclose/dlsym/dlerror for Windows.
 *
 * The bundled libgomp-1.dll imports these four functions by name. MinGW normally folds them
 * into libgcc (statically) or ships libdl.dll; this archive shipped neither, so sewer.exe
 * failed with "libdl.dll was not found".
 *
 * Deliberately depends on KERNEL32 only: no C runtime, no USER32, so there is nothing extra
 * that can be missing on the target machine.
 */
#include <windows.h>

/* Thread-local error buffer without the C runtime. */
static __declspec(thread) char g_error[512];

void *dlopen(const char *file, int mode) {
    (void)mode;
    if (file == NULL) return (void *)GetModuleHandleA(NULL); /* the main program */
    return (void *)LoadLibraryA(file);
}

void *dlsym(void *handle, const char *name) {
    if (handle == NULL || name == NULL) return NULL;
    return (void *)GetProcAddress((HMODULE)handle, name);
}

int dlclose(void *handle) {
    if (handle == NULL) return -1;
    return FreeLibrary((HMODULE)handle) ? 0 : -1;
}

char *dlerror(void) {
    DWORD error = GetLastError();
    DWORD written = 0;

    if (error == 0) return NULL;

    g_error[0] = '\0';
    written = FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                             NULL, error, 0, g_error, sizeof g_error - 1, NULL);
    if (written == 0) {
        /* Fall back to a plain number when the system has no text for this code. */
        const char digits[] = "0123456789";
        char temp[24];
        int pos = 0;
        DWORD value = error;
        do { temp[pos++] = digits[value % 10]; value /= 10; } while (value && pos < 20);
        {
            int out = 0, i;
            for (i = pos - 1; i >= 0 && out < 500; i--) g_error[out++] = temp[i];
            g_error[out] = '\0';
        }
    }
    return g_error;
}
