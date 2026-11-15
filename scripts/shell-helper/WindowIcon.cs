using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// Compatibility for the mod's current Tauri shell. Only windows belonging to
// the exact executable/process are touched; shortcuts and AppUserModelID stay
// under Windows' control. Remove this helper when the shell sets its own icon.
class WindowIcon
{
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumProc callback, IntPtr data);
    delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")]
    static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, WinEventProc callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")]
    static extern bool UnhookWinEvent(IntPtr hook);
    delegate void WinEventProc(IntPtr hook, uint kind, IntPtr hwnd, int objectId, int childId, uint thread, uint time);

    [STAThread]
    static int Main(string[] args)
    {
        if ((args.Length != 2 && args.Length != 3) || !File.Exists(args[0]) || !File.Exists(args[1])) return 2;
        string executable = Path.GetFullPath(args[0]);
        if (!String.Equals(Path.GetFileName(executable), "strata-desktop.exe", StringComparison.OrdinalIgnoreCase)) return 2;
        int processId = 0;
        if (args.Length == 3 && (!Int32.TryParse(args[2], out processId) || processId <= 0)) return 2;
        try
        {
            using (Process owner = FindOwner(executable, processId))
            {
                if (owner == null) return processId == 0 ? 3 : 2;
                // Launch and host startup can both request the repair. One owner
                // per concrete process avoids duplicate listeners and borrowed
                // HICONs being destroyed by a second, short-lived helper.
                string name;
                using (var sha = SHA256.Create())
                    name = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(executable.ToLowerInvariant()))).Replace("-", "");
                bool created;
                using (Mutex mutex = new Mutex(true, "Local\\StrataModWindowIcon-" + name + "-" + owner.Id, out created))
                {
                    if (!created) return 0;
                    using (Icon source = Icon.ExtractAssociatedIcon(args[1]))
                    using (Icon large = new Icon(source, 32, 32))
                    using (Icon small = new Icon(source, 16, 16))
                    using (Control dispatcher = new Control())
                    using (IconEvents events = new IconEvents(owner.Id, large.Handle, small.Handle))
                    {
                        // The hidden control owns only the helper's message
                        // queue. Exit is posted to that thread, even when the
                        // desktop exits before the queue begins pumping.
                        IntPtr dispatchHandle = dispatcher.Handle;
                        EventHandler stopped = delegate
                        {
                            try { dispatcher.BeginInvoke((MethodInvoker)Application.ExitThread); }
                            catch (InvalidOperationException) { }
                        };
                        owner.Exited += stopped;
                        owner.EnableRaisingEvents = true;
                        try
                        {
                            if (!owner.HasExited)
                            {
                                events.Attach();
                                Application.Run();
                            }
                        }
                        finally { owner.Exited -= stopped; }
                        // WM_SETICON borrows both handles. Their owning Icons
                        // live until this process exits; no periodic polling.
                    }
                }
            }
            return 0;
        }
        catch (InvalidOperationException) { return 3; }
        catch (System.ComponentModel.Win32Exception) { return 3; }
        catch (ArgumentException) { return 2; }
    }

    // Preferred launch path supplies a PID and never scans for a replacement.
    // The two-argument host fallback waits only for a process, not its window;
    // a slow first WebView therefore cannot outlive a 30-second window deadline.
    static Process FindOwner(string executable, int processId)
    {
        int attempts = processId == 0 ? 60 : 1;
        for (int attempt = 0; attempt < attempts; attempt++)
        {
            Process[] candidates;
            try { candidates = processId == 0 ? Process.GetProcessesByName("strata-desktop") : new Process[] { Process.GetProcessById(processId) }; }
            catch (ArgumentException) { return null; }
            Process found = null;
            foreach (Process candidate in candidates)
            {
                try
                {
                    if (found == null && !candidate.HasExited && String.Equals(candidate.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase))
                        found = candidate;
                }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
                if (candidate != found) candidate.Dispose();
            }
            if (found != null) return found;
            if (attempt + 1 < attempts) Thread.Sleep(500);
        }
        return null;
    }

    // Out-of-context WinEvents are delivered on the helper's UI thread. The
    // subscription is scoped to one PID, never to the global foreground window.
    sealed class IconEvents : IDisposable
    {
        readonly uint processId;
        readonly IntPtr large;
        readonly IntPtr small;
        readonly WinEventProc callback;
        readonly GCHandle callbackRoot;
        readonly IntPtr[] hooks = new IntPtr[3];
        bool repairing;

        public IconEvents(int processId, IntPtr large, IntPtr small)
        {
            this.processId = (uint)processId;
            this.large = large;
            this.small = small;
            callback = OnWindowEvent;
            callbackRoot = GCHandle.Alloc(callback);
        }

        public void Attach()
        {
            // SHOW covers hidden/reshown and recreated windows; foreground and
            // restore repair icons the shell may reset on the same HWND.
            hooks[0] = SetWinEventHook(0x8000, 0x8002, IntPtr.Zero, callback, processId, 0, 0);
            hooks[1] = SetWinEventHook(0x0003, 0x0003, IntPtr.Zero, callback, processId, 0, 0);
            hooks[2] = SetWinEventHook(0x0017, 0x0017, IntPtr.Zero, callback, processId, 0, 0);
            foreach (IntPtr hook in hooks)
                if (hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            EnumWindows(delegate(IntPtr hwnd, IntPtr unused) { Apply(hwnd); return true; }, IntPtr.Zero);
        }

        void OnWindowEvent(IntPtr hook, uint kind, IntPtr hwnd, int objectId, int childId, uint thread, uint time)
        {
            if (kind == 0x8001 || objectId != 0 || childId != 0) return;
            Apply(hwnd);
        }

        void Apply(IntPtr hwnd)
        {
            uint owner;
            if (repairing || hwnd == IntPtr.Zero || !IsWindowVisible(hwnd) || GetAncestor(hwnd, 2) != hwnd) return;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner != processId) return;
            repairing = true;
            try
            {
                SetIcon(hwnd, new IntPtr(1), large);
                SetIcon(hwnd, IntPtr.Zero, small);
            }
            finally { repairing = false; }
        }

        static void SetIcon(IntPtr hwnd, IntPtr size, IntPtr icon)
        {
            IntPtr current;
            if (SendMessageTimeout(hwnd, 0x7f, size, IntPtr.Zero, 2, 250, out current) == IntPtr.Zero || current == icon) return;
            SendMessageTimeout(hwnd, 0x80, size, icon, 2, 250, out current);
        }

        public void Dispose()
        {
            foreach (IntPtr hook in hooks) if (hook != IntPtr.Zero) UnhookWinEvent(hook);
            callbackRoot.Free();
        }
    }
}
