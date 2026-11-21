using Microsoft.Win32.SafeHandles;
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;

namespace AiRule.Sol.Windows
{
    internal sealed class BrokerException : Exception
    {
        internal string Code { get; private set; }
        internal BrokerException(string code) : base(code) { Code = code; }
    }

    internal static class WindowsPipe
    {
        internal const string ServiceName = "AiRuleSolBroker";
        internal const string RequestPipe = @"\\.\pipe\AiRuleSolBroker.Response.v1";
        internal const string StatusPipe = @"\\.\pipe\AiRuleSolBroker.Status.v1";
        internal const string AdminPipe = @"\\.\pipe\AiRuleSolBroker.Admin.v1";
        internal static readonly SecurityIdentifier ServiceSid = new SecurityIdentifier("S-1-5-80-2491726543-4042735884-3184637371-1420765198-420171591");
        internal static readonly SecurityIdentifier Administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);

        // FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE.
        // In particular, FILE_APPEND_DATA also grants FILE_CREATE_PIPE_INSTANCE.
        private const uint ClientRights = 0x00120083;
        private const uint Overlapped = 0x40000000;
        private const uint FirstInstance = 0x00080000;
        private const uint RejectRemote = 0x00000008;
        private const uint SecurityIdentification = 0x00010000;
        private const uint SecuritySqosPresent = 0x00100000;

        internal static NamedPipeServerStream CreateServer(string path, SecurityIdentifier owner, SecurityIdentifier client, uint instances = 1, bool first = true)
        {
            var security = new PipeSecurity();
            security.SetOwner(owner);
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.FullControl, AccessControlType.Allow));
            if (!owner.Equals(client))
                security.AddAccessRule(new PipeAccessRule(client, (PipeAccessRights)ClientRights, AccessControlType.Allow));
            byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
            var pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
            try
            {
                var attributes = new SecurityAttributes {
                    Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pinned.AddrOfPinnedObject()
                };
                var handle = CreateNamedPipeW(path, 3 | Overlapped | (first ? FirstInstance : 0), RejectRemote, instances, 16384, 16384, 250, ref attributes);
                if (handle.IsInvalid)
                {
                    handle.Dispose();
                    throw new BrokerException("BROKER_UNAVAILABLE");
                }
                try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); }
                catch { handle.Dispose(); throw; }
            }
            finally { pinned.Free(); }
        }

        internal static NamedPipeClientStream Connect(string path)
        {
            var timer = Stopwatch.StartNew();
            while (true)
            {
                var handle = CreateFileW(path, ClientRights, 0, IntPtr.Zero, 3, Overlapped | SecurityIdentification | SecuritySqosPresent, IntPtr.Zero);
                if (!handle.IsInvalid)
                {
                    try { return new NamedPipeClientStream(PipeDirection.InOut, true, true, handle); }
                    catch { handle.Dispose(); throw; }
                }
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                if (error == 5) throw new BrokerException("BROKER_FORBIDDEN");
                if (error != 231) throw new BrokerException("BROKER_UNAVAILABLE");
                int remaining = Protocol.ConnectTimeoutMs - (int)timer.ElapsedMilliseconds;
                if (remaining <= 0 || !WaitNamedPipeW(path, (uint)remaining)) throw new BrokerException("BROKER_BUSY");
            }
        }

        internal static async Task<NamedPipeClientStream> ConnectAuthenticated(bool admin, bool status = false)
        {
            using (var identity = WindowsIdentity.GetCurrent())
            {
                if (identity.User == null || identity.User.Equals(ServiceSid) || identity.IsSystem || HasAdmin(identity) != admin)
                    throw new BrokerException("BROKER_FORBIDDEN");
            }
            string path = admin ? AdminPipe : (status ? StatusPipe : RequestPipe);
            NamedPipeClientStream pipe = Connect(path);
            try
            {
                if (!IsBrokerServer(pipe.SafePipeHandle)) throw new BrokerException("BROKER_FORBIDDEN");
                using (var timeout = new CancellationTokenSource(Protocol.IoTimeoutMs))
                {
                    await Write(pipe, new[] { Protocol.Hello }, timeout.Token).ConfigureAwait(false);
                    byte[] grant = await Read(pipe, 1, timeout.Token).ConfigureAwait(false);
                    if (grant[0] != Protocol.Hello) throw new BrokerException("BROKER_FORBIDDEN");
                }
                return pipe;
            }
            catch { pipe.Dispose(); throw; }
        }

        private static bool HasAdmin(WindowsIdentity identity)
        {
            return identity.Groups != null && identity.Groups.Any(group => group.Equals(Administrators));
        }

        internal static bool IsBrokerServer(SafePipeHandle pipe)
        {
            uint processId;
            uint session;
            if (!GetNamedPipeServerProcessId(pipe, out processId) || processId == 0 ||
                !GetNamedPipeServerSessionId(pipe, out session) || session != 0 || !OwnedBy(pipe, ServiceSid)) return false;
            using (var scm = OpenSCManagerW(null, null, 1))
            {
                if (scm.IsInvalid) return false;
                using (var service = OpenServiceW(scm, ServiceName, 4))
                {
                    if (service.IsInvalid) return false;
                    ServiceStatus status;
                    uint needed;
                    return QueryServiceStatusEx(service, 0, out status, (uint)Marshal.SizeOf(typeof(ServiceStatus)), out needed) &&
                        status.Type == 0x10 && status.State == 4 && status.ProcessId == processId;
                }
            }
        }

        internal static bool OwnedBy(SafePipeHandle pipe, SecurityIdentifier expected)
        {
            IntPtr owner;
            IntPtr descriptor;
            if (GetSecurityInfo(pipe, 1, 1, out owner, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor) != 0) return false;
            try { return owner != IntPtr.Zero && expected.Equals(new SecurityIdentifier(owner)); }
            finally { LocalFree(descriptor); }
        }

        internal static bool AuthorizedClient(SafePipeHandle pipe, SecurityIdentifier caller, bool admin)
        {
            // The first byte has been read, which binds the token to the actual pipe client.
            // Open it for query only and restore our token before any other work.
            SafeAccessTokenHandle token = null;
            if (!ImpersonateNamedPipeClient(pipe)) return false;
            try
            {
                if (!OpenThreadToken(GetCurrentThread(), 8, true, out token)) return false;
            }
            finally
            {
                if (!RevertToSelf()) Environment.FailFast("Sol broker could not restore its service identity.");
            }
            using (token)
            {
                int level;
                int needed;
                if (!GetTokenInformation(token.DangerousGetHandle(), 9, out level, sizeof(int), out needed) || level != 1) return false;
                using (var identity = new WindowsIdentity(token.DangerousGetHandle()))
                {
                    return identity.User != null && !identity.User.Equals(ServiceSid) && !identity.IsSystem &&
                        (admin ? HasAdmin(identity) : caller.Equals(identity.User) && !HasAdmin(identity));
                }
            }
        }

        internal static bool IsRestrictedServiceIdentity(WindowsIdentity identity)
        {
            if (identity.User == null || !identity.User.Equals(ServiceSid) || identity.IsSystem || HasAdmin(identity)) return false;
            // SCM's required-privileges list leaves only the normal directory traversal privilege.
            long allowed;
            if (!LookupPrivilegeValueW(null, "SeChangeNotifyPrivilege", out allowed)) return false;
            int length;
            GetTokenInformation(identity.Token, 3, IntPtr.Zero, 0, out length);
            if (length < sizeof(int) || length > 4096) return false;
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                if (!GetTokenInformation(identity.Token, 3, buffer, length, out length)) return false;
                int count = Marshal.ReadInt32(buffer);
                if (count < 0 || count > 1 || length < sizeof(int) + 12 * count) return false;
                return count == 0 || Marshal.ReadInt64(buffer, sizeof(int)) == allowed;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        internal static async Task Wait(NamedPipeServerStream pipe, CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested();
            SafePipeHandle handle = pipe.SafePipeHandle;
            Task pending = pipe.WaitForConnectionAsync();
            using (cancellation.Register(() => Cancel(handle))) await pending.ConfigureAwait(false);
        }

        internal static async Task<byte[]> Read(PipeStream pipe, int length, CancellationToken cancellation)
        {
            var bytes = new byte[length];
            try
            {
                int offset = 0;
                SafePipeHandle handle = pipe.SafePipeHandle;
                while (offset < length)
                {
                    cancellation.ThrowIfCancellationRequested();
                    Task<int> pending = pipe.ReadAsync(bytes, offset, length - offset, CancellationToken.None);
                    int count;
                    using (cancellation.Register(() => Cancel(handle))) count = await pending.ConfigureAwait(false);
                    if (count == 0) throw new EndOfStreamException();
                    offset += count;
                }
                return bytes;
            }
            catch { Array.Clear(bytes, 0, bytes.Length); throw; }
        }

        internal static async Task Write(PipeStream pipe, byte[] bytes, CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested();
            SafePipeHandle handle = pipe.SafePipeHandle;
            Task pending = pipe.WriteAsync(bytes, 0, bytes.Length, CancellationToken.None);
            using (cancellation.Register(() => Cancel(handle))) await pending.ConfigureAwait(false);
        }

        private static void Cancel(SafePipeHandle handle)
        {
            try { CancelIoEx(handle, IntPtr.Zero); }
            catch (ObjectDisposedException) { }
        }

        internal static async Task<byte[]> ReadFrame(PipeStream pipe, int maximum, CancellationToken cancellation)
        {
            int length = BitConverter.ToInt32(await Read(pipe, 4, cancellation).ConfigureAwait(false), 0);
            if (length > maximum) throw new BodyTooLargeException();
            if (length < 1) throw new InvalidDataException();
            return await Read(pipe, length, cancellation).ConfigureAwait(false);
        }

        internal static async Task WriteFrame(PipeStream pipe, byte[] bytes, CancellationToken cancellation)
        {
            await Write(pipe, BitConverter.GetBytes(bytes.Length), cancellation).ConfigureAwait(false);
            await Write(pipe, bytes, cancellation).ConfigureAwait(false);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes { internal int Length; internal IntPtr Descriptor; internal int Inherit; }

        [StructLayout(LayoutKind.Sequential)]
        private struct ServiceStatus
        {
            internal uint Type, State, Accepted, Win32ExitCode, ServiceExitCode, CheckPoint, WaitHint, ProcessId, Flags;
        }

        private sealed class ScHandle : SafeHandleZeroOrMinusOneIsInvalid
        {
            private ScHandle() : base(true) { }
            protected override bool ReleaseHandle() { return CloseServiceHandle(handle); }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafePipeHandle CreateNamedPipeW(string path, uint open, uint mode, uint instances, uint output, uint input, uint timeout, ref SecurityAttributes attributes);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafePipeHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool WaitNamedPipeW(string path, uint timeout);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CancelIoEx(SafePipeHandle handle, IntPtr operation);
        [DllImport("kernel32.dll")]
        private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint id);
        [DllImport("kernel32.dll")]
        private static extern bool GetNamedPipeServerSessionId(SafePipeHandle pipe, out uint id);
        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentThread();
        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("advapi32.dll")]
        private static extern uint GetSecurityInfo(SafePipeHandle handle, uint type, uint info, out IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll")]
        private static extern bool ImpersonateNamedPipeClient(SafePipeHandle pipe);
        [DllImport("advapi32.dll")]
        private static extern bool OpenThreadToken(IntPtr thread, uint access, bool asSelf, out SafeAccessTokenHandle token);
        [DllImport("advapi32.dll")]
        private static extern bool RevertToSelf();
        [DllImport("advapi32.dll")]
        private static extern bool GetTokenInformation(IntPtr token, int type, out int info, int size, out int needed);
        [DllImport("advapi32.dll")]
        private static extern bool GetTokenInformation(IntPtr token, int type, IntPtr info, int size, out int needed);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        private static extern bool LookupPrivilegeValueW(string system, string privilege, out long luid);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        private static extern ScHandle OpenSCManagerW(string system, string database, uint access);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        private static extern ScHandle OpenServiceW(ScHandle scm, string name, uint access);
        [DllImport("advapi32.dll")]
        private static extern bool QueryServiceStatusEx(ScHandle service, uint level, out ServiceStatus status, uint size, out uint needed);
        [DllImport("advapi32.dll")]
        private static extern bool CloseServiceHandle(IntPtr handle);
    }
}
