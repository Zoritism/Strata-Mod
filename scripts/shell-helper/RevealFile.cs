using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using System.Diagnostics;
using System.Threading;

// Keep COM and Explorer startup failures outside the inference host. No command
// string or explorer.exe switches are involved.
internal static class RevealFile
{
    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr reserved, uint flags);
    [DllImport("ole32.dll")]
    private static extern void CoUninitialize();
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHParseDisplayName(string name, IntPtr bind, out IntPtr pidl, uint flags, out uint attributes);
    [DllImport("shell32.dll")]
    private static extern int SHOpenFolderAndSelectItems(IntPtr pidl, uint count, IntPtr children, uint flags);
    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    // Shell success is followed by locating the actual folder window and
    // selecting the item there. Hidden/minimized Explorer windows are restored.
    private static bool SelectInExplorer(string file)
    {
        object shell = null;
        try
        {
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application", true));
            string directory = Path.GetDirectoryName(file);
            for (int attempt = 0; attempt < 30; attempt++)
            {
                dynamic windows = ((dynamic)shell).Windows();
                try
                {
                    foreach (dynamic window in windows)
                    {
                        try
                        {
                            string folder = (string)window.Document.Folder.Self.Path;
                            if (!String.Equals(folder.TrimEnd('\\'), directory.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) continue;
                            dynamic item = window.Document.Folder.ParseName(Path.GetFileName(file));
                            if (item == null) continue;
                            window.Document.SelectItem(item, 1 | 4 | 8 | 16);
                            IntPtr handle = new IntPtr((long)window.HWND);
                            ShowWindowAsync(handle, 9); // SW_RESTORE, never inherit a hidden launch state.
                            SetForegroundWindow(handle);
                            if (IsWindowVisible(handle)) return true;
                        }
                        catch (Exception) { /* A tab may close or expose a non-filesystem document. */ }
                    }
                }
                finally { if (Marshal.IsComObject(windows)) Marshal.ReleaseComObject(windows); }
                Thread.Sleep(100);
            }
            return false;
        }
        finally { if (shell != null && Marshal.IsComObject(shell)) Marshal.ReleaseComObject(shell); }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        IntPtr pidl = IntPtr.Zero;
        bool initialized = false;
        try
        {
            // Console.OutputEncoding calls SetConsoleOutputCP, which fails for
            // a GUI-subsystem process without a console. Write UTF-8 to the
            // inherited pipes directly instead; no console/window is allocated.
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
            Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
            bool checkOnly = args.Length == 2 && args[0] == "--check";
            string action = args.Length == 1 ? "reveal" : args.Length == 2 ? args[0] : "";
            if (action != "reveal" && action != "--reveal" && action != "--check" && action != "--open" && action != "--open-folder") throw new ArgumentException("Unknown file action.");
            string file = args[args.Length == 1 ? 0 : 1];
            if (!Path.IsPathRooted(file) || !(action == "--open-folder" ? Directory.Exists(file) : File.Exists(file))) throw new FileNotFoundException("The selected file or folder no longer exists.");
            file = Path.GetFullPath(file);
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("File links are not supported.");
            Marshal.ThrowExceptionForHR(CoInitializeEx(IntPtr.Zero, 2));
            initialized = true;
            uint attributes;
            Marshal.ThrowExceptionForHR(SHParseDisplayName(file, IntPtr.Zero, out pidl, 0, out attributes));
            if (action == "--open" || action == "--open-folder")
            {
                Process.Start(new ProcessStartInfo(file) { UseShellExecute = true });
                Console.WriteLine("{\"ok\":true}");
                return 0;
            }
            // cidl=0 opens the parent of this absolute PIDL and selects the item.
            // --check verifies Unicode parsing without opening any desktop window.
            if (!checkOnly)
            {
                int result = SHOpenFolderAndSelectItems(pidl, 0, IntPtr.Zero, 0);
                if (!SelectInExplorer(file))
                {
                    Marshal.ThrowExceptionForHR(result);
                    throw new InvalidOperationException("Explorer did not confirm a folder window. Try again or open the folder manually.");
                }
            }
            Console.WriteLine("{\"ok\":true}");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Windows Shell: " + error.Message + " (0x" + error.HResult.ToString("X8") + ")");
            return 1;
        }
        finally
        {
            if (pidl != IntPtr.Zero) Marshal.FreeCoTaskMem(pidl);
            if (initialized) CoUninitialize();
        }
    }
}
