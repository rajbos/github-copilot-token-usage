using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace CopilotTokenTracker.Data
{
    /// <summary>
    /// Discovers Visual Studio Copilot Chat session binary files on the local machine.
    ///
    /// Strategy (mirrors vscode-extension/src/visualstudio.ts):
    ///   1. Parse recent VS Copilot log files in %LOCALAPPDATA%\Temp\VSGitHubCopilotLogs\
    ///      for "Updating session file '...'" lines to find active paths quickly.
    ///   2. Walk the filesystem under %USERPROFILE% and common code roots, looking for
    ///      .vs\{solution}\copilot-chat\{hash}\sessions\ directories.
    /// </summary>
    internal static class SessionDiscovery
    {
        private static readonly HashSet<string> SkipDirNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "node_modules", ".git", ".github", "bin", "obj", "out", "dist", "build",
            "target", "packages", "vendor", "__pycache__", ".tox", ".venv", "venv",
            "env", "Windows", "Program Files", "Program Files (x86)", "ProgramData",
            "$Recycle.Bin", "System Volume Information", "Recovery",
        };

        private static readonly Regex LogLinePattern =
            new Regex(@"Updating session file '([^']+)'", RegexOptions.Compiled);

        // ── Public API ─────────────────────────────────────────────────────────

        /// <summary>Returns deduplicated paths of all discoverable VS session files.</summary>
        public static List<string> DiscoverSessions()
        {
            var seen    = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var results = new List<string>();

            DiscoverFromLogs(seen, results);
            DiscoverFromFilesystem(seen, results);

            return results;
        }

        // ── Log-based discovery ────────────────────────────────────────────────

        private static void DiscoverFromLogs(HashSet<string> seen, List<string> results)
        {
            var localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA")
                              ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                                              "AppData", "Local");

            var logDir = Path.Combine(localAppData, "Temp", "VSGitHubCopilotLogs");
            Utilities.OutputLogger.Log($"Checking log directory: {logDir}");

            if (!Directory.Exists(logDir))
            {
                Utilities.OutputLogger.LogWarning($"Log directory not found: {logDir}");
                return;
            }

            var logFiles = SafeEnumerateFiles(logDir, "*.chat.log").ToList();
            Utilities.OutputLogger.Log($"Found {logFiles.Count} log files");

            foreach (var logFile in logFiles)
            {
                try
                {
                    foreach (var line in File.ReadLines(logFile))
                    {
                        var m = LogLinePattern.Match(line);
                        if (!m.Success) { continue; }

                        var sessionPath = m.Groups[1].Value;
                        if (!seen.Add(sessionPath)) { continue; }
                        if (File.Exists(sessionPath))
                        {
                            results.Add(sessionPath);
                        }
                    }
                }
                catch { /* skip unreadable log files */ }
            }
        }

        // ── Filesystem walk ────────────────────────────────────────────────────

        private static void DiscoverFromFilesystem(HashSet<string> seen, List<string> results)
        {
            var home  = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var roots = new List<string> { home };

            Utilities.OutputLogger.Log($"Scanning filesystem starting from home: {home}");

            // Well-known code root conventions on Windows
            foreach (var drive in new[] { "C", "D" })
            {
                foreach (var folder in new[] { "repos", "code", "src", "projects", "dev" })
                {
                    var p = $"{drive}:\\{folder}";
                    if (Directory.Exists(p))
                    {
                        roots.Add(p);
                        Utilities.OutputLogger.Log($"Added scan root: {p}");
                    }
                }
            }

            foreach (var root in roots)
            {
                var maxDepth = root == home ? 7 : 5;
                ScanForVsDirs(root, 0, maxDepth, seen, results);
            }
        }

        private static void ScanForVsDirs(
            string dir, int depth, int maxDepth,
            HashSet<string> seen, List<string> results)
        {
            if (depth > maxDepth) { return; }

            foreach (var entry in SafeEnumerateDirectories(dir))
            {
                var name = Path.GetFileName(entry);

                if (SkipDirNames.Contains(name)) { continue; }
                if (name.StartsWith(".", StringComparison.Ordinal) && name != ".vs") { continue; }

                if (name == ".vs")
                {
                    FindSessionsUnderVsDir(entry, seen, results);
                }
                else
                {
                    ScanForVsDirs(entry, depth + 1, maxDepth, seen, results);
                }
            }
        }

        private static void FindSessionsUnderVsDir(
            string vsDir, HashSet<string> seen, List<string> results)
        {
            // .vs/{solution-name}/copilot-chat/{hash}/sessions/
            foreach (var solutionDir in SafeEnumerateDirectories(vsDir))
            {
                var copilotChatDir = Path.Combine(solutionDir, "copilot-chat");
                if (!Directory.Exists(copilotChatDir)) { continue; }

                foreach (var hashDir in SafeEnumerateDirectories(copilotChatDir))
                {
                    var sessionsDir = Path.Combine(hashDir, "sessions");
                    if (!Directory.Exists(sessionsDir)) { continue; }

                    foreach (var sessionFile in SafeEnumerateFiles(sessionsDir))
                    {
                        if (!seen.Add(sessionFile)) { continue; }
                        results.Add(sessionFile);
                    }
                }
            }
        }

        // ── Helpers ────────────────────────────────────────────────────────────

        private static IEnumerable<string> SafeEnumerateDirectories(string path)
        {
            try   { return Directory.EnumerateDirectories(path); }
            catch { return Array.Empty<string>(); }
        }

        private static IEnumerable<string> SafeEnumerateFiles(string path, string pattern = "*")
        {
            try   { return Directory.EnumerateFiles(path, pattern); }
            catch { return Array.Empty<string>(); }
        }
    }
}
