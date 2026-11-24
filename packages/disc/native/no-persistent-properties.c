/* UBVE does not read or write libbluray's native per-user playlist preferences.
 * The browser's only file-access authority is the explicitly selected disc. */
#include "properties.h"
#include <stddef.h>

char *bdpriv_properties_get(const char *file, const char *property) {
  (void)file;
  (void)property;
  return NULL;
}

int bdpriv_properties_put(const char *file, const char *property, const char *value) {
  (void)file;
  (void)property;
  (void)value;
  return -1;
}
