/* Disconnected test harness only: permit one synthetic public pin and redirect
 * its connect syscall to the owned loopback TLS fixture. All other connects fail.
 * Never linked into or packaged as runtime code. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
int connect(int fd, const struct sockaddr *addr, socklen_t len) {
  int (*real_connect)(int, const struct sockaddr *, socklen_t) = dlsym(RTLD_NEXT, "connect");
  if (addr->sa_family != AF_INET || len < sizeof(struct sockaddr_in)) { errno = ECONNREFUSED; return -1; }
  struct sockaddr_in target = *(const struct sockaddr_in *)addr;
  char text[INET_ADDRSTRLEN]; inet_ntop(AF_INET, &target.sin_addr, text, sizeof(text));
  const char *log = getenv("PA_TEST_CONNECT_LOG");
  if (log) { FILE *f=fopen(log,"a"); if(f) { fprintf(f,"%s:%d\n",text,ntohs(target.sin_port)); fclose(f); } }
  if (strcmp(text, "93.184.216.34") || ntohs(target.sin_port) != 443) { errno=ECONNREFUSED; return -1; }
  target.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  target.sin_port = htons(atoi(getenv("PA_TEST_CONNECT_PORT")));
  return real_connect(fd, (const struct sockaddr *)&target, sizeof(target));
}
