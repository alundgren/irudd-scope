"""Sum physical footprint for explicit test-process PIDs, without recording host details."""

import ctypes
import json
import sys


class Usage(ctypes.Structure):
    # rusage_info_v2 from the macOS SDK's sys/resource.h.
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64)
        for name in (
            "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups",
            "pageins", "wired_size", "resident_size", "phys_footprint",
            "proc_start_abstime", "proc_exit_abstime", "child_user_time",
            "child_system_time", "child_pkg_idle_wkups", "child_interrupt_wkups",
            "child_pageins", "child_elapsed_abstime", "diskio_bytesread",
            "diskio_byteswritten",
        )
    ]


library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
library.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
library.proc_pid_rusage.restype = ctypes.c_int
total = 0
for argument in sys.argv[1:]:
    pid = int(argument)
    if pid <= 0:
        raise ValueError("Expected a positive test-process PID.")
    usage = Usage()
    if library.proc_pid_rusage(pid, 2, ctypes.byref(usage)) != 0:
        raise OSError(ctypes.get_errno(), "Could not sample a test process.")
    total += usage.phys_footprint
print(json.dumps({"physicalFootprintBytes": total}))
