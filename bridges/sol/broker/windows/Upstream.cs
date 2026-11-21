using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace AiRule.Sol.Windows
{
    internal sealed class Upstream : IDisposable
    {
        private static readonly Uri Endpoint = new Uri("https://api.openai.com/v1/responses");
        private static readonly string[] ResponseFields = { "id", "model", "reasoning", "status", "incomplete_details", "output", "usage" };
        private readonly HttpClient http;

        internal Upstream(HttpMessageHandler handler)
        {
            http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        }

        internal static HttpClientHandler CreateHandler()
        {
            // TLS certificate and hostname checks use Windows trust. The service uses no proxy,
            // cookies, ambient authentication or redirect that could receive the bearer credential.
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            return new HttpClientHandler {
                AllowAutoRedirect = false, UseProxy = false, UseCookies = false, UseDefaultCredentials = false,
                AutomaticDecompression = DecompressionMethods.None, MaxResponseHeadersLength = 16
            };
        }

        internal async Task<byte[]> Request(Policy policy, byte[] body, byte[] key, CancellationToken cancellation)
        {
            string bearer = Encoding.ASCII.GetString(key);
            if (Protocol.Utf8.GetString(body).IndexOf(bearer, StringComparison.Ordinal) >= 0)
                return Protocol.Error("BROKER_POLICY_DENIED");
            bool started = false;
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
            using (var message = new HttpRequestMessage(HttpMethod.Post, Endpoint))
            {
                timeout.CancelAfter(Protocol.ApiTimeoutMs);
                try
                {
                    timeout.Token.ThrowIfCancellationRequested();
                    message.Content = new ByteArrayContent(body);
                    message.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
                    message.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                    message.Headers.ExpectContinue = false;
                    message.Headers.ConnectionClose = true;
                    message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
                    if (policy.Project != null) message.Headers.Add("OpenAI-Project", policy.Project);
                    if (policy.Organization != null) message.Headers.Add("OpenAI-Organization", policy.Organization);

                    started = true;
                    using (var response = await http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false))
                    using (timeout.Token.Register(response.Dispose))
                    {
                        string id = SafeId(response, bearer);
                        int status = (int)response.StatusCode;
                        if (status >= 300 && status <= 599) return Protocol.Error(status, "UPSTREAM_HTTP", id);
                        if (status != 200 || response.Content == null || response.Content.Headers.ContentLength > Protocol.MaxResponseBytes)
                            return Protocol.Error(502, "UPSTREAM_UNKNOWN", id);
                        using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                        {
                            byte[] data = await Protocol.ReadBounded(stream, Protocol.MaxResponseBytes, timeout.Token).ConfigureAwait(false);
                            var source = Protocol.Parse(data);
                            var result = new Dictionary<string, object>(StringComparer.Ordinal);
                            foreach (string name in ResponseFields)
                                if (source.ContainsKey(name)) result.Add(name, source[name]);
                            byte[] reply = Protocol.Success(result, id);
                            if (Protocol.Utf8.GetString(reply).IndexOf(bearer, StringComparison.Ordinal) >= 0)
                                return Protocol.Error("UPSTREAM_UNKNOWN");
                            return reply;
                        }
                    }
                }
                catch (Exception)
                {
                    // Once SendAsync starts, even a transport error may represent a request that was billed.
                    return Protocol.Error(started ? "UPSTREAM_UNKNOWN" : "UPSTREAM_UNSENT");
                }
            }
        }

        private static string SafeId(HttpResponseMessage response, string bearer)
        {
            IEnumerable<string> values;
            if (!response.Headers.TryGetValues("x-request-id", out values)) return null;
            string[] ids = values.Take(2).ToArray();
            return ids.Length == 1 && Protocol.RequestId.IsMatch(ids[0]) && ids[0].IndexOf(bearer, StringComparison.Ordinal) < 0 ? ids[0] : null;
        }

        public void Dispose() { http.Dispose(); }
    }
}
