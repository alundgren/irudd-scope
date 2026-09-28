#include <stdio.h>
#include <Security/Security.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, const char *argv[]) {
  if (argc == 4 && strcmp(argv[1], "--read-direct") == 0) {
    SecKeychainSetUserInteractionAllowed(false);
    SecKeychainRef keychain = NULL;
    if (SecKeychainOpen(argv[2], &keychain) != errSecSuccess) return 93;
    const char *service = "alundgren.irudd-scope";
    UInt32 length = 0;
    void *value = NULL;
    OSStatus result = SecKeychainFindGenericPassword(keychain, (UInt32)strlen(service), service,
        (UInt32)strlen(argv[3]), argv[3], &length, &value, NULL);
    if (value) SecKeychainItemFreeContent(NULL, value);
    CFRelease(keychain);
    return result == errSecSuccess ? 0 : 3;
  }
  pid_t child = fork();
  if (child < 0) return 90;
  if (child == 0) {
    execl(CREDENTIAL_HELPER_PATH, CREDENTIAL_HELPER_PATH, NULL);
    _exit(91);
  }
  fprintf(stderr, "helper pid: %d\n", child);
  int status;
  struct rusage usage;
  if (wait4(child, &status, 0, &usage) != child || !WIFEXITED(status)) return 92;
  fprintf(stderr, "helper peak RSS bytes: %ld\n", usage.ru_maxrss);
  return WEXITSTATUS(status);
}
