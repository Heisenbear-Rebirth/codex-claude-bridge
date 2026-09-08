using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

// The SDK launches this real Windows executable. A kill-on-close job ensures
// cancellation cannot leave the proxy or its original Claude child orphaned.
internal static class ClaudeWrapperLauncher {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1).Append(character);
            else result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static void Pump(Stream source, Stream destination) {
        byte[] buffer = new byte[16384]; int count;
        while ((count = source.Read(buffer, 0, buffer.Length)) > 0) { destination.Write(buffer, 0, count); destination.Flush(); }
    }
    static int Main(string[] args) {
        IntPtr job = IntPtr.Zero; Process child = null;
        try {
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            string[] paths = File.ReadAllLines(Path.Combine(directory, "claude-wrapper.paths"));
            if (paths.Length != 2 || !File.Exists(paths[0]) || !File.Exists(paths[1])) throw new Exception("Invalid local launcher paths.");
            job = CreateJobObject(IntPtr.Zero, null);
            var limits = new ExtendedLimits(); limits.BasicLimitInformation.LimitFlags = 0x2000;
            int size = Marshal.SizeOf(limits); IntPtr memory = Marshal.AllocHGlobal(size);
            try { Marshal.StructureToPtr(limits, memory, false); if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, memory, (uint)size)) throw new Exception("Could not configure child lifetime."); }
            finally { Marshal.FreeHGlobal(memory); }
            var arguments = new StringBuilder(Quote(paths[1])); foreach (string argument in args) arguments.Append(' ').Append(Quote(argument));
            var start = new ProcessStartInfo(paths[0], arguments.ToString()) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = Environment.CurrentDirectory };
            child = Process.Start(start);
            if (!AssignProcessToJobObject(job, child.Handle)) { child.Kill(); throw new Exception("Could not attach child lifetime."); }
            var input = Task.Run(() => { try { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); child.StandardInput.Close(); } catch (IOException) {} });
            var output = Task.Run(() => { try { Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()); } catch (IOException) {} });
            var error = Task.Run(() => { try { Pump(child.StandardError.BaseStream, Console.OpenStandardError()); } catch (IOException) {} });
            child.WaitForExit(); Task.WaitAll(output, error); return child.ExitCode;
        } catch (Exception) { Console.Error.WriteLine("[Cooperation] Wrapper launcher failed. Check project launcher paths and Windows process permissions."); return 1; }
        finally { if (job != IntPtr.Zero) CloseHandle(job); if (child != null) child.Dispose(); }
    }
}
