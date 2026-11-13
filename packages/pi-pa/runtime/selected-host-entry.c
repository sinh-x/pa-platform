/* PAP-298: pre-Node boundary for the NON-DEFAULT offline qualification only.
 * Statically linked: loader/preload variables cannot execute code in this entry
 * before its checks. This is not installed custody or a document-read grant.
 * selection.h is emitted by the fixed Nix build, never supplied at runtime. */
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "selection.h"

extern char **environ;

static int denied(void) {
  fputs("Selected-host qualification did not start.\n"
    "Condition: The selected Node and Pi host were not executed by this entry.\n"
    "Source: Fixed pre-Node launch boundary (SELECTED_HOST_ENTRY).\n"
    "Reason: The initial executable, arguments or startup environment did not meet the fixed launch contract, or execution failed.\n"
    "Correction: Ask the runtime owner to inspect this exact launch candidate. Impact: none. Actor: agent or operator. New approval: not required to ask; repairs require their owner. Prerequisite: retain this result and keep hard-link support disabled.\n"
    "Resume Action: Repeat qualification only after the owner corrects the launch contract. All checks run again; this is not installation or permission to read denied files.\n", stderr);
  return 1;
}

static int conflict(const char *entry) {
  const char *equal = strchr(entry, '=');
  if (!equal || equal[1] == '\0') return 0;
  /* Reject whole startup namespaces, not just today's --require spelling.
   * No inherited option is scrubbed and then silently re-authorized. */
  return strncmp(entry, "NODE_", 5) == 0
    || strncmp(entry, "LD_", 3) == 0
    || strncmp(entry, "DYLD_", 5) == 0
    || strncmp(entry, "NIX_LD", 6) == 0
    || strncmp(entry, "GLIBC_TUNABLES=", 15) == 0
    || strncmp(entry, "PI_PACKAGE_DIR=", 15) == 0
    || strncmp(entry, "PA_PI_START_NODE_OPTIONS=", 24) == 0;
}

int main(int argc, char **argv) {
  char executable[PATH_MAX + 1];
  ssize_t length = readlink("/proc/self/exe", executable, PATH_MAX);
  if (length < 0 || length >= PATH_MAX) return denied();
  executable[length] = '\0';
  if (argc != 1 || strcmp(executable, SELECTED_ENTRY) != 0
      || strcmp(argv[0], SELECTED_ENTRY) != 0) return denied();
  for (char **entry = environ; *entry; ++entry) if (conflict(*entry)) return denied();
  char *const args[] = { SELECTED_NODE, SELECTED_BOOTSTRAP, NULL };
  execve(SELECTED_NODE, args, environ);
  return denied();
}
