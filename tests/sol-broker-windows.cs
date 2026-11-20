using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;

namespace AiRule.Sol.Windows
{
    internal static class NativeTests
    {
        private const string Caller = "S-1-5-21-1200-1300-1400-1500";
        private const string Synthetic = "offline-broker-synthetic-value";
        private static readonly string Body = @"{""model"":""gpt-6.2-sol"",""store"":false,""reasoning"":{""effort"":""max""},
            ""include"":[""reasoning.encrypted_content""],""input"":[{""role"":""developer"",""content"":""test phrase""},
            {""type"":""reasoning"",""id"":""rs_mock"",""summary"":[],""content"":null,""encrypted_content"":""ciphertext""},
            {""type"":""message"",""id"":""msg_mock"",""status"":""completed"",""role"":""assistant"",""phase"":""commentary"",
            ""content"":[{""type"":""output_text"",""text"":""text"",""annotations"":[],""logprobs"":[]}]},
            {""type"":""function_call"",""name"":""delegate_work"",""id"":""fc_mock"",""call_id"":""call_mock"",""arguments"":""{}"",""status"":""completed""},
            {""type"":""function_call_output"",""call_id"":""call_mock"",""output"":""{}""}],
            ""tools"":[{""type"":""function"",""name"":""delegate_work"",""strict"":true,""description"":""Example"",""parameters"":{
            ""type"":""object"",""properties"":{""plan"":{""type"":""string"",""description"":""Example plan""}},""required"":[""plan""],""additionalProperties"":false}}],
            ""tool_choice"":""required"",""parallel_tool_calls"":false,""max_output_tokens"":16000}";

        internal static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "ci-enroll")
            {
                if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true") return 2;
                return Program.AdminExchange(Protocol.SetKey, Protocol.Utf8.GetBytes(Synthetic)).GetAwaiter().GetResult() ? 0 : 1;
            }
            if (args.Length == 1 && args[0] == "ci-deny-state")
            {
                try { File.ReadAllBytes(Path.Combine(Program.StateDirectory, "credential.dpapi")); return 1; }
                catch (UnauthorizedAccessException) { return 0; }
            }
            if (args.Length == 2 && args[0] == "ci-deny-decrypt")
            {
                try { BrokerState.Unprotect(File.ReadAllBytes(args[1])); return 1; }
                catch (System.Security.Cryptography.CryptographicException) { return 0; }
            }
            if (args.Length == 2 && args[0] == "ci-probe-status")
                return ProbeStatus(new SecurityIdentifier(args[1])).GetAwaiter().GetResult();
            if (args.Length != 2 || args[0] != "unit") return 2;
            try
            {
                TestPolicy();
                TestUpstream().GetAwaiter().GetResult();
                TestRate(args[1]);
                TestPipes().GetAwaiter().GetResult();
                Console.WriteLine("Windows broker offline policy, transport, rate and native pipe tests passed.");
                return 0;
            }
            catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
        }

        private static void Check(bool value, string message)
        {
            if (!value) throw new InvalidOperationException(message);
        }

        private static void Reject(Action action, string message)
        {
            try { action(); }
            catch (InvalidDataException) { return; }
            catch (System.Xml.XmlException) { return; }
            catch (BodyTooLargeException) { return; }
            throw new InvalidOperationException(message);
        }

        private static Dictionary<string, object> Parse(string json) { return Protocol.Parse(Protocol.Utf8.GetBytes(json)); }

        private static Policy TestRoute()
        {
            return Policy.Load(Protocol.Encode(new { caller_sid = Caller, model = "gpt-6.2-sol", reasoning_effort = "max",
                project = "proj_example", organization = "org-example" }));
        }

        private static void TestPolicy()
        {
            var policy = TestRoute();
            byte[] valid = policy.ValidateRequest(Parse(Body));
            Check(valid.Length <= Protocol.MaxInputBytes, "A normal stateless replay must be accepted.");
            string unicode = new string('\u4e2d', 60000);
            var roundTrip = Protocol.Parse(policy.ValidateRequest(Parse(Body.Replace("test phrase", unicode))));
            Check(Protocol.Object(Protocol.Array(roundTrip["input"])[0])["content"].Equals(unicode), "Unicode content must round-trip at scale.");
            Reject(() => Parse("{\"op\":\"status\",\"op\":\"response\"}"), "Ambiguous duplicate JSON fields must be rejected.");
            Reject(() => Parse("{\"op\":\"status\"}{\"op\":\"status\"}"), "Multiple JSON values must be rejected.");
            Reject(() => Parse("{\"__type\":\"hidden\",\"op\":\"status\"}"), "Deserializer metadata must be rejected.");
            Reject(() => policy.ValidateRequest(Parse(Body.Replace("6.2-sol", "6.2-astra"))), "A different model must be rejected.");
            Reject(() => policy.ValidateRequest(Parse(Body.Replace("\"max\"", "\"low\""))), "Different reasoning effort must be rejected.");
            Reject(() => policy.ValidateRequest(Parse(Body.Replace("16000", "64001"))), "Output tokens must be bounded.");
            Reject(() => policy.ValidateRequest(Parse(Body.Replace("16000", "1"))), "The Responses minimum must be enforced.");
            Reject(() => policy.ValidateRequest(Parse(Body.Replace("\"store\":false", "\"store\":true"))), "Provider storage must be disabled.");
            Reject(() => policy.ValidateRequest(Parse(Body.Replace("\"store\":false", "\"store\":false,\"background\":true"))), "Unknown fields must be rejected.");
            Reject(() => policy.ValidateRequest(Parse(Body.Replace("\"function\"", "\"web_search\""))), "Built-in tools must be rejected.");
            Reject(() => policy.ValidateRequest(Parse(Body.Replace("\"output_text\"", "\"input_file\""))), "Files and externally sourced inputs must be rejected.");
            Reject(() => policy.ValidateRequest(Parse(Body.Replace("test phrase", new string('x', Protocol.MaxInputBytes)))), "Input bytes must be bounded.");
            Reject(() => Protocol.ValidateReply(Parse("{\"ok\":false,\"status\":502,\"code\":\"rawException\"}")), "Only fixed error codes are accepted.");
            Reject(() => Protocol.ValidateReply(Parse("{\"ok\":false,\"status\":502,\"code\":\"UPSTREAM_UNKNOWN\",\"request_id\":\"unexpected\"}")), "Only fixed request ID shapes are accepted.");
        }

        private static async Task TestUpstream()
        {
            var policy = TestRoute();
            using (var real = Upstream.CreateHandler())
                Check(!real.AllowAutoRedirect && !real.UseProxy && !real.UseCookies && !real.UseDefaultCredentials, "The installed transport must disable intermediary forwarding.");
            var handler = new StubTransport();
            byte[] body = policy.ValidateRequest(Parse(Body));
            byte[] key = Protocol.Utf8.GetBytes(Synthetic);
            using (var upstream = new Upstream(handler))
            {
                handler.Reply = () => Reply(HttpStatusCode.OK, "{\"model\":\"gpt-6.2-sol\",\"output\":[],\"raw\":\"unprojected\"}", "req_test123");
                byte[] reply = await upstream.Request(policy, body, key, CancellationToken.None);
                var ok = Protocol.Parse(reply);
                Check(ok["request_id"].Equals("req_test123") && !Protocol.Object(ok["body"]).ContainsKey("raw"), "Only projected response fields and a valid request ID cross the boundary.");
                handler.Reply = () => Reply(HttpStatusCode.TemporaryRedirect, Synthetic, "untrusted value");
                var denied = Protocol.Parse(await upstream.Request(policy, body, key, CancellationToken.None));
                Check(denied["code"].Equals("UPSTREAM_HTTP") && denied["status"].Equals(307) && denied.Count == 3, "Upstream errors must retain status only.");
                handler.Reply = () => Reply(HttpStatusCode.OK, "{\"output\":[\"" + Synthetic + "\"]}", "req_test123");
                reply = await upstream.Request(policy, body, key, CancellationToken.None);
                Check(!Protocol.Utf8.GetString(reply).Contains(Synthetic) && Protocol.Parse(reply)["code"].Equals("UPSTREAM_UNKNOWN"), "Even an echoed key must be withheld.");
                handler.Reply = () => Reply(HttpStatusCode.OK, "{\"output\":\"" + new string('x', Protocol.MaxResponseBytes) + "\"}", null);
                Check(Protocol.Parse(await upstream.Request(policy, body, key, CancellationToken.None))["code"].Equals("UPSTREAM_UNKNOWN"), "An oversized response must be withheld.");
                handler.Reply = () => { throw new IOException(Synthetic); };
                reply = await upstream.Request(policy, body, key, CancellationToken.None);
                Check(!Protocol.Utf8.GetString(reply).Contains(Synthetic) && Protocol.Parse(reply)["code"].Equals("UPSTREAM_UNKNOWN"), "Transport exceptions must be represented without raw text.");
                Check(Protocol.Parse(await upstream.Request(policy, body, key, new CancellationToken(true)))["code"].Equals("UPSTREAM_UNSENT"), "A pre-send stop must have a distinct safe code.");
            }
            Check(handler.Calls == 5, "Every permitted request should send exactly one HTTP exchange in this test.");
        }

        private static HttpResponseMessage Reply(HttpStatusCode status, string content, string requestId)
        {
            var message = new HttpResponseMessage(status) { Content = new StringContent(content) };
            if (requestId != null) message.Headers.Add("x-request-id", requestId);
            return message;
        }

        private sealed class StubTransport : HttpMessageHandler
        {
            internal Func<HttpResponseMessage> Reply;
            internal int Calls;
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
            {
                Check(request.RequestUri.AbsoluteUri == "https://api.openai.com/v1/responses" && request.Method == HttpMethod.Post, "The route must be fixed.");
                Check(request.Headers.Authorization.Scheme == "Bearer" && request.Headers.Authorization.Parameter == Synthetic, "The broker must authenticate only its upstream POST.");
                Check(request.Headers.GetValues("OpenAI-Project").Single() == "proj_example" &&
                    request.Headers.GetValues("OpenAI-Organization").Single() == "org-example", "The administrator's routing headers must be applied.");
                Calls++;
                return Task.FromResult(Reply());
            }
        }

        private static void TestRate(string directory)
        {
            var clock = new DateTime(2026, 11, 20, 0, 0, 0, DateTimeKind.Utc);
            var state = new BrokerState(directory);
            int admitted = 0;
            Parallel.For(0, Protocol.CallsPerHour + 6, _ => { if (state.Reserve(clock)) Interlocked.Increment(ref admitted); });
            Check(admitted == Protocol.CallsPerHour, "Parallel callers must share one admission quota.");
            Check(!new BrokerState(directory).Reserve(clock.AddMinutes(59)), "A restart must retain outstanding quota.");
            Check(new BrokerState(directory).Reserve(clock.AddHours(1)), "A full hour must release earlier admission slots.");
            File.WriteAllBytes(Path.Combine(directory, "rate.bin"), new byte[] { 1 });
            Reject(() => state.Reserve(clock), "A corrupt admission state must fail closed.");
        }

        private static async Task TestPipes()
        {
            string pipeName = @"\\.\pipe\AiRuleSolBroker.OfflineTest." + Guid.NewGuid().ToString("N");
            using (var identity = WindowsIdentity.GetCurrent())
            using (var server = WindowsPipe.CreateServer(pipeName, identity.User, TestAccessSid(identity)))
            using (var lifetime = new CancellationTokenSource(5000))
            {
                try
                {
                    using (WindowsPipe.CreateServer(pipeName, identity.User, TestAccessSid(identity))) { }
                    throw new InvalidOperationException("The first instance must be exclusive.");
                }
                catch (BrokerException) { }

                Task accepted = WindowsPipe.Wait(server, lifetime.Token);
                using (var client = WindowsPipe.Connect(pipeName))
                {
                    await accepted;
                    Check(WindowsPipe.OwnedBy(client.SafePipeHandle, identity.User), "The pipe owner must be checked through the real handle.");
                    Check(!WindowsPipe.IsBrokerServer(client.SafePipeHandle), "A pipe outside SCM must never authenticate as the service.");
                    await WindowsPipe.Write(client, new[] { Protocol.Hello }, lifetime.Token);
                    Check((await WindowsPipe.Read(server, 1, lifetime.Token))[0] == Protocol.Hello, "The pipe handshake failed.");
                    bool elevated = identity.Groups.Any(group => group.Equals(WindowsPipe.Administrators));
                    Check(WindowsPipe.AuthorizedClient(server.SafePipeHandle, identity.User, false) == !elevated, "Authorization must use the connected token and elevation.");
                    Check(!WindowsPipe.AuthorizedClient(server.SafePipeHandle, new SecurityIdentifier(Caller), false), "An incorrect caller SID must be rejected.");

                    using (var timeout = new CancellationTokenSource(100))
                    {
                        Task<byte[]> stalled = WindowsPipe.Read(server, 1, timeout.Token);
                        Check(await Task.WhenAny(stalled, Task.Delay(2000)) == stalled, "The native read deadline must cancel pending I/O.");
                        Check(stalled.IsFaulted || stalled.IsCanceled, "A stalled pipe must not return bytes.");
                    }
                    await WindowsPipe.WriteFrame(client, new byte[] { 11, 22, 33 }, lifetime.Token);
                    Check((await WindowsPipe.ReadFrame(server, 16, lifetime.Token)).SequenceEqual(new byte[] { 11, 22, 33 }), "A timed-out pipe read must leave the instance reusable.");
                }
                server.Disconnect();
                Task next = WindowsPipe.Wait(server, lifetime.Token);
                using (WindowsPipe.Connect(pipeName)) await next;
                server.Disconnect();
                using (var timeout = new CancellationTokenSource(100))
                {
                    Task wait = WindowsPipe.Wait(server, timeout.Token);
                    Check(await Task.WhenAny(wait, Task.Delay(2000)) == wait && (wait.IsFaulted || wait.IsCanceled), "The connection wait must be cancellable while stopping.");
                }
            }
        }

        private static SecurityIdentifier TestAccessSid(WindowsIdentity identity)
        {
            // Local development may itself be inside a Windows AppContainer. Its package SID
            // needs an ACE on this ephemeral fixture. The installed broker uses the ordinary caller SID.
            int length;
            GetTokenInformation(identity.Token, 31, IntPtr.Zero, 0, out length);
            if (length <= 0) return identity.User;
            IntPtr info = Marshal.AllocHGlobal(length);
            try
            {
                if (!GetTokenInformation(identity.Token, 31, info, length, out length)) return identity.User;
                IntPtr sid = Marshal.ReadIntPtr(info);
                return sid == IntPtr.Zero ? identity.User : new SecurityIdentifier(sid);
            }
            finally { Marshal.FreeHGlobal(info); }
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int type, IntPtr info, int size, out int needed);

        private static async Task<int> ProbeStatus(SecurityIdentifier expected)
        {
            using (var identity = WindowsIdentity.GetCurrent())
                Console.WriteLine(expected.Equals(identity.User) ? "caller-sid-match" : "caller-sid-mismatch");
            try
            {
                using (var pipe = WindowsPipe.Connect(WindowsPipe.StatusPipe))
                using (var timer = new CancellationTokenSource(Protocol.IoTimeoutMs))
                {
                    Console.WriteLine("pipe-open");
                    Console.WriteLine(WindowsPipe.OwnedBy(pipe.SafePipeHandle, WindowsPipe.ServiceSid) ? "pipe-owner-match" : "pipe-owner-mismatch");
                    bool authentic = WindowsPipe.IsBrokerServer(pipe.SafePipeHandle);
                    Console.WriteLine(authentic ? "scm-match" : "scm-mismatch");
                    if (!authentic) return 1;
                    await WindowsPipe.Write(pipe, new[] { Protocol.Hello }, timer.Token);
                    bool grant = (await WindowsPipe.Read(pipe, 1, timer.Token))[0] == Protocol.Hello;
                    Console.WriteLine(grant ? "pipe-granted" : "pipe-denied");
                }
            }
            catch (BrokerException ex) { Console.WriteLine(ex.Code); return 1; }
            catch (Exception) { Console.WriteLine("pipe-io-failed"); return 1; }
            return 0;
        }
    }
}
