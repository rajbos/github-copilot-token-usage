using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;

namespace CopilotTokenTracker.Data
{
    /// <summary>
    /// Bridges to the bundled CLI executable (<c>copilot-token-tracker.exe</c>) to
    /// retrieve token usage stats.  This avoids duplicating session discovery, parsing,
    /// and aggregation logic that already lives in the shared TypeScript codebase.
    ///
    /// The CLI exe is a Node.js SEA (Single Executable Application) built from
    /// <c>cli/</c> and copied into <c>cli-bundle/</c> at build time.
    /// </summary>
    internal static class CliBridge
    {
        private const string ExeName          = "copilot-token-tracker.exe";
        private const int    TimeoutMs        = 60_000;  // 60 s after the cache is warm
        private const int    InitialTimeoutMs = 180_000; // 3 min — first run scans all sessions

        /// <summary>
        /// Set to <c>true</c> after the CLI has returned valid data at least once.
        /// Subsequent calls use the shorter <see cref="TimeoutMs"/> because the CLI
        /// reads its own on-disk cache instead of re-scanning all sessions.
        /// </summary>
        private static volatile bool _hasSucceededOnce = false;

        /// <summary>Last successfully fetched stats, used to serve cached data immediately.</summary>
        private static volatile DetailedStats? _cachedStats;
        private static DateTime _cachedStatsAt = DateTime.MinValue;
        private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

        /// <summary>
        /// In-flight Task for <c>usage --json</c>. When a second caller arrives while
        /// this is non-null, it receives the same Task instead of spawning a second process.
        /// Cleared back to <c>null</c> once the Task completes.
        /// </summary>
        private static Task<DetailedStats?>? _inflightUsageTask;
        private static readonly object _usageLock = new object();

        // ── Public API ─────────────────────────────────────────────────────────

        /// <summary>
        /// Returns the most recently fetched stats from the in-memory cache, or
        /// <c>null</c> if no successful fetch has completed yet.
        /// </summary>
        public static DetailedStats? GetCachedStats() => _cachedStats;

        /// <summary>
        /// Runs the CLI <c>usage --json</c> command and deserializes the result
        /// into a <see cref="DetailedStats"/> instance.
        /// If a call is already in progress, returns the same Task (no duplicate process).
        /// If cached data is still within <see cref="CacheTtl"/>, returns it immediately
        /// without re-running the CLI.
        /// Returns <c>null</c> when the CLI exe is missing or the command fails.
        /// </summary>
        public static Task<DetailedStats?> GetUsageStatsAsync()
        {
            lock (_usageLock)
            {
                // Return fresh cached data without launching the CLI again
                if (_cachedStats != null && (DateTime.UtcNow - _cachedStatsAt) < CacheTtl)
                {
                    Utilities.OutputLogger.Log("CLI bridge: returning in-memory cached stats");
                    return System.Threading.Tasks.Task.FromResult<DetailedStats?>(_cachedStats);
                }

                if (_inflightUsageTask != null)
                {
                    Utilities.OutputLogger.Log("CLI bridge: usage --json already in flight, reusing existing call");
                    return _inflightUsageTask;
                }

                _inflightUsageTask = RunGetUsageStatsAsync();
                _ = _inflightUsageTask.ContinueWith(_ =>
                {
                    lock (_usageLock) { _inflightUsageTask = null; }
                }, System.Threading.Tasks.TaskContinuationOptions.ExecuteSynchronously);

                return _inflightUsageTask;
            }
        }

        private static async Task<DetailedStats?> RunGetUsageStatsAsync()
        {
            var exePath = FindCliExe();
            if (exePath == null)
            {
                Utilities.OutputLogger.LogWarning("CLI bridge: bundled exe not found — falling back to built-in parser");
                return null;
            }

            var timeoutMs = _hasSucceededOnce ? TimeoutMs : InitialTimeoutMs;
            Utilities.OutputLogger.Log($"CLI bridge: running {exePath} usage --json (timeout {timeoutMs / 1000}s)");

            var (exitCode, stdout, stderr) = await RunProcessAsync(exePath, "usage --json", timeoutMs);

            if (exitCode != 0)
            {
                Utilities.OutputLogger.LogWarning($"CLI bridge: exit code {exitCode}");
                if (!string.IsNullOrWhiteSpace(stderr))
                {
                    Utilities.OutputLogger.LogWarning($"CLI bridge stderr: {stderr}");
                }
                return null;
            }

            if (string.IsNullOrWhiteSpace(stdout))
            {
                Utilities.OutputLogger.LogWarning("CLI bridge: empty stdout");
                return null;
            }

            try
            {
                var options = new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true,
                };
                var result = JsonSerializer.Deserialize<DetailedStats>(stdout, options);
                if (result != null)
                {
                    _hasSucceededOnce = true;
                    _cachedStats      = result;
                    _cachedStatsAt    = DateTime.UtcNow;
                    Utilities.OutputLogger.Log("CLI bridge: stats deserialized successfully");
                }
                return result;
            }
            catch (JsonException ex)
            {
                Utilities.OutputLogger.LogError("CLI bridge: JSON parse error", ex);
                return null;
            }
        }

        /// <summary>
        /// Runs the CLI <c>chart --json</c> command and returns the raw JSON string.
        /// Returns <c>null</c> when the CLI exe is missing or the command fails.
        /// </summary>
        public static async Task<string?> GetChartDataJsonAsync()
        {
            var exePath = FindCliExe();
            if (exePath == null)
            {
                Utilities.OutputLogger.LogWarning("CLI bridge: bundled exe not found for chart");
                return null;
            }

            var timeoutMs = _hasSucceededOnce ? TimeoutMs : InitialTimeoutMs;
            Utilities.OutputLogger.Log($"CLI bridge: running {exePath} chart --json");

            var (exitCode, stdout, stderr) = await RunProcessAsync(exePath, "chart --json", timeoutMs);

            if (exitCode != 0)
            {
                Utilities.OutputLogger.LogWarning($"CLI bridge (chart): exit code {exitCode}");
                if (!string.IsNullOrWhiteSpace(stderr))
                    Utilities.OutputLogger.LogWarning($"CLI bridge (chart) stderr: {stderr}");
                return null;
            }

            if (string.IsNullOrWhiteSpace(stdout))
            {
                Utilities.OutputLogger.LogWarning("CLI bridge (chart): empty stdout");
                return null;
            }

            Utilities.OutputLogger.Log("CLI bridge: chart data received");
            return stdout.Trim();
        }

        /// <summary>
        /// Runs the CLI <c>usage-analysis --json</c> command and returns the raw JSON string.
        /// Returns <c>null</c> when the CLI exe is missing or the command fails.
        /// </summary>
        public static async Task<string?> GetUsageAnalysisJsonAsync()
        {
            var exePath = FindCliExe();
            if (exePath == null)
            {
                Utilities.OutputLogger.LogWarning("CLI bridge: bundled exe not found for usage-analysis");
                return null;
            }

            var timeoutMs = _hasSucceededOnce ? TimeoutMs : InitialTimeoutMs;
            Utilities.OutputLogger.Log($"CLI bridge: running {exePath} usage-analysis --json");

            var (exitCode, stdout, stderr) = await RunProcessAsync(exePath, "usage-analysis --json", timeoutMs);

            if (exitCode != 0)
            {
                Utilities.OutputLogger.LogWarning($"CLI bridge (usage-analysis): exit code {exitCode}");
                if (!string.IsNullOrWhiteSpace(stderr))
                    Utilities.OutputLogger.LogWarning($"CLI bridge (usage-analysis) stderr: {stderr}");
                return null;
            }

            if (string.IsNullOrWhiteSpace(stdout))
            {
                Utilities.OutputLogger.LogWarning("CLI bridge (usage-analysis): empty stdout");
                return null;
            }

            Utilities.OutputLogger.Log("CLI bridge: usage-analysis data received");
            return stdout.Trim();
        }

        /// <summary>
        /// Runs the CLI <c>fluency --json</c> command and deserializes the result
        /// into a <see cref="MaturityData"/> instance.
        /// Returns <c>null</c> when the CLI exe is missing or the command fails.
        /// </summary>
        public static async Task<MaturityData?> GetMaturityAsync()
        {
            var exePath = FindCliExe();
            if (exePath == null)
            {
                Utilities.OutputLogger.LogWarning("CLI bridge: bundled exe not found for fluency");
                return null;
            }

            Utilities.OutputLogger.Log($"CLI bridge: running {exePath} fluency --json");

            var (exitCode, stdout, stderr) = await RunProcessAsync(exePath, "fluency --json");

            if (exitCode != 0)
            {
                Utilities.OutputLogger.LogWarning($"CLI bridge (fluency): exit code {exitCode}");
                if (!string.IsNullOrWhiteSpace(stderr))
                {
                    Utilities.OutputLogger.LogWarning($"CLI bridge (fluency) stderr: {stderr}");
                }
                return null;
            }

            if (string.IsNullOrWhiteSpace(stdout))
            {
                Utilities.OutputLogger.LogWarning("CLI bridge (fluency): empty stdout");
                return null;
            }

            try
            {
                var options = new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true,
                };
                var result = JsonSerializer.Deserialize<MaturityData>(stdout, options);
                if (result != null)
                {
                    Utilities.OutputLogger.Log("CLI bridge: maturity data deserialized successfully");
                }
                return result;
            }
            catch (JsonException ex)
            {
                Utilities.OutputLogger.LogError("CLI bridge (fluency): JSON parse error", ex);
                return null;
            }
        }

        /// <summary>Returns <c>true</c> when the bundled CLI exe is available.</summary>
        public static bool IsAvailable() => FindCliExe() != null;

        // ── Internals ──────────────────────────────────────────────────────────

        /// <summary>
        /// Looks for the CLI exe next to this assembly (inside the VSIX install folder)
        /// under the <c>cli-bundle/</c> subfolder.
        /// </summary>
        private static string? FindCliExe()
        {
            var asmDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (asmDir == null) { return null; }

            var candidate = Path.Combine(asmDir, "cli-bundle", ExeName);
            return File.Exists(candidate) ? candidate : null;
        }

        /// <summary>
        /// Starts a process, captures stdout and stderr, and waits up to <see cref="TimeoutMs"/>.
        /// Uses event-based output reading to avoid the classic ReadToEnd/WaitForExit deadlock.
        /// </summary>
        private static Task<(int ExitCode, string Stdout, string Stderr)> RunProcessAsync(
            string fileName, string arguments, int timeoutMs = TimeoutMs)
        {
            return Task.Run(() =>
            {
                var stdoutBuilder = new System.Text.StringBuilder();
                var stderrBuilder = new System.Text.StringBuilder();

                using var proc = new Process();
                proc.StartInfo = new ProcessStartInfo
                {
                    FileName               = fileName,
                    Arguments              = arguments,
                    UseShellExecute        = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError  = true,
                    CreateNoWindow         = true,
                    StandardOutputEncoding = System.Text.Encoding.UTF8,
                    StandardErrorEncoding  = System.Text.Encoding.UTF8,
                };

                proc.OutputDataReceived += (_, e) => { if (e.Data != null) stdoutBuilder.AppendLine(e.Data); };
                proc.ErrorDataReceived  += (_, e) => { if (e.Data != null) stderrBuilder.AppendLine(e.Data); };

                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();

                if (!proc.WaitForExit(timeoutMs))
                {
                    try { proc.Kill(); } catch { /* best effort */ }
                    Utilities.OutputLogger.LogWarning($"CLI bridge: process killed after {timeoutMs / 1000}s timeout");
                    return (-1, string.Empty, "Process timed out");
                }

                return (proc.ExitCode, stdoutBuilder.ToString(), stderrBuilder.ToString());
            });
        }
    }
}
