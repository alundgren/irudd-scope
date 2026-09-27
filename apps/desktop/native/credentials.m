#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <dispatch/dispatch.h>
#include <unistd.h>

static const NSUInteger maximumBytes = 1024 * 1024;

static NSDictionary *signingInformation(SecCodeRef code) {
  SecStaticCodeRef executable = NULL;
  if (SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &executable) != errSecSuccess)
    return nil;
  CFDictionaryRef information = NULL;
  OSStatus status = SecCodeCopySigningInformation(executable, kSecCSSigningInformation, &information);
  CFRelease(executable);
  return status == errSecSuccess ? CFBridgingRelease(information) : nil;
}

static BOOL trustedParent(pid_t pid) {
  if (pid <= 1 || getuid() != geteuid()) return NO;
  SecCodeRef self = NULL;
  SecCodeRef parent = NULL;
  NSDictionary *attributes = @{(__bridge id)kSecGuestAttributePid: @(pid)};
  if (SecCodeCopySelf(kSecCSDefaultFlags, &self) != errSecSuccess) return NO;
  OSStatus status = SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attributes,
                                                  kSecCSDefaultFlags, &parent);
  BOOL trusted = NO;
  if (status == errSecSuccess &&
      SecCodeCheckValidity(self, kSecCSDefaultFlags, NULL) == errSecSuccess &&
      SecCodeCheckValidity(parent, kSecCSDefaultFlags, NULL) == errSecSuccess) {
    NSDictionary *ownInformation = signingInformation(self);
    NSDictionary *parentInformation = signingInformation(parent);
    NSArray *ownCertificates = ownInformation[(__bridge id)kSecCodeInfoCertificates];
    NSArray *parentCertificates = parentInformation[(__bridge id)kSecCodeInfoCertificates];
    NSString *identifier = parentInformation[(__bridge id)kSecCodeInfoIdentifier];
    // A certificate is required: an ad-hoc parent cannot identify itself across updates.
    if ([identifier isEqualToString:@"alundgren.irudd-scope"] &&
        ownCertificates.count > 0 && parentCertificates.count > 0) {
      trusted = CFEqual((__bridge CFTypeRef)ownCertificates[0],
                        (__bridge CFTypeRef)parentCertificates[0]) && getppid() == pid;
    }
  }
  if (parent) CFRelease(parent);
  CFRelease(self);
  return trusted;
}

static NSDictionary *readRequest(void) {
  NSMutableData *data = [NSMutableData data];
  unsigned char buffer[4096];
  ssize_t count;
  while ((count = read(STDIN_FILENO, buffer, sizeof(buffer))) > 0) {
    if (data.length + (NSUInteger)count > maximumBytes) return nil;
    [data appendBytes:buffer length:(NSUInteger)count];
  }
  if (count < 0) return nil;
  id request = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
  if (![request isKindOfClass:[NSDictionary class]]) return nil;
  NSString *operation = request[@"operation"];
  NSString *account = request[@"account"];
  if (![operation isKindOfClass:[NSString class]] ||
      ![@[@"read", @"write", @"delete"] containsObject:operation] ||
      ![account isKindOfClass:[NSString class]] || account.length != 64 ||
      [account rangeOfCharacterFromSet:
          [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]]
          .location != NSNotFound) return nil;
  BOOL writing = [operation isEqualToString:@"write"];
  if (writing && ![request[@"value"] isKindOfClass:[NSString class]]) return nil;
  if ([request count] != (writing ? 3 : 2)) return nil;
  return request;
}

static int performRequest(NSDictionary *request) {
  NSMutableDictionary *query = [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: @"alundgren.irudd-scope",
    (__bridge id)kSecAttrAccount: request[@"account"],
  } mutableCopy];

  // Explicit isolation for the native verification command; never change the search list.
  SecKeychainRef isolatedKeychain = NULL;
  const char *keychainPath = getenv("SCOPE_CREDENTIALS_KEYCHAIN");
  if (keychainPath) {
    if (SecKeychainOpen(keychainPath, &isolatedKeychain) != errSecSuccess) return 3;
    query[(__bridge id)kSecMatchSearchList] = @[(__bridge id)isolatedKeychain];
    SecKeychainSetUserInteractionAllowed(false);
  }

  OSStatus status;
  id value = [NSNull null];
  NSString *operation = request[@"operation"];
  if ([operation isEqualToString:@"read"]) {
    query[(__bridge id)kSecReturnData] = @YES;
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    CFTypeRef result = NULL;
    status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (status == errSecSuccess) {
      NSData *data = CFBridgingRelease(result);
      if (![data isKindOfClass:[NSData class]] || data.length > maximumBytes) status = errSecDecode;
      else {
        value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if (!value) status = errSecDecode;
      }
    } else if (status == errSecItemNotFound) status = errSecSuccess;
  } else if ([operation isEqualToString:@"write"]) {
    NSDictionary *attributes = @{
      (__bridge id)kSecValueData: [request[@"value"] dataUsingEncoding:NSUTF8StringEncoding],
    };
    status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)attributes);
    if (status == errSecItemNotFound) {
      [query removeObjectForKey:(__bridge id)kSecMatchSearchList];
      if (isolatedKeychain) query[(__bridge id)kSecUseKeychain] = (__bridge id)isolatedKeychain;
      [query addEntriesFromDictionary:attributes];
      status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);
    }
  } else {
    status = SecItemDelete((__bridge CFDictionaryRef)query);
    if (status == errSecItemNotFound) status = errSecSuccess;
  }
  if (isolatedKeychain) CFRelease(isolatedKeychain);
  if (status != errSecSuccess) {
    fprintf(stderr, "Scope credential helper: Keychain status %d\n", (int)status);
    return 3;
  }
  NSData *response = [NSJSONSerialization dataWithJSONObject:value
                         options:NSJSONWritingFragmentsAllowed error:NULL];
  if (!response || response.length > maximumBytes) return 4;
  return fwrite(response.bytes, 1, response.length, stdout) == response.length ? 0 : 4;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
      puts(SCOPE_CREDENTIAL_HELPER_VERSION);
      return 0;
    }
    pid_t parent = getppid();
    if (argc != 1 || parent <= 1) return 1;
    __attribute__((objc_precise_lifetime)) dispatch_source_t parentExit =
        dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC,
        (uintptr_t)parent, DISPATCH_PROC_EXIT, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0));
    if (!parentExit) return 1;
    dispatch_source_set_event_handler(parentExit, ^{ _exit(1); });
    dispatch_resume(parentExit);
    if (!trustedParent(parent)) return 1;
    NSDictionary *request = readRequest();
    if (!request) return 2;
    int result = performRequest(request);
    dispatch_source_cancel(parentExit);
    return result;
  }
}
