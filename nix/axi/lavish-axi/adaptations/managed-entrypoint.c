/* PAP-197 phase-1 gate. Intentionally does not load Node, upstream modules,
 * configuration, documents, state or sockets. Native code avoids interpreter
 * startup hooks (NODE_OPTIONS/NODE_PATH/BASH_ENV/PYTHONPATH). No runtime protocol
 * is supported until the owned, confined lifecycle is independently qualified. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern char **environ;

static int reject(const char *code, const char *message, int status) {
  fprintf(stderr, "%s: %s\n", code, message);
  return status;
}

static int unsafe_environment(void) {
  const char *names[] = {"NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV",
                        "LD_PRELOAD", "LD_LIBRARY_PATH", NULL};
  for (size_t i = 0; names[i] != NULL; ++i)
    if (getenv(names[i]) != NULL) return 1;
  for (char **p = environ; *p != NULL; ++p)
    if (strncmp(*p, "LAVISH_AXI_", 11) == 0) return 1;
  return 0;
}

int main(int argc, char **argv) {
  if (unsafe_environment())
    return reject("ARTIFACT_POLICY_REJECTED", "Unsafe inherited configuration.", 5);
  if (argc == 2 && strcmp(argv[1], "--help") == 0) {
    puts("Managed lavish-axi 0.1.67 (PAP-197 phase 1).\n"
         "Selection: enableLavishAxi=false by default.\n"
         "Metadata only: --help, --version. Review runtime is fail-closed pending\n"
         "owned lifecycle, route/file confinement and installed/browser qualification.\n"
         "No upstream arguments, setup, sharing, uploads or updates are supported.");
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    puts("0.1.67 (pa-managed-gate/v1; review unavailable)");
    return 0;
  }
  if (argc > 1) {
    const char *denied[] = {"share", "upload", "update", "self-update", "setup",
                            "server", "open", "poll", "end", "stop", "export",
                            "--managed-review-v1", NULL};
    for (size_t i = 0; denied[i] != NULL; ++i)
      if (strcmp(argv[1], denied[i]) == 0)
        return reject("ARTIFACT_POLICY_REJECTED", "Managed review runtime is not qualified.", 5);
  }
  return reject("ARTIFACT_USAGE_INVALID", "Unsupported managed runtime arguments.", 2);
}
