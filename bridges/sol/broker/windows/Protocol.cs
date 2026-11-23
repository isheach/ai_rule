using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Principal;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Xml;

namespace AiRule.Sol.Windows
{
    internal static class Protocol
    {
        internal const int MaxInputBytes = 768000;
        internal const int MaxRequestBytes = MaxInputBytes + 128;
        internal const int MaxResponseBytes = 1200000;
        internal const int MaxReplyBytes = MaxResponseBytes + 512;
        internal const int MaxOutputTokens = 64000;
        internal const int ApiTimeoutMs = 180000;
        internal const int IoTimeoutMs = 5000;
        internal const int ConnectTimeoutMs = 2500;
        internal const int CallsPerHour = 24;
        internal const int MaxCallsPerHour = 1000;
        internal const byte Hello = 1;
        internal const byte Finish = 2;
        internal const byte Check = 3;
        internal const byte SetKey = 4;
        internal const int MaxKeyBytes = 500;

        internal static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        internal static readonly Regex RequestId = new Regex(@"\Areq_[A-Za-z0-9_-]{1,100}\z", RegexOptions.CultureInvariant);
        private static readonly Regex JsonNumber = new Regex(@"\A-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?\z", RegexOptions.CultureInvariant);
        private static readonly IDictionary<string, int> LocalErrors = new Dictionary<string, int>(StringComparer.Ordinal) {
            { "BROKER_FORBIDDEN", 403 }, { "BROKER_PROTOCOL", 400 }, { "BROKER_POLICY_DENIED", 400 },
            { "BROKER_INPUT_LIMIT", 413 }, { "BROKER_CREDENTIAL_MISSING", 503 }, { "BROKER_RATE_LIMITED", 429 },
            { "BROKER_UNAVAILABLE", 503 }, { "BROKER_BUSY", 503 }, { "BROKER_OUTCOME_UNKNOWN", 502 },
            { "BROKER_STORAGE_UNAVAILABLE", 503 }, { "UPSTREAM_UNSENT", 502 }, { "UPSTREAM_UNKNOWN", 502 }
        };

        internal static Dictionary<string, object> Object(object value)
        {
            var result = value as Dictionary<string, object>;
            if (result == null) throw new InvalidDataException();
            return result;
        }

        internal static object[] Array(object value)
        {
            var result = value as object[];
            if (result == null) throw new InvalidDataException();
            return result;
        }

        internal static object Get(Dictionary<string, object> value, string key)
        {
            object field;
            return value.TryGetValue(key, out field) ? field : null;
        }

        internal static void Fields(Dictionary<string, object> value, string[] required, params string[] optional)
        {
            if (required.Any(key => !value.ContainsKey(key)) || value.Keys.Any(key => !required.Contains(key) && !optional.Contains(key)))
                throw new InvalidDataException();
        }

        internal static Dictionary<string, object> Parse(byte[] bytes)
        {
            if (bytes.Length == 0 || bytes.Length > MaxReplyBytes) throw new InvalidDataException();
            Utf8.GetCharCount(bytes); // The IPC and Responses both use strict UTF-8.
            var quotas = new XmlDictionaryReaderQuotas {
                MaxArrayLength = MaxReplyBytes, MaxDepth = 32, MaxStringContentLength = MaxReplyBytes,
                MaxBytesPerRead = 16384, MaxNameTableCharCount = 65536
            };
            using (var reader = JsonReaderWriterFactory.CreateJsonReader(bytes, quotas))
            {
                if (reader.MoveToContent() != XmlNodeType.Element) throw new InvalidDataException();
                var result = Object(ReadValue(reader));
                if (reader.MoveToContent() != XmlNodeType.None) throw new InvalidDataException();
                return result;
            }
        }

        private static object ReadValue(XmlDictionaryReader reader)
        {
            string type = reader.GetAttribute("type");
            if (reader.GetAttribute("__type") != null) throw new InvalidDataException();
            if (type == "object" || type == "array")
            {
                var fields = type == "object" ? new Dictionary<string, object>(StringComparer.Ordinal) : null;
                var values = type == "array" ? new List<object>() : null;
                bool empty = reader.IsEmptyElement;
                reader.ReadStartElement();
                if (!empty)
                {
                    while (reader.MoveToContent() == XmlNodeType.Element)
                    {
                        string name = reader.NamespaceURI == "item" ? reader.GetAttribute("item") : reader.LocalName;
                        if (fields != null)
                        {
                            if (name == null || fields.ContainsKey(name)) throw new InvalidDataException();
                            fields.Add(name, ReadValue(reader));
                        }
                        else values.Add(ReadValue(reader));
                    }
                    reader.ReadEndElement();
                }
                return fields == null ? (object)values.ToArray() : fields;
            }

            string text = reader.ReadElementContentAsString();
            if (type == "null" && text.Length == 0) return null;
            if (type == "string") return text;
            if (type == "boolean" && (text == "true" || text == "false")) return text == "true";
            if (type != "number" || text.Length > 100 || !JsonNumber.IsMatch(text)) throw new InvalidDataException();
            int intValue;
            if (int.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out intValue)) return intValue;
            long longValue;
            if (long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out longValue)) return longValue;
            decimal decimalValue;
            if (decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out decimalValue)) return decimalValue;
            double doubleValue;
            if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out doubleValue) && !double.IsInfinity(doubleValue) && !double.IsNaN(doubleValue)) return doubleValue;
            throw new InvalidDataException();
        }

        internal static byte[] Encode(object value)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = MaxReplyBytes, RecursionLimit = 32 };
            return Utf8.GetBytes(serializer.Serialize(value));
        }

        internal static byte[] Success(object body, string requestId = null)
        {
            return Reply(new Dictionary<string, object> { { "ok", true }, { "status", 200 }, { "body", body } }, requestId);
        }

        internal static byte[] Error(string code)
        {
            return Error(LocalErrors[code], code, null);
        }

        internal static byte[] Error(int status, string code, string requestId = null)
        {
            return Reply(new Dictionary<string, object> { { "ok", false }, { "status", status }, { "code", code } }, requestId);
        }

        private static byte[] Reply(Dictionary<string, object> result, string requestId)
        {
            if (requestId != null && RequestId.IsMatch(requestId)) result.Add("request_id", requestId);
            byte[] bytes = Encode(result);
            if (bytes.Length > MaxReplyBytes) throw new InvalidDataException();
            return bytes;
        }

        internal static void ValidateReply(Dictionary<string, object> value)
        {
            object ok = Get(value, "ok");
            object status = Get(value, "status");
            if (!(ok is bool) || !(status is int)) throw new InvalidDataException();
            if ((bool)ok)
            {
                Fields(value, new[] { "ok", "status", "body" }, "request_id");
                if ((int)status != 200) throw new InvalidDataException();
                Object(Get(value, "body"));
            }
            else
            {
                Fields(value, new[] { "ok", "status", "code" }, "request_id");
                string code = Get(value, "code") as string;
                int expected;
                if (code == "UPSTREAM_HTTP")
                {
                    if ((int)status < 300 || (int)status > 599) throw new InvalidDataException();
                }
                else if (code == null || !LocalErrors.TryGetValue(code, out expected) || (int)status != expected)
                    throw new InvalidDataException();
            }
            if (value.ContainsKey("request_id"))
            {
                string requestId = Get(value, "request_id") as string;
                if (requestId == null || !RequestId.IsMatch(requestId)) throw new InvalidDataException();
            }
        }

        internal static bool ValidKey(byte[] key)
        {
            return key.Length >= 8 && key.Length <= MaxKeyBytes && key.All(value =>
                (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
                (value >= '0' && value <= '9') || value == '-' || value == '_' || value == '.');
        }

        internal static async Task<byte[]> ReadBounded(Stream stream, int limit, CancellationToken cancellation)
        {
            using (var body = new MemoryStream())
            {
                byte[] buffer = new byte[8192];
                while (true)
                {
                    int count = await stream.ReadAsync(buffer, 0, Math.Min(buffer.Length, limit + 1 - (int)body.Length), cancellation).ConfigureAwait(false);
                    if (count == 0) return body.ToArray();
                    if (body.Length + count > limit) throw new InvalidDataException();
                    body.Write(buffer, 0, count);
                }
            }
        }
    }

    internal sealed class Policy
    {
        private static readonly Regex ModelPattern = new Regex(@"\A[a-z0-9][a-z0-9_.:-]{0,99}\z", RegexOptions.CultureInvariant);
        private static readonly Regex HeaderPattern = new Regex(@"\A[A-Za-z0-9_.:@/-]{1,160}\z", RegexOptions.CultureInvariant);
        private static readonly string[] Efforts = { "none", "minimal", "low", "medium", "high", "xhigh", "max" };
        private static readonly string[] SolTools = { "confirm_sol_api", "delegate_work", "delegate_peer", "finish_coordination" };
        private static readonly string[] TerraTools = { "confirm_terra_api", "terra_action", "finish_terra", "delegate_work", "finish_coordination" };
        private static readonly string[] LunaTools = { "confirm_luna_api", "delegate_work", "finish_coordination" };
        internal const string TerraModel = "gpt-6.1-terra";
        internal const string TerraEffort = "max";
        internal const string LunaModel = "gpt-6-luna";
        internal const string LunaEffort = "max";
        internal SecurityIdentifier Caller { get; private set; }
        internal string Model { get; private set; }
        internal string Effort { get; private set; }
        internal string Project { get; private set; }
        internal string Organization { get; private set; }
        internal bool TerraEnabled { get; private set; }
        internal bool LunaEnabled { get; private set; }
        internal int RequestsPerHour { get; private set; }

        internal static Policy Load(byte[] json)
        {
            if (json.Length > 4096) throw new InvalidDataException();
            var value = Protocol.Parse(json);
            Protocol.Fields(value, new[] { "caller_sid", "model", "reasoning_effort" },
                "project", "organization", "allow_terra_api", "allow_luna_api", "requests_per_hour");
            var sid = new SecurityIdentifier((string)value["caller_sid"]);
            string model = value["model"] as string;
            string effort = value["reasoning_effort"] as string;
            if ((!sid.IsAccountSid() && !sid.Value.StartsWith("S-1-12-1-", StringComparison.Ordinal)) || sid.Equals(WindowsPipe.ServiceSid) ||
                model == null || !ModelPattern.IsMatch(model) || !Efforts.Contains(effort)) throw new InvalidDataException();
            bool terraEnabled = Enabled(value, "allow_terra_api");
            bool lunaEnabled = Enabled(value, "allow_luna_api");
            // A model may select only one role's tool policy.
            if ((terraEnabled && TerraModel.Equals(model, StringComparison.Ordinal)) ||
                (lunaEnabled && LunaModel.Equals(model, StringComparison.Ordinal))) throw new InvalidDataException();
            int requestsPerHour = Protocol.CallsPerHour;
            if (value.ContainsKey("requests_per_hour"))
            {
                object quota = value["requests_per_hour"];
                if (!(quota is int) || (int)quota < 1 || (int)quota > Protocol.MaxCallsPerHour)
                    throw new InvalidDataException();
                requestsPerHour = (int)quota;
            }
            return new Policy { Caller = sid, Model = model, Effort = effort, TerraEnabled = terraEnabled, LunaEnabled = lunaEnabled,
                RequestsPerHour = requestsPerHour, Project = Header(value, "project"), Organization = Header(value, "organization") };
        }

        private static bool Enabled(Dictionary<string, object> value, string name)
        {
            object field;
            if (!value.TryGetValue(name, out field)) return false;
            if (!(field is bool)) throw new InvalidDataException();
            return (bool)field;
        }

        private static string Header(Dictionary<string, object> value, string name)
        {
            if (!value.ContainsKey(name)) return null;
            string header = value[name] as string;
            if (header == null || !HeaderPattern.IsMatch(header)) throw new InvalidDataException();
            return header;
        }

        internal object Status(bool ready)
        {
            if (!TerraEnabled && !LunaEnabled)
                return new { ready = ready, model = Model, reasoning_effort = Effort, requests_per_hour = RequestsPerHour,
                    max_input_bytes = Protocol.MaxInputBytes, max_output_tokens = Protocol.MaxOutputTokens,
                    api_timeout_ms = Protocol.ApiTimeoutMs };

            var status = new Dictionary<string, object>(StringComparer.Ordinal) {
                { "ready", ready }, { "model", Model }, { "reasoning_effort", Effort },
                { "requests_per_hour", RequestsPerHour },
                { "max_input_bytes", Protocol.MaxInputBytes }, { "max_output_tokens", Protocol.MaxOutputTokens },
                { "api_timeout_ms", Protocol.ApiTimeoutMs }
            };
            // Policy capability only. The top-level ready flag remains the runtime credential check.
            status.Add("sol_tools", SolTools.ToArray());
            if (TerraEnabled)
            {
                status.Add("terra_enabled", true);
                status.Add("terra_model", TerraModel);
                status.Add("terra_reasoning_effort", TerraEffort);
                status.Add("terra_tools", TerraTools.ToArray());
            }
            if (LunaEnabled)
            {
                status.Add("luna_enabled", true);
                status.Add("luna_model", LunaModel);
                status.Add("luna_reasoning_effort", LunaEffort);
                status.Add("luna_tools", LunaTools.ToArray());
            }
            return status;
        }

        internal byte[] ValidateRequest(object rawBody)
        {
            var body = Protocol.Object(rawBody);
            Protocol.Fields(body, new[] { "model", "store", "reasoning", "include", "input", "tools", "tool_choice", "parallel_tool_calls", "max_output_tokens" });
            var reasoning = Protocol.Object(body["reasoning"]);
            Protocol.Fields(reasoning, new[] { "effort" });
            object[] include = Protocol.Array(body["include"]);
            // The fixed request model selects the role; tool names never do.
            string model = body["model"] as string;
            bool sol = Model.Equals(model);
            bool terra = TerraEnabled && TerraModel.Equals(model, StringComparison.Ordinal);
            bool luna = LunaEnabled && LunaModel.Equals(model, StringComparison.Ordinal);
            string[] allowedTools = sol ? SolTools : terra ? TerraTools : luna ? LunaTools : null;
            string effort = sol ? Effort : terra ? TerraEffort : luna ? LunaEffort : null;
            if (allowedTools == null || !effort.Equals(reasoning["effort"]) || !false.Equals(body["store"]) ||
                !false.Equals(body["parallel_tool_calls"]) || !"required".Equals(body["tool_choice"]) ||
                include.Length != 1 || !"reasoning.encrypted_content".Equals(include[0]) || !(body["max_output_tokens"] is int))
                throw new InvalidDataException();
            int tokens = (int)body["max_output_tokens"];
            if (tokens < 16 || tokens > Protocol.MaxOutputTokens) throw new InvalidDataException();

            object[] tools = Protocol.Array(body["tools"]);
            var names = new HashSet<string>(StringComparer.Ordinal);
            if (tools.Length == 0 || tools.Length > allowedTools.Length) throw new InvalidDataException();
            foreach (object tool in tools)
                if (!names.Add(ValidateTool(Protocol.Object(tool), allowedTools))) throw new InvalidDataException();

            // The bridge uses text messages and replays Responses output while carrying forward encrypted reasoning.
            // These types have no built-in tools, file handles or URL-backed inputs.
            object[] input = Protocol.Array(body["input"]);
            if (input.Length == 0 || input.Length > 256) throw new InvalidDataException();
            foreach (object item in input) ValidateInput(Protocol.Object(item), allowedTools);
            byte[] normalized = Protocol.Encode(body);
            if (normalized.Length > Protocol.MaxInputBytes) throw new BodyTooLargeException();
            return normalized;
        }

        private static string ValidateTool(Dictionary<string, object> tool, string[] allowedTools)
        {
            Protocol.Fields(tool, new[] { "type", "name", "description", "strict", "parameters" });
            string name = tool["name"] as string;
            if (!"function".Equals(tool["type"]) || !allowedTools.Contains(name) || !(tool["description"] is string) || !true.Equals(tool["strict"]))
                throw new InvalidDataException();
            var schema = Protocol.Object(tool["parameters"]);
            Protocol.Fields(schema, new[] { "type", "properties", "required", "additionalProperties" });
            var properties = Protocol.Object(schema["properties"]);
            var required = Protocol.Array(schema["required"]);
            if (!"object".Equals(schema["type"]) || !false.Equals(schema["additionalProperties"]) ||
                properties.Count == 0 || properties.Count > 8 || required.Length != properties.Count || required.Distinct().Count() != properties.Count ||
                required.Any(field => !(field is string) || !properties.ContainsKey((string)field))) throw new InvalidDataException();
            foreach (object raw in properties.Values)
            {
                var property = Protocol.Object(raw);
                Protocol.Fields(property, new[] { "type" }, "description", "enum");
                if (!"string".Equals(property["type"]) || (property.ContainsKey("description") && !(property["description"] is string)) ||
                    (property.ContainsKey("enum") && Protocol.Array(property["enum"]).Any(choice => !(choice is string)))) throw new InvalidDataException();
            }
            return name;
        }

        private static void ValidateInput(Dictionary<string, object> item, string[] allowedTools)
        {
            string type = Protocol.Get(item, "type") as string;
            if (!item.ContainsKey("type"))
            {
                Protocol.Fields(item, new[] { "role", "content" });
                if ((!"developer".Equals(item["role"]) && !"user".Equals(item["role"])) || !(item["content"] is string)) throw new InvalidDataException();
                return;
            }
            switch (type)
            {
                case "function_call_output":
                    Protocol.Fields(item, new[] { "type", "call_id", "output" });
                    RequireStrings(item, "call_id", "output");
                    return;
                case "function_call":
                    Protocol.Fields(item, new[] { "type", "call_id", "arguments", "name" }, "id", "status");
                    RequireStrings(item, "call_id", "arguments", "name", "id", "status");
                    if (!allowedTools.Contains((string)item["name"])) throw new InvalidDataException();
                    return;
                case "reasoning":
                    Protocol.Fields(item, new[] { "type", "id", "summary" }, "encrypted_content", "content", "status");
                    RequireStrings(item, "id", "encrypted_content", "status");
                    ValidateParts(item["summary"], "summary_text");
                    if (Protocol.Get(item, "content") != null) ValidateParts(item["content"], "reasoning_text");
                    return;
                case "message":
                    Protocol.Fields(item, new[] { "type", "id", "role", "content" }, "status", "phase");
                    RequireStrings(item, "id", "status", "phase");
                    if (!"assistant".Equals(item["role"])) throw new InvalidDataException();
                    ValidateParts(item["content"], "output_text", "refusal");
                    return;
                default: throw new InvalidDataException();
            }
        }

        private static void RequireStrings(Dictionary<string, object> fields, params string[] names)
        {
            foreach (string name in names)
                if (fields.ContainsKey(name) && fields[name] != null && !(fields[name] is string)) throw new InvalidDataException();
        }

        private static void ValidateParts(object value, params string[] types)
        {
            foreach (object raw in Protocol.Array(value))
            {
                var part = Protocol.Object(raw);
                string type = Protocol.Get(part, "type") as string;
                string text = type == "refusal" ? "refusal" : "text";
                if (!types.Contains(type)) throw new InvalidDataException();
                Protocol.Fields(part, new[] { "type", text }, "annotations", "logprobs");
                if (!(part[text] is string) ||
                    (Protocol.Get(part, "annotations") != null && Protocol.Array(part["annotations"]).Length != 0) ||
                    (Protocol.Get(part, "logprobs") != null && Protocol.Array(part["logprobs"]).Length != 0)) throw new InvalidDataException();
            }
        }
    }

    internal sealed class BodyTooLargeException : Exception { }
}
