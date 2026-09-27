# Development tools

Keep validation setup outside application packages. Use Node through Vite+
and keep commands portable across Linux and macOS.

`test.ts` resolves Electron before parallel workers and supplies Xvfb when
Linux has no display. Preserve failed exit codes and useful diagnostics.
Child processes must be cleaned up when validation completes or fails.
