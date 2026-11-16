/* PAP-298: fixed pre-Node entry. Offline qualification remains the default;
 * SELECTED_PRODUCTION adds only the explicit build-selected PPA host contract.
 * Static linking protects checks from interpreter/loader preloads. selection.h
 * and the finite production environment are emitted by the trusted Nix build. */
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <limits.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "selection.h"
#ifdef SELECTED_PRODUCTION
#include "production-environment.h"
#endif

extern char **environ;

static int denied(void) {
#ifdef SELECTED_PRODUCTION
  fputs("Pi runtime not started through the selected host.\n"
    "Condition: The selected Node and Pi payload were not executed successfully by this entry.\n"
    "Source: Fixed pre-Node launch boundary (SELECTED_HOST_ENTRY).\n"
    "Reason: The executable, startup arguments, immutable build inputs or finite environment did not meet the selected launch contract.\n"
    "Correction: Ask the runtime owner to inspect this launch and its selected build. Impact: none. Actor: agent or operator. New approval: not required to ask. Prerequisite: retain the existing deployment and launch evidence.\n"
    "Resume Action: Retry only after the launch contract is corrected. Admission runs again; do not use another reader or replace an uncertain deployment.\n", stderr);
#else
  fputs("Selected-host qualification did not start.\n"
    "Condition: The selected Node and Pi host were not executed by this entry.\n"
    "Source: Fixed pre-Node launch boundary (SELECTED_HOST_ENTRY).\n"
    "Reason: The initial executable, arguments or startup environment did not meet the fixed launch contract, or execution failed.\n"
    "Correction: Ask the runtime owner to inspect this exact launch candidate. Impact: none. Actor: agent or operator. New approval: not required to ask; repairs require their owner. Prerequisite: retain this result and keep hard-link support disabled.\n"
    "Resume Action: Repeat qualification only after the owner corrects the launch contract. All checks run again; this is not installation or permission to read denied files.\n", stderr);
#endif
  return 1;
}

static int conflict(const char *entry) {
  const char *equal = strchr(entry, '=');
  if (!equal) return 1;
  /* Finite build-selected names, never a prefix allowance or an expanding
   * startup-hook denylist. The default offline qualifier retains its six keys;
   * the explicit production variant uses its separately reviewed contract. */
#ifdef SELECTED_PRODUCTION
  static const char *const allowed[] = SELECTED_ENV_NAMES;
#else
  static const char *const allowed[] = { "HOME", "PI_CODING_AGENT_DIR", "XDG_CACHE_HOME",
    "TMPDIR", "NO_COLOR", "TERM" };
#endif
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
  const char *paths[] = { SELECTED_ENTRY, SELECTED_NODE, SELECTED_BOOTSTRAP, SELECTED_SELECTION
#ifdef SELECTED_PRODUCTION
    , SELECTED_RUNTIME_EXTENSION, SELECTED_NATIVE_ADDON
#endif
  };
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
static void forward_signal(int number) {
  if (child_pid > 0) {
    kill(child_pid, number);
#ifdef SELECTED_PRODUCTION
    /* A managed child may still be held at its native admission gate. Let an
     * already-forwarded termination signal settle it rather than leave a stop. */
    kill(child_pid, SIGCONT);
#endif
  }
}
static int supervision_unknown(void) {
#ifdef SELECTED_PRODUCTION
  fputs("Pi runtime outcome is unknown.\n"
    "Condition: The selected child started; its completion could not be established.\n"
    "Source: Fixed native child supervision (SELECTED_HOST_SUPERVISION).\n"
    "Reason: The native parent could not obtain its child's final status. Earlier output may already have been delivered.\n"
    "Correction: Ask the runtime owner to inspect this existing process and deployment. Impact: none. Actor: agent or operator. New approval: not required to ask. Prerequisite: preserve original launch and process evidence.\n"
    "Resume Action: Do not launch a replacement until the original outcome is established or recovery authorized.\n", stderr);
#else
  fputs("Selected-host qualification outcome is unknown.\n"
    "Condition: The fixed child was started; its completion could not be established.\n"
    "Source: Fixed native child supervision (SELECTED_HOST_SUPERVISION).\n"
    "Reason: The native parent could not obtain the owned child's final status. Earlier output may already have been delivered.\n"
    "Correction: Ask the runtime owner to inspect this existing qualification process and result. Impact: none. Actor: agent or operator. New approval: not required to ask; repairs require their owner. Prerequisite: retain existing evidence and keep production support disabled.\n"
    "Resume Action: Do not repeat qualification until the owner establishes the original child outcome or authorizes recovery. No read grant or installation follows from this result.\n", stderr);
#endif
  return 1;
}
#endif

int main(int argc, char **argv) {
  char executable[PATH_MAX + 1];
  ssize_t length = readlink("/proc/self/exe", executable, PATH_MAX);
  if (length < 0 || length >= PATH_MAX) return denied();
  executable[length] = '\0';
  if (strcmp(executable, SELECTED_ENTRY) != 0 || strcmp(argv[0], SELECTED_ENTRY) != 0) return denied();
  for (char **entry = environ; *entry; ++entry) if (conflict(*entry)) return denied();
#ifdef SELECTED_PRODUCTION
  int managed = argc > 1 && strcmp(argv[1], "--pa-managed-child") == 0;
  int first = managed ? 2 : 1;
  const char *addon = getenv("PA_SQLITE_NATIVE_BINDING"), *pi_addon = getenv("PA_PI_SQLITE_NATIVE_BINDING");
  if ((addon && strcmp(addon, SELECTED_NATIVE_ADDON) != 0)
      || (pi_addon && strcmp(pi_addon, SELECTED_NATIVE_ADDON) != 0)) return denied();
  if (setenv("PA_SQLITE_NATIVE_BINDING", SELECTED_NATIVE_ADDON, 1) != 0
      || setenv("PA_PI_SQLITE_NATIVE_BINDING", SELECTED_NATIVE_ADDON, 1) != 0
      || setenv("PA_REQUIRE_PI_SQLITE_NATIVE_BINDING", "1", 1) != 0
      || setenv("PI_SKIP_VERSION_CHECK", "1", 0) != 0
      || setenv("PI_TELEMETRY", "0", 0) != 0) return denied();
  char **args = calloc((size_t)argc + 3, sizeof(char *));
  if (!args) return denied();
  args[0] = SELECTED_NODE; args[1] = SELECTED_BOOTSTRAP;
  for (int index = first; index < argc; index++) args[index - first + 2] = argv[index];
#else
  if (argc != 1) return denied();
  char *const args[] = { SELECTED_NODE, SELECTED_BOOTSTRAP, NULL };
#endif
#ifdef SELECTED_SUPERVISED
  /* The immutable native parent stays alive and can spawn ONLY this fixed child.
   * The JS producer verifies the kernel parent executable/birth on every read;
   * neither environment text nor an inherited caller-mintable token is proof. */
  if (!initial_code_is_immutable()) return denied();
#ifdef SELECTED_PRODUCTION
  /* Bind the supervisor to its actual launching owner without an environment
   * token. A dying foreground launcher/background runner cannot leave a native
   * admission stop orphaned. No deployment-lifetime kill timer is introduced. */
  pid_t launch_owner = getppid();
  sigset_t blocked, empty;
  sigemptyset(&blocked); sigaddset(&blocked, SIGTERM); sigaddset(&blocked, SIGINT); sigaddset(&blocked, SIGHUP);
  sigemptyset(&empty);
  if (sigprocmask(SIG_BLOCK, &blocked, NULL) != 0) return denied();
  struct sigaction production_action = {0}, default_action = {0};
  production_action.sa_handler = forward_signal; sigemptyset(&production_action.sa_mask);
  default_action.sa_handler = SIG_DFL; sigemptyset(&default_action.sa_mask);
  if (sigaction(SIGTERM, &production_action, NULL) != 0 || sigaction(SIGINT, &production_action, NULL) != 0
      || sigaction(SIGHUP, &production_action, NULL) != 0 || sigaction(SIGCHLD, &default_action, NULL) != 0
      || prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || getppid() != launch_owner) return denied();
#endif
  pid_t parent = getpid();
  pid_t child = fork();
  if (child < 0) return denied();
  if (child == 0) {
#ifdef SELECTED_PRODUCTION
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parent
        || sigaction(SIGTERM, &default_action, NULL) != 0 || sigaction(SIGINT, &default_action, NULL) != 0
        || sigaction(SIGHUP, &default_action, NULL) != 0 || sigprocmask(SIG_SETMASK, &empty, NULL) != 0) return denied();
    /* PPA authenticates and admits this child's exact incarnation while it is
     * still native code. execve keeps that PID/birth for registry/role owners. */
    if (managed && raise(SIGSTOP) != 0) return denied();
#else
    if (prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || getppid() != parent) return denied();
#endif
    execve(SELECTED_NODE, args, environ);
    return denied();
  }
  child_pid = child;
#ifdef SELECTED_PRODUCTION
  if (sigprocmask(SIG_SETMASK, &empty, NULL) != 0) { kill(child, SIGKILL); return supervision_unknown(); }
#else
  struct sigaction action = {0};
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL); sigaction(SIGHUP, &action, NULL);
#endif
  int status;
  while (waitpid(child, &status, 0) < 0) { if (errno != EINTR) return supervision_unknown(); }
  return WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 1;
#else
  execve(SELECTED_NODE, args, environ);
  return denied();
#endif
}
