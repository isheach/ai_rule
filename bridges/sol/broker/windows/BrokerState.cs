using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;

namespace AiRule.Sol.Windows
{
    internal sealed class BrokerState
    {
        private const long AuditLimit = 256 * 1024;
        private static readonly byte[] Entropy = Protocol.Utf8.GetBytes("ai_rule.sol_broker.credential.v1");
        private readonly string directory;
        private readonly object gate = new object();

        internal BrokerState(string directory) { this.directory = directory; }

        internal static void ProbeProfile()
        {
            // SCM loads the virtual account's profile. A real loaded hive and a user-scope
            // round trip are prerequisites for accepting enrollment or billable requests.
            using (var hive = Registry.Users.OpenSubKey(WindowsPipe.ServiceSid.Value))
                if (hive == null) throw new InvalidOperationException();
            var challenge = new byte[32];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(challenge);
            byte[] recovered = Unprotect(Protect(challenge));
            if (!challenge.SequenceEqual(recovered)) throw new CryptographicException();
        }

        internal static byte[] Protect(byte[] value)
        {
            return ProtectedData.Protect(value, Entropy, DataProtectionScope.CurrentUser);
        }

        internal static byte[] Unprotect(byte[] value)
        {
            return ProtectedData.Unprotect(value, Entropy, DataProtectionScope.CurrentUser);
        }

        internal byte[] Key()
        {
            lock (gate)
            {
                byte[] protectedKey = ReadOptional("credential.dpapi", 4096);
                if (protectedKey == null) return null;
                byte[] key = Unprotect(protectedKey);
                if (Protocol.ValidKey(key)) return key;
                Array.Clear(key, 0, key.Length);
                throw new CryptographicException();
            }
        }

        internal void SetKey(byte[] key)
        {
            if (!Protocol.ValidKey(key)) throw new InvalidDataException();
            lock (gate) AtomicWrite("credential.dpapi", Protect(key));
        }

        internal bool Reserve(DateTime utc)
        {
            lock (gate)
            {
                byte[] previous = ReadOptional("rate.bin", Protocol.CallsPerHour * sizeof(long)) ?? new byte[0];
                if (previous.Length % sizeof(long) != 0) throw new InvalidDataException();
                long last = 0;
                long cutoff = utc.Subtract(TimeSpan.FromHours(1)).Ticks;
                var times = new List<long>();
                for (int offset = 0; offset < previous.Length; offset += sizeof(long))
                {
                    long stamp = BitConverter.ToInt64(previous, offset);
                    if (stamp < last || stamp <= 0 || stamp > DateTime.MaxValue.Ticks) throw new InvalidDataException();
                    if (stamp > cutoff) times.Add(stamp);
                    last = stamp;
                }
                if (times.Count >= Protocol.CallsPerHour) return false;
                times.Add(Math.Max(last, utc.Ticks));
                AtomicWrite("rate.bin", times.SelectMany(BitConverter.GetBytes).ToArray());
                return true;
            }
        }

        internal void Audit(string operation, string outcome, int status = 0)
        {
            lock (gate)
            {
                string filename = Path.Combine(directory, "audit.jsonl");
                string previous = Path.Combine(directory, "audit.previous.jsonl");
                var info = new FileInfo(filename);
                if (info.Exists && info.Length >= AuditLimit)
                {
                    File.Delete(previous);
                    File.Move(filename, previous);
                }
                var entry = new { time = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture), operation = operation,
                    outcome = outcome, status = status };
                byte[] line = Protocol.Encode(entry);
                using (var stream = new FileStream(filename, FileMode.Append, FileAccess.Write, FileShare.Read))
                {
                    stream.Write(line, 0, line.Length);
                    stream.WriteByte(10);
                    stream.Flush(true);
                }
            }
        }

        internal void TryAudit(string operation, string outcome, int status = 0)
        {
            try { Audit(operation, outcome, status); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        private byte[] ReadOptional(string name, int limit)
        {
            try { return ReadKnown(Path.Combine(directory, name), limit); }
            catch (FileNotFoundException) { return null; }
        }

        internal static byte[] ReadKnown(string filename, int limit)
        {
            if ((File.GetAttributes(filename) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
            using (var stream = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                return Protocol.ReadBounded(stream, limit, System.Threading.CancellationToken.None).GetAwaiter().GetResult();
            }
        }

        private void AtomicWrite(string name, byte[] bytes)
        {
            string filename = Path.Combine(directory, name);
            string temporary = Path.Combine(directory, name + ".new");
            File.Delete(temporary); // Left by an interrupted update. It contains protected bytes only.
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                if (File.Exists(filename)) File.Replace(temporary, filename, null);
                else File.Move(temporary, filename);
            }
            finally { File.Delete(temporary); }
        }
    }
}
