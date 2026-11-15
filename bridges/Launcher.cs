// Strata Extensions bootstrap bridge. Author: Zoritism.
// Only this tiny launcher is compiled; all policy and settings live in external modules.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using System.Security.Cryptography;
using System.Text;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;

[DataContract]
class InstallationReceipt {
  [DataMember] public string appDir;
}

class Launcher {
  // Use the install receipt, not the presence of another release's executable.
  // Old managed installations predate this field and keep the app/ layout.
  static string ApplicationDirectory(string root) {
    string appDir = "app";
    string receipt = Path.Combine(root, "installation.json");
    if (File.Exists(receipt)) {
      using (var stream = File.OpenRead(receipt)) {
        var value = (InstallationReceipt)new DataContractJsonSerializer(typeof(InstallationReceipt)).ReadObject(stream);
        if (value != null && value.appDir != null) appDir = value.appDir;
      }
    }
    if (appDir != "." && appDir != "app") throw new Exception("Неверный каталог приложения в installation.json.");
    return Path.GetFullPath(Path.Combine(root, appDir));
  }
  [STAThread] static void Main() {
    string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    string name;
    using (var sha = SHA256.Create()) name = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()))).Replace("-", "");
    bool created;
    using (var mutex = new Mutex(true, "Local\\StrataExtensions-" + name, out created)) {
      if (!created) { MessageBox.Show("Strata Extensions уже запущена.", "Strata Extensions"); return; }
      if (Process.GetProcessesByName("strata-desktop").Length != 0) { MessageBox.Show("Сначала закройте открытое окно Strata. Исходная и модифицированная оболочки используют один экземпляр приложения.", "Strata Extensions"); return; }
      Application.EnableVisualStyles();
      var form = new Form { Text = "Strata Extensions", Width = 490, Height = 145, StartPosition = FormStartPosition.CenterScreen, ControlBox = false, FormBorderStyle = FormBorderStyle.FixedDialog };
      // The EXE resource controls the shortcut, but WinForms also needs its own
      // window icon while preparation is visible in the taskbar.
      Icon windowIcon;
      using (var icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath)) windowIcon = icon == null ? null : (Icon)icon.Clone();
      form.Icon = windowIcon;
      var label = new Label { Dock = DockStyle.Fill, Padding = new Padding(20), Text = "Проверка настроек и подготовка Strata…", AutoSize = false };
      form.Controls.Add(label);
      var error = new StringBuilder();
      Process child = null;
      form.Shown += delegate {
        try {
          child = new Process { StartInfo = new ProcessStartInfo {
            FileName = Path.Combine(ApplicationDirectory(root), "node", "node.exe"),
            Arguments = "\"" + Path.Combine(root, "extensions", "core", "launch.mjs") + "\" \"" + root + "\"",
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
          }, EnableRaisingEvents = true };
          child.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data == null) return; form.BeginInvoke((Action)delegate { if (e.Data == "READY") form.Hide(); else label.Text = e.Data; }); };
          child.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) lock (error) { if (error.Length < 6000) error.AppendLine(e.Data); } };
          child.Exited += delegate { child.WaitForExit(); form.BeginInvoke((Action)delegate { if (child.ExitCode != 0) MessageBox.Show(error.ToString(), "Strata Extensions — запуск остановлен", MessageBoxButtons.OK, MessageBoxIcon.Error); form.Close(); }); };
          child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine();
        } catch (Exception e) { MessageBox.Show(e.Message, "Strata Extensions"); form.Close(); }
      };
      Application.Run(form);
      form.Dispose();
      if (windowIcon != null) windowIcon.Dispose();
      if (child != null) child.Dispose();
    }
  }
}
