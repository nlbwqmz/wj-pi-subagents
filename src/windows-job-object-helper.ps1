param(
  [Parameter(Mandatory = $true)]
  [string]$ControlPipe,
  [Parameter(Mandatory = $true)]
  [string]$EventPipe,
  [Parameter(Mandatory = $true)]
  [string]$CommandBase64,
  [Parameter(Mandatory = $true)]
  [string]$ArgumentsBase64
)

$ErrorActionPreference = "Stop"

$nativeHelperSource = @'
using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PiSubagentWindowsJobHelper
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicProcessIdList = 3;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int ERROR_MORE_DATA = 234;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int jobObjectInfoClass,
        IntPtr lpJobObjectInfo,
        int cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr hJob,
        int jobObjectInfoClass,
        IntPtr lpJobObjectInfo,
        int cbJobObjectInfoLength,
        out int lpReturnLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    private sealed class RunnerState
    {
        public readonly object Gate = new object();
        public readonly object WriterGate = new object();
        public readonly ManualResetEvent Finished = new ManualResetEvent(false);
        public IntPtr Job;
        public IntPtr Process;
        public bool JobClosed;
        public StreamReader Reader;
        public StreamWriter Writer;

        public void Send(string line)
        {
            lock (WriterGate)
            {
                if (Writer == null) return;
                try
                {
                    Writer.WriteLine(line);
                    Writer.Flush();
                }
                catch
                {
                }
            }
        }
    }

    public static int Run(
        string controlPipeName,
        string eventPipeName,
        string commandBase64,
        string argumentsBase64)
    {
        NamedPipeClientStream controlPipe = null;
        NamedPipeClientStream eventPipe = null;
        RunnerState state = null;
        try
        {
            controlPipe = OpenPipe(controlPipeName, PipeDirection.In);
            eventPipe = OpenPipe(eventPipeName, PipeDirection.Out);
            state = new RunnerState();
            state.Reader = new StreamReader(controlPipe, new UTF8Encoding(false), false, 1024, true);
            state.Writer = new StreamWriter(eventPipe, new UTF8Encoding(false), 1024, true);

            state.Job = CreateJobObject(IntPtr.Zero, null);
            if (state.Job == IntPtr.Zero || state.Job == INVALID_HANDLE_VALUE)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            ConfigureKillOnClose(state.Job);
            state.Process = CreateAssignedProcess(state.Job, commandBase64, argumentsBase64);
            state.Send("ready");

            Thread controlThread = new Thread(delegate() { ControlLoop(state); });
            controlThread.IsBackground = true;
            controlThread.Start();

            Thread monitorThread = new Thread(delegate() { MonitorProcessTree(state); });
            monitorThread.IsBackground = true;
            monitorThread.Start();

            state.Finished.WaitOne();
            return 0;
        }
        catch
        {
            if (state != null) state.Send("error initialization_failed");
            return 1;
        }
        finally
        {
            if (state != null)
            {
                CloseJob(state);
                if (state.Process != IntPtr.Zero && state.Process != INVALID_HANDLE_VALUE)
                {
                    CloseHandle(state.Process);
                    state.Process = IntPtr.Zero;
                }
                if (state.Reader != null) state.Reader.Dispose();
                if (state.Writer != null) state.Writer.Dispose();
                state.Finished.Dispose();
            }
            if (controlPipe != null) controlPipe.Dispose();
            if (eventPipe != null) eventPipe.Dispose();
        }
    }

    private static NamedPipeClientStream OpenPipe(string pipeName, PipeDirection direction)
    {
        const string pipePrefix = @"\\.\pipe\";
        string localPipeName = pipeName.StartsWith(pipePrefix, StringComparison.OrdinalIgnoreCase)
            ? pipeName.Substring(pipePrefix.Length)
            : pipeName;
        NamedPipeClientStream pipe = new NamedPipeClientStream(".", localPipeName, direction, PipeOptions.None);
        pipe.Connect(10000);
        return pipe;
    }

    private static void ConfigureKillOnClose(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static IntPtr CreateAssignedProcess(IntPtr job, string commandBase64, string argumentsBase64)
    {
        string command = DecodeBase64(commandBase64);
        string[] arguments = DecodeArguments(argumentsBase64);
        STARTUPINFO startupInfo = new STARTUPINFO();
        startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startupInfo.dwFlags = STARTF_USESTDHANDLES;
        startupInfo.hStdInput = GetStdHandle(-10);
        startupInfo.hStdOutput = GetStdHandle(-11);
        startupInfo.hStdError = GetStdHandle(-12);
        EnsureInheritable(startupInfo.hStdInput);
        EnsureInheritable(startupInfo.hStdOutput);
        EnsureInheritable(startupInfo.hStdError);

        StringBuilder commandLine = new StringBuilder();
        commandLine.Append(QuoteArgument(command));
        for (int index = 0; index < arguments.Length; index += 1)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteArgument(arguments[index]));
        }

        PROCESS_INFORMATION processInfo;
        bool created = CreateProcess(
            command,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            true,
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            IntPtr.Zero,
            null,
            ref startupInfo,
            out processInfo);
        if (!created) throw new Win32Exception(Marshal.GetLastWin32Error());

        try
        {
            if (!AssignProcessToJobObject(job, processInfo.hProcess))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (ResumeThread(processInfo.hThread) == UInt32.MaxValue)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return processInfo.hProcess;
        }
        catch
        {
            // 绑定或恢复失败时，进程可能尚未由 Job 覆盖；不能只关闭本地句柄。
            TerminateProcess(processInfo.hProcess, 1);
            CloseHandle(processInfo.hProcess);
            throw;
        }
        finally
        {
            if (processInfo.hThread != IntPtr.Zero && processInfo.hThread != INVALID_HANDLE_VALUE)
            {
                CloseHandle(processInfo.hThread);
            }
        }
    }

    private static void EnsureInheritable(IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == INVALID_HANDLE_VALUE)
        {
            throw new InvalidOperationException();
        }
        if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    private static string DecodeBase64(string value)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(value));
    }

    private static string[] DecodeArguments(string values)
    {
        if (String.IsNullOrEmpty(values)) return new string[0];
        string[] encoded = values.Split(',');
        string[] decoded = new string[encoded.Length];
        for (int index = 0; index < encoded.Length; index += 1)
        {
            decoded[index] = DecodeBase64(encoded[index]);
        }
        return decoded;
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length == 0) return "\"\"";
        bool needsQuotes = false;
        for (int index = 0; index < value.Length; index += 1)
        {
            if (Char.IsWhiteSpace(value[index]) || value[index] == '\"')
            {
                needsQuotes = true;
                break;
            }
        }
        if (!needsQuotes) return value;

        StringBuilder quoted = new StringBuilder();
        quoted.Append('\"');
        int backslashes = 0;
        for (int index = 0; index < value.Length; index += 1)
        {
            char character = value[index];
            if (character == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (character == '\"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append(character);
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            quoted.Append(character);
            backslashes = 0;
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('\"');
        return quoted.ToString();
    }

    private static void ControlLoop(RunnerState state)
    {
        try
        {
            while (!state.Finished.WaitOne(0))
            {
                string line = state.Reader.ReadLine();
                // 控制管道 EOF 只会发生在父端已退出或显式释放之后。关闭 Job
                // 让 KILL_ON_JOB_CLOSE 回收残留成员，避免 helper 自身滞留。
                if (line == null) return;
                string[] parts = line.Split(' ');
                if (parts.Length != 3 || parts[0] != "command") continue;
                int commandId;
                if (!Int32.TryParse(parts[1], out commandId) || commandId < 1) continue;
                if (parts[2] == "inspect")
                {
                    string resources = ObserveResources(state);
                    state.Send("event resources " + resources);
                    state.Send("response " + commandId + " " + resources);
                }
                else if (parts[2] == "force")
                {
                    state.Send("response " + commandId + " " + ForceTerminate(state));
                }
                else if (parts[2] == "release")
                {
                    ReleaseTree(state, commandId);
                    return;
                }
            }
        }
        catch
        {
            state.Send("error control_unavailable");
        }
        finally
        {
            CloseJob(state);
            state.Finished.Set();
        }
    }

    private static string ForceTerminate(RunnerState state)
    {
        lock (state.Gate)
        {
            if (state.JobClosed) return "unknown";
            string before = ObserveResourcesUnsafe(state);
            if (before == "released") return "released";
            if (!TerminateJobObject(state.Job, 1)) return "unknown";
            return "accepted";
        }
    }

    private static void ReleaseTree(RunnerState state, int commandId)
    {
        string resources = ObserveResources(state);
        if (resources == "released")
        {
            state.Send("response " + commandId + " released");
            CloseJob(state);
            state.Finished.Set();
            return;
        }

        CloseJob(state);
        state.Send("event resources unknown");
        state.Send("response " + commandId + " unknown");
        state.Finished.Set();
    }

    private static void MonitorProcessTree(RunnerState state)
    {
        while (!state.Finished.WaitOne(25))
        {
            uint waitResult = WaitForSingleObject(state.Process, 0);
            if (waitResult == WAIT_OBJECT_0) break;
            if (waitResult == WAIT_TIMEOUT) continue;
            state.Send("event resources unknown");
            return;
        }
        if (state.Finished.WaitOne(0)) return;
        if (WaitForSingleObject(state.Process, 0) != WAIT_OBJECT_0)
        {
            state.Send("event resources unknown");
            return;
        }
        state.Send("event exit exited");

        string lastResources = null;
        while (!state.Finished.WaitOne(0))
        {
            string resources = ObserveResources(state);
            if (resources != lastResources)
            {
                state.Send("event resources " + resources);
                lastResources = resources;
            }
            if (resources == "released")
            {
                // 最终资源事实必须在父端显式 release 前保持可查询。若此处立刻
                // 退出，命名管道 EOF 可能先于最后一条 resources released 被父端处理。
                return;
            }
            if (resources == "unknown") return;
            Thread.Sleep(25);
        }
    }

    private static string ObserveResources(RunnerState state)
    {
        lock (state.Gate)
        {
            return ObserveResourcesUnsafe(state);
        }
    }

    private static string ObserveResourcesUnsafe(RunnerState state)
    {
        if (state.JobClosed || state.Job == IntPtr.Zero || state.Job == INVALID_HANDLE_VALUE) return "unknown";
        const int headerSize = 8;
        int capacity = 16;
        while (capacity <= 65536)
        {
            IntPtr buffer = Marshal.AllocHGlobal(headerSize + IntPtr.Size * capacity);
            try
            {
                int returned;
                bool queried = QueryInformationJobObject(
                    state.Job,
                    JobObjectBasicProcessIdList,
                    buffer,
                    headerSize + IntPtr.Size * capacity,
                    out returned);
                if (queried)
                {
                    int active = Marshal.ReadInt32(buffer);
                    return active == 0 ? "released" : "present";
                }
                if (Marshal.GetLastWin32Error() != ERROR_MORE_DATA) return "unknown";
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
            capacity *= 2;
        }
        return "unknown";
    }

    private static void CloseJob(RunnerState state)
    {
        lock (state.Gate)
        {
            if (state.JobClosed) return;
            state.JobClosed = true;
            if (state.Job != IntPtr.Zero && state.Job != INVALID_HANDLE_VALUE)
            {
                CloseHandle(state.Job);
                state.Job = IntPtr.Zero;
            }
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $nativeHelperSource -Language CSharp -ErrorAction Stop
  $exitCode = [PiSubagentWindowsJobHelper]::Run(
    $ControlPipe,
    $EventPipe,
    $CommandBase64,
    $ArgumentsBase64
  )
  exit $exitCode
} catch {
  # 脚本不向目标协议流输出编译细节、路径或异常堆栈。
  exit 1
}
