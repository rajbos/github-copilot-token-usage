using System;
using System.Collections.Generic;

namespace CopilotTokenTracker.Data
{
    /// <summary>
    /// Estimates token counts from plain text using character-to-token ratios.
    ///
    /// Different model families tokenise text at different densities.
    /// Unknown models fall back to the industry-standard 4 chars ≈ 1 token.
    ///
    /// Mirrors the logic in vscode-extension/src/tokenEstimation.ts.
    /// </summary>
    internal static class TokenEstimator
    {
        // Approximate characters-per-token by model family (ascending priority order).
        // Substring-matched case-insensitively against the full model id.
        private static readonly (string Key, double Ratio)[] Ratios =
        {
            ("gpt-3.5",  3.8),
            ("gpt-4o",   4.0),
            ("gpt-4",    3.8),
            ("o1",       4.0),
            ("o3",       4.0),
            ("claude-3-7", 3.6),
            ("claude-3-5", 3.6),
            ("claude-3",   3.6),
            ("claude",     3.5),
            ("gemini",     4.2),
        };

        private const double DefaultRatio = 4.0;

        /// <summary>
        /// Returns the estimated token count for <paramref name="text"/>
        /// with the named <paramref name="modelId"/> (may be null or empty).
        /// </summary>
        public static long Estimate(string text, string? modelId = null)
        {
            if (string.IsNullOrEmpty(text)) { return 0L; }

            var ratio = GetRatio(modelId);
            return (long)Math.Ceiling(text.Length / ratio);
        }

        // ── Helpers ────────────────────────────────────────────────────────────

        private static double GetRatio(string? modelId)
        {
            if (string.IsNullOrEmpty(modelId)) { return DefaultRatio; }

            foreach (var (key, ratio) in Ratios)
            {
                if (modelId!.IndexOf(key, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return ratio;
                }
            }

            return DefaultRatio;
        }
    }
}
