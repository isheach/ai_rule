using System;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Security.Principal;
using System.ServiceProcess;
using System.Threading;
using System.Threading.Tasks;

namespace AiRule.Sol.Windows
{
    internal static class Program
    {
        internal static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), WindowsPipe.ServiceName);
        internal static readonly string StateDirectory = Path.Combine(Root, "state");

        internal static bool IsInstalledExe()
        {
            return string.Equals(Path.GetFullPath(Assembly.GetExecutingAssembly().Location), Path.Combine(Root, "SolBroker.exe"), StringComparison.OrdinalIgnoreCase);
        }

        internal static int Main(string[] args)
        {
            if (args.Length != 1) return 2;
            switch (args[0])
            {
                case "client": return Client().GetAwaiter().GetResult();
                case "check": return Admin(false).GetAwaiter().GetResult();
                case "set-key": return Admin(true).GetAwaiter().GetResult();
                case "service":
                    if (!IsInstalledExe() || Environment.UserInteractive) return 2;
                    using (var service = new BrokerService()) ServiceBase.Run(service);
                    return 0;
                default: return 2;
            }
        }

        private static async Task<int> Client()
        {
            byte[] reply;
            bool sentResponse = false;
            try
            {
                if (!Console.IsInputRedirected) throw new BrokerException("BROKER_PROTOCOL");
                byte[] input;
                bool status;
                try
                {
                    using (var stdin = Console.OpenStandardInput())
                    {
                        Task<byte[]> read = Protocol.ReadBounded(stdin, Protocol.MaxRequestBytes, CancellationToken.None);
                        if (await Task.WhenAny(read, Task.Delay(Protocol.IoTimeoutMs)).ConfigureAwait(false) != read)
                            throw new BrokerException("BROKER_PROTOCOL");
                        input = await read.ConfigureAwait(false);
                    }
                    var envelope = Protocol.Parse(input);
                    status = "status".Equals(Protocol.Get(envelope, "op"));
                    if (!status && !"response".Equals(Protocol.Get(envelope, "op"))) throw new InvalidDataException();
                    Protocol.Fields(envelope, status ? new[] { "op" } : new[] { "op", "body" });
                }
                catch (Exception) { throw new BrokerException("BROKER_PROTOCOL"); }

                using (var pipe = await WindowsPipe.ConnectAuthenticated(false, status).ConfigureAwait(false))
                {
                    // The privileged boundary authenticates the service before any request bytes leave this process.
                    sentResponse = !status;
                    using (var send = new CancellationTokenSource(Protocol.IoTimeoutMs))
                        await WindowsPipe.WriteFrame(pipe, input, send.Token).ConfigureAwait(false);
                    int replyDeadline = Protocol.IoTimeoutMs + (status ? 0 : Protocol.ApiTimeoutMs);
                    using (var receive = new CancellationTokenSource(replyDeadline))
                        reply = await WindowsPipe.ReadFrame(pipe, Protocol.MaxReplyBytes, receive.Token).ConfigureAwait(false);
                    Protocol.ValidateReply(Protocol.Parse(reply));
                    await Acknowledge(pipe).ConfigureAwait(false);
                }
            }
            catch (BrokerException ex) { reply = Protocol.Error(ex.Code); }
            catch (Exception) { reply = Protocol.Error(sentResponse ? "BROKER_OUTCOME_UNKNOWN" : "BROKER_UNAVAILABLE"); }

            try
            {
                using (var output = Console.OpenStandardOutput()) output.Write(reply, 0, reply.Length);
                return 0;
            }
            catch (IOException) { return 2; }
        }

        private static async Task<int> Admin(bool enroll)
        {
            byte[] key = null;
            try
            {
                if (!IsInstalledExe() || (enroll && (!Environment.UserInteractive || Console.IsInputRedirected || Console.IsOutputRedirected)))
                    throw new BrokerException("BROKER_FORBIDDEN");
                if (!await AdminExchange(Protocol.Check, null).ConfigureAwait(false)) throw new BrokerException("BROKER_UNAVAILABLE");
                if (enroll)
                {
                    key = PromptKey();
                    if (!Protocol.ValidKey(key) || !await AdminExchange(Protocol.SetKey, key).ConfigureAwait(false))
                        throw new BrokerException("BROKER_UNAVAILABLE");
                }
                Console.WriteLine(enroll ? "Sol broker credential saved." : "Sol broker service identity and DPAPI are ready.");
                return 0;
            }
            catch (Exception)
            {
                Console.Error.WriteLine(enroll ? "Sol broker credential could not be saved." : "Sol broker service or DPAPI is unavailable.");
                return 1;
            }
            finally { if (key != null) Array.Clear(key, 0, key.Length); }
        }

        internal static async Task<bool> AdminExchange(byte operation, byte[] key)
        {
            using (var pipe = await WindowsPipe.ConnectAuthenticated(true).ConfigureAwait(false))
            using (var timer = new CancellationTokenSource(Protocol.IoTimeoutMs))
            {
                await WindowsPipe.Write(pipe, BitConverter.GetBytes(1 + (key == null ? 0 : key.Length)), timer.Token).ConfigureAwait(false);
                await WindowsPipe.Write(pipe, new[] { operation }, timer.Token).ConfigureAwait(false);
                if (key != null) await WindowsPipe.Write(pipe, key, timer.Token).ConfigureAwait(false);
                var reply = Protocol.Parse(await WindowsPipe.ReadFrame(pipe, 512, timer.Token).ConfigureAwait(false));
                Protocol.ValidateReply(reply);
                await Acknowledge(pipe).ConfigureAwait(false);
                return (bool)reply["ok"];
            }
        }

        private static async Task Acknowledge(PipeStream pipe)
        {
            // A fully received and validated reply remains authoritative if the peer closes immediately afterwards.
            using (var timer = new CancellationTokenSource(Protocol.IoTimeoutMs))
            {
                try { await WindowsPipe.Write(pipe, new[] { Protocol.Finish }, timer.Token).ConfigureAwait(false); }
                catch (IOException) { }
            }
        }

        private static byte[] PromptKey()
        {
            Console.Write("OpenAI API key (input hidden): ");
            var buffer = new byte[Protocol.MaxKeyBytes];
            int length = 0;
            try
            {
                while (true)
                {
                    ConsoleKeyInfo ch = Console.ReadKey(true);
                    if (ch.Key == ConsoleKey.Enter) return buffer.Take(length).ToArray();
                    if (ch.Key == ConsoleKey.Escape) throw new InvalidOperationException();
                    if (ch.Key == ConsoleKey.Backspace) { if (length > 0) buffer[--length] = 0; continue; }
                    if (ch.KeyChar < 33 || ch.KeyChar > 126 || length == buffer.Length) throw new InvalidDataException();
                    buffer[length++] = (byte)ch.KeyChar;
                }
            }
            finally { Array.Clear(buffer, 0, buffer.Length); Console.WriteLine(); }
        }
    }

    internal sealed class BrokerService : ServiceBase
    {
        private const uint ResponseWorkers = 3;
        private readonly CancellationTokenSource stop = new CancellationTokenSource();
        private readonly NamedPipeServerStream[] pipes = new NamedPipeServerStream[ResponseWorkers + 2];
        private Task[] listeners;
        private Policy policy;
        private BrokerState state;
        private Upstream upstream;

        internal BrokerService()
        {
            ServiceName = WindowsPipe.ServiceName;
            AutoLog = false;
            CanStop = true;
        }

        protected override void OnStart(string[] args)
        {
            try
            {
                using (var identity = WindowsIdentity.GetCurrent())
                    if (!WindowsPipe.IsRestrictedServiceIdentity(identity)) throw new InvalidOperationException();
                if ((File.GetAttributes(Program.Root) & FileAttributes.ReparsePoint) != 0 ||
                    (File.GetAttributes(Program.StateDirectory) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException();
                state = new BrokerState(Program.StateDirectory);
                policy = Policy.Load(BrokerState.ReadKnown(Path.Combine(Program.Root, "policy.json"), 4096));
                RequestAdditionalTime(15000);
                try { BrokerState.ProbeProfile(); }
                catch (Exception) { state.TryAudit("service", "dpapi_unavailable"); throw; }
                upstream = new Upstream(Upstream.CreateHandler());

                for (uint i = 0; i < ResponseWorkers; i++)
                    pipes[i] = WindowsPipe.CreateServer(WindowsPipe.RequestPipe, WindowsPipe.ServiceSid, policy.Caller, ResponseWorkers, i == 0);
                pipes[ResponseWorkers] = WindowsPipe.CreateServer(WindowsPipe.StatusPipe, WindowsPipe.ServiceSid, policy.Caller);
                pipes[ResponseWorkers + 1] = WindowsPipe.CreateServer(WindowsPipe.AdminPipe, WindowsPipe.ServiceSid, WindowsPipe.Administrators);
                state.Audit("service", "started");
                listeners = pipes.Select((pipe, index) => Task.Run(() => Listen(pipe, index >= ResponseWorkers, index > ResponseWorkers))).ToArray();
            }
            catch (Exception)
            {
                if (state != null) state.TryAudit("service", "startup_failed");
                CloseResources();
                ExitCode = 1;
                throw new InvalidOperationException("Sol broker initialization failed.");
            }
        }

        protected override void OnStop()
        {
            stop.Cancel();
            try { if (listeners != null) Task.WaitAll(listeners, Protocol.IoTimeoutMs + 1000); }
            catch (AggregateException) { }
            finally
            {
                CloseResources();
                if (state != null) state.TryAudit("service", "stopped");
            }
        }

        private void CloseResources()
        {
            foreach (var pipe in pipes) if (pipe != null) pipe.Dispose();
            if (upstream != null) upstream.Dispose();
        }

        private async Task Listen(NamedPipeServerStream pipe, bool status, bool admin)
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    await WindowsPipe.Wait(pipe, stop.Token).ConfigureAwait(false);
                    try { await Serve(pipe, status, admin).ConfigureAwait(false); }
                    catch (Exception) { if (!stop.IsCancellationRequested) state.TryAudit(admin ? "admin" : status ? "status" : "response", "ipc_closed"); }
                    finally { pipe.Disconnect(); }
                }
            }
            catch (Exception)
            {
                if (!stop.IsCancellationRequested)
                {
                    state.TryAudit("service", "listener_failed");
                    // The SCM must not report a healthy service after a listener failed closed.
                    Environment.Exit(1);
                }
            }
        }

        private async Task Serve(NamedPipeServerStream pipe, bool status, bool admin)
        {
            byte[] request;
            using (var input = CancellationTokenSource.CreateLinkedTokenSource(stop.Token))
            {
                input.CancelAfter(Protocol.IoTimeoutMs);
                byte[] hello = await WindowsPipe.Read(pipe, 1, input.Token).ConfigureAwait(false);
                if (hello[0] != Protocol.Hello || !WindowsPipe.AuthorizedClient(pipe.SafePipeHandle, policy.Caller, admin))
                {
                    state.TryAudit(admin ? "admin" : status ? "status" : "response", "denied", 403);
                    await WindowsPipe.Write(pipe, new byte[] { 0 }, input.Token).ConfigureAwait(false);
                    return;
                }
                await WindowsPipe.Write(pipe, new[] { Protocol.Hello }, input.Token).ConfigureAwait(false);
                try { request = await WindowsPipe.ReadFrame(pipe, admin ? Protocol.MaxKeyBytes + 1 : Protocol.MaxRequestBytes, input.Token).ConfigureAwait(false); }
                catch (BodyTooLargeException) { request = null; }
            }

            string operation = admin ? (request != null && request[0] == Protocol.SetKey ? "enroll" : "admin_check") :
                status ? "status" : "response";
            byte[] reply = request == null ? Protocol.Error("BROKER_INPUT_LIMIT") :
                admin ? HandleAdmin(request) : await HandleRequest(pipe, status, request).ConfigureAwait(false);
            var result = Protocol.Parse(reply);
            state.TryAudit(operation, Protocol.Get(result, "code") as string ?? "success", (int)result["status"]);
            await Send(pipe, reply).ConfigureAwait(false);
        }

        private async Task Send(NamedPipeServerStream pipe, byte[] reply)
        {
            using (var output = CancellationTokenSource.CreateLinkedTokenSource(stop.Token))
            {
                output.CancelAfter(Protocol.IoTimeoutMs);
                await WindowsPipe.WriteFrame(pipe, reply, output.Token).ConfigureAwait(false);
                byte[] finish = await WindowsPipe.Read(pipe, 1, output.Token).ConfigureAwait(false);
                if (finish[0] != Protocol.Finish) throw new InvalidDataException();
            }
        }

        private byte[] HandleAdmin(byte[] request)
        {
            try
            {
                if (request[0] == Protocol.Check && request.Length == 1) return Protocol.Success(new { ready = true });
                if (request[0] != Protocol.SetKey || request.Length < 9) return Protocol.Error("BROKER_PROTOCOL");
                byte[] key = request.Skip(1).ToArray();
                try
                {
                    if (!Protocol.ValidKey(key)) return Protocol.Error("BROKER_PROTOCOL");
                    state.Audit("enroll", "reserved");
                    state.SetKey(key);
                    return Protocol.Success(new { ready = true });
                }
                finally { Array.Clear(key, 0, key.Length); }
            }
            catch (Exception) { return Protocol.Error("BROKER_STORAGE_UNAVAILABLE"); }
            finally { Array.Clear(request, 0, request.Length); }
        }

        private async Task<byte[]> HandleRequest(NamedPipeServerStream pipe, bool status, byte[] request)
        {
            byte[] body = null;
            try
            {
                var envelope = Protocol.Parse(request);
                Protocol.Fields(envelope, status ? new[] { "op" } : new[] { "op", "body" });
                if (!(status ? "status" : "response").Equals(envelope["op"])) return Protocol.Error("BROKER_PROTOCOL");
                if (!status) body = policy.ValidateRequest(envelope["body"]);
            }
            catch (BodyTooLargeException) { return Protocol.Error("BROKER_INPUT_LIMIT"); }
            catch (Exception) { return Protocol.Error(status ? "BROKER_PROTOCOL" : "BROKER_POLICY_DENIED"); }

            byte[] key = null;
            try
            {
                try
                {
                    key = state.Key();
                    if (status) return Protocol.Success(policy.Status(key != null));
                    if (key == null) return Protocol.Error("BROKER_CREDENTIAL_MISSING");
                    if (!state.Reserve(DateTime.UtcNow, policy.RequestsPerHour)) return Protocol.Error("BROKER_RATE_LIMITED");
                    state.Audit("response", "reserved");
                }
                catch (Exception) { return Protocol.Error("BROKER_STORAGE_UNAVAILABLE"); }

                return await CallAndWatchPeer(pipe, body, key).ConfigureAwait(false);
            }
            finally { if (key != null) Array.Clear(key, 0, key.Length); }
        }

        private async Task<byte[]> CallAndWatchPeer(PipeStream pipe, byte[] body, byte[] key)
        {
            // A disconnect can interrupt an in-flight API call. The reserved budget still counts the call.
            using (var watch = CancellationTokenSource.CreateLinkedTokenSource(stop.Token))
            using (var call = CancellationTokenSource.CreateLinkedTokenSource(stop.Token))
            {
                Task<byte[]> peer = WindowsPipe.Read(pipe, 1, watch.Token);
                Task<byte[]> pending = upstream.Request(policy, body, key, call.Token);
                if (await Task.WhenAny(peer, pending).ConfigureAwait(false) == peer) call.Cancel();
                watch.Cancel();
                try { await peer.ConfigureAwait(false); }
                catch (IOException) { }
                catch (OperationCanceledException) { }
                return await pending.ConfigureAwait(false);
            }
        }
    }
}
