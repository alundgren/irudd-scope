import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

export async function packageWindowsLaunchers(source: string, output: string, icon: string) {
  const compiler = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  );
  for (const cli of [false, true]) {
    await promisify(execFile)(
      compiler,
      [
        "/nologo",
        "/platform:x64",
        cli ? "/target:exe" : "/target:winexe",
        ...(cli ? ["/define:SCOPE_CLI"] : []),
        `/win32icon:${icon}`,
        `/out:${join(output, cli ? "irudd-scope.exe" : "Scope.exe")}`,
        source,
      ],
      { windowsHide: true, timeout: 30_000 },
    );
  }
  return icon;
}
