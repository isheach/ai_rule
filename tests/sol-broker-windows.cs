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
                TestTerraPolicy(args[1]);
                TestQuota(args[1]);
                TestUpstream().GetAwaiter().GetResult();
                TestRate(args[1]);
                TestPipes().GetAwaiter().GetResult();
                Console.WriteLine("Windows broker offline policy, quota, transport, rate and native pipe tests passed.");
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

        private static Policy TestTerraRoute(string effort = "max")
        {
            return Policy.Load(Protocol.Encode(new { caller_sid = Caller, model = "gpt-6.2-sol", reasoning_effort = effort,
                allow_terra_api = true, project = "proj_example", organization = "org-example" }));
        }

        private static Policy LoadPolicy(string effort, string terraField)
        {
            string json = "{\"caller_sid\":\"" + Caller + "\",\"model\":\"gpt-6.2-sol\",\"reasoning_effort\":\"" + effort + "\"" +
                (terraField == null ? "" : ",\"allow_terra_api\":" + terraField) + "}";
            return Policy.Load(Protocol.Utf8.GetBytes(json));
        }

        private static Policy LoadQuotaPolicy(string quotaField)
        {
            string json = "{\"caller_sid\":\"" + Caller + "\",\"model\":\"gpt-6.2-sol\",\"reasoning_effort\":\"max\"," +
                "\"allow_terra_api\":true,\"requests_per_hour\":" + quotaField + "}";
            return Policy.Load(Protocol.Utf8.GetBytes(json));
        }

        private static string TerraBody()
        {
            return Body.Replace("\"model\":\"gpt-6.2-sol\"", "\"model\":\"" + Policy.TerraModel + "\"")
                .Replace("\"name\":\"delegate_work\"", "\"name\":\"terra_action\"");
        }

        private static void CheckLegacyStatus(Policy policy, string label)
        {
            var status = Protocol.Parse(Protocol.Encode(policy.Status(true)));
            Check(status.Count == 7 && status["ready"].Equals(true) && status["model"].Equals("gpt-6.2-sol") &&
                status["reasoning_effort"].Equals("max") && status["requests_per_hour"].Equals(Protocol.CallsPerHour) &&
                status["max_input_bytes"].Equals(Protocol.MaxInputBytes) &&
                status["max_output_tokens"].Equals(Protocol.MaxOutputTokens) && status["api_timeout_ms"].Equals(Protocol.ApiTimeoutMs) &&
                status.Keys.All(key => !key.StartsWith("terra_", StringComparison.Ordinal)),
                label + " must retain the exact legacy status fields and values, including the default quota.");
        }

        private static void TestTerraPolicy(string directory)
        {
            CheckLegacyStatus(LoadPolicy("max", null), "A policy without allow_terra_api");
            CheckLegacyStatus(LoadPolicy("max", "false"), "A policy with allow_terra_api=false");
            foreach (string invalid in new[] { "\"true\"", "1", "null", "{}" })
            {
                string field = invalid;
                Reject(() => LoadPolicy("max", field), "Only a boolean allow_terra_api may be accepted.");
            }
            Reject(() => Policy.Load(Protocol.Encode(new { caller_sid = Caller, model = Policy.TerraModel,
                reasoning_effort = "max", allow_terra_api = true })), "The Terra model cannot also be the configured Sol model.");

            var legacy = LoadPolicy("max", null);
            var disabled = LoadPolicy("max", "false");
            Reject(() => legacy.ValidateRequest(Parse(TerraBody())), "A missing allow_terra_api must not authorize Terra.");
            Reject(() => disabled.ValidateRequest(Parse(TerraBody())), "An explicit false must not authorize Terra.");

            var terra = TestTerraRoute();
            Check(terra.TerraEnabled, "Explicit true must enable the Terra role.");
            Check(terra.ValidateRequest(Parse(TerraBody())).Length > 0, "The Terra role must accept its fixed model, effort and tools.");
            Check(terra.ValidateRequest(Parse(Body)).Length > 0, "Enabling Terra must not change the Sol route.");
            foreach (string name in new[] { "confirm_terra_api", "terra_action", "finish_terra" })
                Check(terra.ValidateRequest(Parse(TerraBody().Replace("terra_action", name))).Length > 0, "Each Terra tool name must be accepted.");
            foreach (string name in new[] { "confirm_sol_api", "delegate_work", "finish_coordination" })
                Check(TestRoute().ValidateRequest(Parse(Body.Replace("delegate_work", name))).Length > 0, "Each original Sol tool name must remain accepted.");

            Reject(() => TestRoute().ValidateRequest(Parse(TerraBody())), "Sol must reject the Terra model and tools.");
            Reject(() => terra.ValidateRequest(Parse(TerraBody().Replace("terra_action", "delegate_work"))), "Terra must reject Sol names in tools and history.");
            Reject(() => TestRoute().ValidateRequest(Parse(Body.Replace("delegate_work", "terra_action"))), "Sol must reject Terra names in tools and history.");
            Reject(() => terra.ValidateRequest(Parse(Body.Replace("gpt-6.2-sol", Policy.TerraModel))), "Terra must reject a Sol tool set even with the Terra model.");

            var unknownToolBody = Parse(TerraBody());
            var unknownTool = Protocol.Object(Protocol.Parse(Protocol.Encode(((object[])Parse(TerraBody())["tools"])[0])));
            unknownTool["name"] = "unknown_action";
            ((object[])unknownToolBody["tools"])[0] = unknownTool;
            Reject(() => terra.ValidateRequest(unknownToolBody), "Terra must reject an unknown tool name.");
            var unknownInputBody = Parse(TerraBody());
            Protocol.Object(Protocol.Array(unknownInputBody["input"])[3])["name"] = "unknown_action";
            Reject(() => terra.ValidateRequest(unknownInputBody), "Terra history must reject an unknown function name.");

            var mixed = Parse(TerraBody());
            var solTool = Protocol.Object(Protocol.Parse(Protocol.Encode(((object[])Parse(Body)["tools"])[0])));
            var mixedTools = new List<object>((object[])mixed["tools"]) { solTool };
            mixed["tools"] = mixedTools.ToArray();
            Reject(() => terra.ValidateRequest(mixed), "Terra must reject a mixed Sol/Terra tool list.");

            var inputCross = Parse(Body);
            Protocol.Object(Protocol.Array(inputCross["input"])[3])["name"] = "terra_action";
            Reject(() => TestRoute().ValidateRequest(inputCross), "Sol history must reject a Terra function name even with Sol tools.");
            var terraInputCross = Parse(TerraBody());
            Protocol.Object(Protocol.Array(terraInputCross["input"])[3])["name"] = "delegate_work";
            Reject(() => terra.ValidateRequest(terraInputCross), "Terra history must reject a Sol function name even with Terra tools.");

            var strict = TerraBody().Replace("\"strict\":true", "\"strict\":false");
            Reject(() => terra.ValidateRequest(Parse(strict)), "Terra tools must remain strict.");
            Reject(() => terra.ValidateRequest(Parse(TerraBody().Replace("\"function\"", "\"web_search\""))), "Terra must reject built-in tools.");
            Reject(() => terra.ValidateRequest(Parse(TerraBody().Replace("\"type\":\"message\"", "\"type\":\"input_file\""))), "Terra must reject unsupported input item types.");
            Reject(() => terra.ValidateRequest(Parse(TerraBody().Replace("\"store\":false", "\"store\":true"))), "Terra must keep provider storage disabled.");
            Reject(() => terra.ValidateRequest(Parse(TerraBody().Replace("\"store\":false", "\"store\":false,\"allow_terra_api\":true"))), "A request must not grant itself Terra.");
            Reject(() => terra.ValidateRequest(Parse(TerraBody().Replace("test phrase", new string('x', Protocol.MaxInputBytes)))), "Terra input bytes must be bounded.");
            Reject(() => terra.ValidateRequest(Parse(TerraBody().Replace("\"max\"", "\"high\""))), "Terra reasoning effort must stay max.");

            var flexible = TestTerraRoute("high");
            Check(flexible.ValidateRequest(Parse(Body.Replace("\"max\"", "\"high\""))).Length > 0, "Sol must keep its configured effort.");
            Check(flexible.ValidateRequest(Parse(TerraBody())).Length > 0, "Terra must ignore the configured Sol effort and use max.");
            Reject(() => flexible.ValidateRequest(Parse(TerraBody().Replace("\"max\"", "\"high\""))), "Terra must reject the configured Sol effort.");

            var status = Protocol.Parse(Protocol.Encode(terra.Status(false)));
            Check(status["ready"].Equals(false) && status["model"].Equals("gpt-6.2-sol") && status["reasoning_effort"].Equals("max") &&
                status["requests_per_hour"].Equals(Protocol.CallsPerHour) &&
                status["max_input_bytes"].Equals(Protocol.MaxInputBytes) && status["max_output_tokens"].Equals(Protocol.MaxOutputTokens) &&
                status["api_timeout_ms"].Equals(Protocol.ApiTimeoutMs), "Terra status must retain the legacy fields and values, including the effective quota.");
            Check(status["terra_enabled"].Equals(true) && status["terra_model"].Equals(Policy.TerraModel) &&
                status["terra_reasoning_effort"].Equals(Policy.TerraEffort) &&
                ((object[])status["terra_tools"]).Cast<string>().SequenceEqual(new[] { "confirm_terra_api", "terra_action", "finish_terra" }),
                "Explicit opt-in must expose deterministic Terra capability fields.");
            Check(!status.ContainsKey("terra_ready") && !status.ContainsKey("terra_available"), "Status must not claim runtime Terra availability.");

            string quotaDirectory = Path.Combine(directory, "terra-quota");
            Directory.CreateDirectory(quotaDirectory);
            try
            {
                var state = new BrokerState(quotaDirectory);
                var clock = new DateTime(2026, 11, 21, 0, 0, 0, DateTimeKind.Utc);
                for (int index = 0; index < Protocol.CallsPerHour; index++)
                {
                    Policy role = index % 2 == 0 ? TestRoute() : terra;
                    role.ValidateRequest(Parse(index % 2 == 0 ? Body : TerraBody()));
                    Check(state.Reserve(clock, Protocol.CallsPerHour), "Every role-validated call must draw from the shared quota.");
                }
                Check(!state.Reserve(clock, Protocol.CallsPerHour), "Terra must not receive a separate quota from Sol.");
            }
            finally { Directory.Delete(quotaDirectory, true); }
        }

        private static void TestQuota(string directory)
        {
            var legacyPolicy = LoadPolicy("max", "false");
            Check(legacyPolicy.RequestsPerHour == Protocol.CallsPerHour && legacyPolicy.RequestsPerHour == 24,
                "A policy without requests_per_hour must retain the historical finite 24/hour fallback.");
            var previousPolicy = LoadQuotaPolicy("96");
            Check(previousPolicy.RequestsPerHour == 96, "An explicit 96/hour policy must retain that machine limit.");
            var upgradedPolicy = LoadQuotaPolicy("100");
            Check(upgradedPolicy.RequestsPerHour == 100, "An explicit 100/hour policy must load as the effective target.");
            var higherPolicy = LoadQuotaPolicy("250");
            var higherStatus = Protocol.Parse(Protocol.Encode(higherPolicy.Status(true)));
            Check(higherPolicy.RequestsPerHour == 250 && higherStatus["requests_per_hour"].Equals(250),
                "An explicit higher machine limit must be preserved rather than clamped to 100.");
            var status = Protocol.Parse(Protocol.Encode(upgradedPolicy.Status(true)));
            Check(status["requests_per_hour"].Equals(100) && status["terra_enabled"].Equals(true),
                "Read-only status must expose the effective quota without changing Terra capability.");
            foreach (string invalid in new[] { "0", "-1", "1001", "100.5", "\"100\"", "null", "true" })
            {
                string field = invalid;
                Reject(() => LoadQuotaPolicy(field), "The quota must be a positive bounded integer and never a string, boolean or fraction.");
            }

            string legacyDirectory = Path.Combine(directory, "quota-legacy");
            Directory.CreateDirectory(legacyDirectory);
            try
            {
                var clock = new DateTime(2026, 11, 22, 12, 0, 0, DateTimeKind.Utc);
                var legacy = new BrokerState(legacyDirectory);
                for (int index = 0; index < 24; index++)
                    Check(legacy.Reserve(clock, legacyPolicy.RequestsPerHour), "Each legacy synthetic call must be admitted under 24/hour.");
                Check(!new BrokerState(legacyDirectory).Reserve(clock, legacyPolicy.RequestsPerHour),
                    "The 25th synthetic call must be rejected under the historical 24/hour fallback.");
                Check(new FileInfo(Path.Combine(legacyDirectory, "rate.bin")).Length == 24 * sizeof(long),
                    "The legacy rolling record must persist 24 admissions.");
                Check(!new BrokerState(legacyDirectory).Reserve(clock.AddMinutes(59), legacyPolicy.RequestsPerHour),
                    "A restart before the rolling hour expires must not reset the legacy limit.");
                Check(new BrokerState(legacyDirectory).Reserve(clock.AddHours(1), legacyPolicy.RequestsPerHour),
                    "A full rolling hour must release the legacy admissions.");
            }
            finally { Directory.Delete(legacyDirectory, true); }

            string quotaDirectory = Path.Combine(directory, "quota-upgrade");
            Directory.CreateDirectory(quotaDirectory);
            try
            {
                var clock = new DateTime(2026, 11, 22, 12, 0, 0, DateTimeKind.Utc);
                var before = new BrokerState(quotaDirectory);
                for (int index = 0; index < 96; index++)
                    Check(before.Reserve(clock, previousPolicy.RequestsPerHour), "Each pre-upgrade synthetic call must be admitted under 96/hour.");
                Check(!new BrokerState(quotaDirectory).Reserve(clock, previousPolicy.RequestsPerHour),
                    "The 97th synthetic call must be denied before the explicit 96->100 upgrade.");
                Check(new FileInfo(Path.Combine(quotaDirectory, "rate.bin")).Length == 96 * sizeof(long),
                    "The 96 pre-upgrade rolling records must be persisted without reset.");

                // The same directory and rate.bin are used after the protected executable/policy replacement.
                for (int ordinal = 97; ordinal <= 100; ordinal++)
                {
                    string message = ordinal == 99 ? "The 99th synthetic call must be accepted at the new 100/hour limit." :
                        ordinal == 100 ? "The 100th synthetic call must be accepted at the new 100/hour limit." :
                        "Every synthetic call through the 100th slot must be accepted after the explicit 96->100 upgrade.";
                    Check(new BrokerState(quotaDirectory).Reserve(clock, upgradedPolicy.RequestsPerHour), message);
                }
                Check(!new BrokerState(quotaDirectory).Reserve(clock, upgradedPolicy.RequestsPerHour),
                    "The 101st synthetic call must be denied at the new 100/hour limit.");
                Check(new FileInfo(Path.Combine(quotaDirectory, "rate.bin")).Length == 100 * sizeof(long),
                    "All 96 previous and 4 post-upgrade admissions must remain in the rolling record.");
                Check(!new BrokerState(quotaDirectory).Reserve(clock, upgradedPolicy.RequestsPerHour),
                    "A restart must retain all 100 persisted rolling admissions.");
                Check(new BrokerState(quotaDirectory).Reserve(clock.AddHours(1), upgradedPolicy.RequestsPerHour),
                    "A full rolling hour must release the earlier admissions without touching the file manually.");
            }
            finally { Directory.Delete(quotaDirectory, true); }
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
            Parallel.For(0, Protocol.CallsPerHour + 6, _ => { if (state.Reserve(clock, Protocol.CallsPerHour)) Interlocked.Increment(ref admitted); });
            Check(admitted == Protocol.CallsPerHour, "Parallel callers must share one admission quota.");
            Check(!new BrokerState(directory).Reserve(clock.AddMinutes(59), Protocol.CallsPerHour), "A restart must retain outstanding quota.");
            Check(new BrokerState(directory).Reserve(clock.AddHours(1), Protocol.CallsPerHour), "A full hour must release earlier admission slots.");
            Reject(() => state.Reserve(clock, 0), "A non-positive quota must fail closed.");
            Reject(() => state.Reserve(clock, Protocol.MaxCallsPerHour + 1), "A quota above the finite upper bound must fail closed.");
            File.WriteAllBytes(Path.Combine(directory, "rate.bin"), new byte[] { 1 });
            Reject(() => state.Reserve(clock, Protocol.CallsPerHour), "A corrupt admission state must fail closed.");
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
