using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

#if SCOPE_CLI
[assembly: AssemblyProduct("Scope native CLI launcher v1")]
#else
[assembly: AssemblyProduct("Scope native desktop launcher v1")]
#endif

internal static class ScopeLauncher
{
#if SCOPE_CLI
    private const string Identity = "Scope native CLI launcher v1";
#else
    private const string Identity = "Scope native desktop launcher v1";
#endif
    private const string AppId = "alundgren.irudd-scope";

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string executable = Assembly.GetExecutingAssembly().Location;
#if !SCOPE_CLI
            if (args.Length == 2 && args[0] == "--scope-shortcut")
            {
                CreateShortcut(executable, args[1]);
                return 0;
            }
#endif
            string root = Path.GetDirectoryName(executable);
#if SCOPE_CLI
            root = Path.GetDirectoryName(root);
#endif
            string build = ResolveDirectory(Path.Combine(root, "current"));
            string runtime = Path.Combine(build, "Scope", "Scope.exe");
            if (!File.Exists(runtime)) throw new IOException("Scope's active build is missing. Run install.ps1 again.");
            ProcessStartInfo start = new ProcessStartInfo(runtime);
            start.UseShellExecute = false;
#if SCOPE_CLI
            start.Arguments = Quote(Path.Combine(build, "Scope", "resources", "app", "cli", "main.mjs"));
            start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; };
#else
            start.CreateNoWindow = true;
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
#endif
            foreach (string arg in args) start.Arguments += " " + Quote(arg);
            using (Process child = Process.Start(start))
            {
#if SCOPE_CLI
                child.WaitForExit();
                return child.ExitCode;
#else
                return 0;
#endif
            }
        }
        catch (Exception error)
        {
#if SCOPE_CLI
            Console.Error.WriteLine(Identity + ": " + error.Message);
#else
            if (args.Length > 0 && args[0] == "--scope-shortcut") Console.Error.WriteLine(error.Message);
            else MessageBox(IntPtr.Zero, error.Message, "Scope", 0x10);
#endif
            return 1;
        }
    }

    internal static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            result.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes);
            result.Append(character);
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2);
        return result.Append('"').ToString();
    }

    private static string ResolveDirectory(string path)
    {
        // Resolve the junction before launch so a running app never reads a later build.
        using (SafeFileHandle handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new IOException("Scope's active build is unavailable. Retry or run install.ps1 again.");
            StringBuilder resolved = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(handle, resolved, (uint)resolved.Capacity, 0);
            if (length == 0 || length >= resolved.Capacity) throw new IOException("Could not find Scope's active build.");
            string result = resolved.ToString();
            if (result.StartsWith(@"\\?\UNC\")) return @"\\" + result.Substring(8);
            return result.StartsWith(@"\\?\") ? result.Substring(4) : result;
        }
    }

#if !SCOPE_CLI
    private static void CreateShortcut(string executable, string destination)
    {
        IShellLink link = (IShellLink)new ShellLink();
        link.SetPath(executable);
        link.SetDescription("Scope");
        link.SetWorkingDirectory(Path.GetDirectoryName(executable));
        link.SetIconLocation(executable, 0);
        IPropertyStore properties = (IPropertyStore)link;
        PropertyKey key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };
        PropVariant value = new PropVariant { Type = 31, Pointer = Marshal.StringToCoTaskMemUni(AppId) };
        try { properties.SetValue(ref key, ref value); properties.Commit(); }
        finally { Marshal.FreeCoTaskMem(value.Pointer); }
        ((System.Runtime.InteropServices.ComTypes.IPersistFile)link).Save(destination, true);
        Marshal.FinalReleaseComObject(link);
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] private class ShellLink { }
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLink
    {
        void GetPath(IntPtr file, int count, IntPtr findData, uint flags);
        void GetIDList(out IntPtr id);
        void SetIDList(IntPtr id);
        void GetDescription(IntPtr name, int count);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory(IntPtr directory, int count);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments(IntPtr arguments, int count);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int command);
        void SetShowCmd(int command);
        void GetIconLocation(IntPtr icon, int count, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string icon, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }
    [StructLayout(LayoutKind.Sequential)] private struct PropertyKey { public Guid Format; public uint Id; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] private struct PropVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Pointer;
    }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }
#endif

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr window, string text, string title, uint type);
}
