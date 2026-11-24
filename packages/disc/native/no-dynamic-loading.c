/* UBVE read-only build: never load decryption, JVM, or other native libraries. */
#include <stddef.h>
void *dl_dlopen(const char *path, const char *version) { (void)path; (void)version; return NULL; }
void *dl_dlsym(void *handle, const char *symbol) { (void)handle; (void)symbol; return NULL; }
int dl_dlclose(void *handle) { (void)handle; return 0; }
const char *dl_get_path(void) { return NULL; }
