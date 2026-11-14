/* PAP-298: pre-Node boundary for the NON-DEFAULT offline qualification only.
 * Statically linked: loader/preload variables cannot execute code in this entry
 * before its checks. This is not installed custody or a document-read grant.
 * selection.h is emitted by the fixed Nix build, never supplied at runtime. */
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <limits.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/wait.h>
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
  if (!equal) return 1;
  /* Fixed offline qualification only: a finite environment, not an expanding
   * denylist of Node/OpenSSL/libc startup hooks. Unknown keys reject, even empty.
   * Production provider/session environment requires its own reviewed contract. */
  static const char *const allowed[] = { "HOME", "PI_CODING_AGENT_DIR", "XDG_CACHE_HOME",
    "TMPDIR", "NO_COLOR", "TERM" };
  size_t length = (size_t)(equal - entry);
  for (size_t i = 0; i < sizeof(allowed) / sizeof(allowed[0]); ++i)
    if (strlen(allowed[i]) == length && strncmp(entry, allowed[i], length) == 0) return 0;
  return 1;
}

#ifdef SELECTED_SUPERVISED
/* Validate the literal initial code inputs BEFORE Node can import any JS.
 * No caller path is accepted. Root is trusted; mutable/foreign ancestors and
 * symlinks are not. The builder supplies a canonical Node executable. */
static int immutable_code(const char *path) {
  char buffer[PATH_MAX + 1], *save = NULL;
  size_t length = strlen(path);
  if (length > PATH_MAX || strncmp(path, "/nix/store/", 11) != 0) return -1;
  memcpy(buffer, path, length + 1);
  int parent = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat observed;
  if (parent < 0) return -1;
  if (fstat(parent, &observed) != 0 || observed.st_uid != 0 || (observed.st_mode & 0022) != 0) { close(parent); return -1; }
  char *part = strtok_r(buffer + 1, "/", &save);
  unsigned depth = 0;
  while (part) {
    char *next = strtok_r(NULL, "/", &save);
    if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0) { close(parent); return -1; }
    int child = openat(parent, part, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (next ? O_DIRECTORY : 0));
    int released = close(parent);
    if (child < 0) return -1;
    if (released != 0) { close(child); return -1; }
    depth++;
    if (fstat(child, &observed) != 0 || observed.st_uid != 0 || observed.st_nlink == 0
        || (next ? !S_ISDIR(observed.st_mode) : !S_ISREG(observed.st_mode))) { close(child); return -1; }
    int safe = depth == 2 ? (observed.st_mode & 0022) == 0 || ((observed.st_mode & 01000) != 0 && (observed.st_mode & 0002) == 0)
      : (observed.st_mode & (depth >= 3 ? 0222 : 0022)) == 0;
    if (!safe) { close(child); return -1; }
    parent = child; part = next;
  }
  return parent;
}
static int initial_code_is_immutable(void) {
  const char *paths[] = { SELECTED_ENTRY, SELECTED_NODE, SELECTED_BOOTSTRAP, SELECTED_SELECTION };
  int failed = 0;
  struct stat entry, executing;
  for (size_t i = 0; i < sizeof(paths) / sizeof(paths[0]); ++i) {
    int fd = immutable_code(paths[i]);
    if (fd < 0) { failed = 1; continue; }
    if (i == 0 && (fstat(fd, &entry) != 0 || stat("/proc/self/exe", &executing) != 0
        || entry.st_dev != executing.st_dev || entry.st_ino != executing.st_ino)) failed = 1;
    if (close(fd) != 0) failed = 1;
  }
  return !failed;
}
static volatile sig_atomic_t child_pid = -1;
static void forward_signal(int number) { if (child_pid > 0) kill(child_pid, number); }
static int supervision_unknown(void) {
  fputs("Selected-host qualification outcome is unknown.\n"
    "Condition: The fixed child was started; its completion could not be established.\n"
    "Source: Fixed native child supervision (SELECTED_HOST_SUPERVISION).\n"
    "Reason: The native parent could not obtain the owned child's final status. Earlier output may already have been delivered.\n"
    "Correction: Ask the runtime owner to inspect this existing qualification process and result. Impact: none. Actor: agent or operator. New approval: not required to ask; repairs require their owner. Prerequisite: retain existing evidence and keep production support disabled.\n"
    "Resume Action: Do not repeat qualification until the owner establishes the original child outcome or authorizes recovery. No read grant or installation follows from this result.\n", stderr);
  return 1;
}
#endif

int main(int argc, char **argv) {
  char executable[PATH_MAX + 1];
  ssize_t length = readlink("/proc/self/exe", executable, PATH_MAX);
  if (length < 0 || length >= PATH_MAX) return denied();
  executable[length] = '\0';
  if (argc != 1 || strcmp(executable, SELECTED_ENTRY) != 0
      || strcmp(argv[0], SELECTED_ENTRY) != 0) return denied();
  for (char **entry = environ; *entry; ++entry) if (conflict(*entry)) return denied();
  char *const args[] = { SELECTED_NODE, SELECTED_BOOTSTRAP, NULL };
#ifdef SELECTED_SUPERVISED
  /* The immutable native parent stays alive and can spawn ONLY this fixed child.
   * The JS producer verifies the kernel parent executable/birth on every read;
   * neither environment text nor an inherited caller-mintable token is proof. */
  if (!initial_code_is_immutable()) return denied();
  pid_t parent = getpid();
  pid_t child = fork();
  if (child < 0) return denied();
  if (child == 0) {
    if (prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || getppid() != parent) return denied();
    execve(SELECTED_NODE, args, environ);
    return denied();
  }
  child_pid = child;
  struct sigaction action = {0};
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL); sigaction(SIGHUP, &action, NULL);
  int status;
  while (waitpid(child, &status, 0) < 0) { if (errno != EINTR) return supervision_unknown(); }
  return WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 1;
#else
  execve(SELECTED_NODE, args, environ);
  return denied();
#endif
}
