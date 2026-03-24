using System;
using System.Buffers;
using System.Collections.Generic;
using System.IO;
using System.Text;
using MessagePack;

namespace CopilotTokenTracker.Data
{
    /// <summary>
    /// Parses Visual Studio Copilot Chat session binary files (MessagePack stream format).
    ///
    /// File layout (mirrors vscode-extension/src/visualstudio.ts):
    ///   Byte 0   : version (0x01) — skip
    ///   Byte 1…  : stream of MessagePack objects
    ///
    ///   Object 0  : header   → { TimeCreated: string, TimeUpdated: string, ConversationMode: string }
    ///   Object 1  : request  → [ version, { Content: […], Model: { ModelId: string } } ]
    ///   Object 2  : response → [ version, { Content: […], Model: [version, { Id: string }] } ]
    ///   Object 3  : request  → …  (odd = request, even ≥2 = response)
    ///
    /// Content items are:   [ typeTag, { Content: string } ]
    /// </summary>
    internal static class SessionParser
    {
        // ── Public API ─────────────────────────────────────────────────────────

        /// <summary>
        /// Reads the MessagePack stream from <paramref name="filePath"/> and returns
        /// all decoded objects.  Returns an empty list on any read or decode error.
        /// </summary>
        public static List<object?> DecodeSessionFile(string filePath)
        {
            try
            {
                var bytes = File.ReadAllBytes(filePath);
                if (bytes.Length < 2) { return new List<object?>(); }

                // Skip the single version-prefix byte
                var mem    = new ReadOnlyMemory<byte>(bytes, 1, bytes.Length - 1);
                var reader = new MessagePackReader(mem);
                var result = new List<object?>();

                while (!reader.End)
                {
                    result.Add(ReadValue(ref reader));
                }

                return result;
            }
            catch
            {
                return new List<object?>();
            }
        }

        /// <summary>Returns the number of user interaction turns (odd-indexed objects).</summary>
        public static int CountInteractions(List<object?> objects)
        {
            var count = 0;
            for (var i = 1; i < objects.Count; i++)
            {
                if (i % 2 == 1) { count++; }
            }
            return count;
        }

        /// <summary>
        /// Extracts ISO-8601 TimeCreated / TimeUpdated strings from the session header.
        /// </summary>
        public static (string? Created, string? Updated) GetTimestamps(List<object?> objects)
        {
            if (objects.Count == 0) { return (null, null); }

            if (objects[0] is not Dictionary<string, object?> header)
            {
                return (null, null);
            }

            return (
                header.TryGetValue("TimeCreated", out var c) ? c as string : null,
                header.TryGetValue("TimeUpdated", out var u) ? u as string : null
            );
        }

        /// <summary>
        /// Returns the model identifier for the given message's inner data dictionary.
        /// Requests store it at <c>Model.ModelId</c>; responses store it at <c>Model[1].Id</c>.
        /// </summary>
        public static string? GetModelId(Dictionary<string, object?> msgData, bool isRequest)
        {
            if (isRequest)
            {
                if (msgData.TryGetValue("Model", out var modelObj)
                    && modelObj is Dictionary<string, object?> model
                    && model.TryGetValue("ModelId", out var idObj))
                {
                    return idObj as string;
                }
            }
            else
            {
                // Response: Model is [version, { Id, Name, … }]
                if (msgData.TryGetValue("Model", out var modelObj)
                    && modelObj is object?[] modelArr
                    && modelArr.Length >= 2
                    && modelArr[1] is Dictionary<string, object?> modelInfo
                    && modelInfo.TryGetValue("Id", out var idObj))
                {
                    return idObj as string;
                }
            }

            return null;
        }

        /// <summary>
        /// Concatenates all text segments from a VS Copilot Content array.
        /// Content arrays have the shape: [ [typeTag, { Content: string }], … ]
        /// </summary>
        public static string ExtractText(object? contentObj)
        {
            if (contentObj is not object?[] arr) { return string.Empty; }

            var sb = new StringBuilder();

            foreach (var c in arr)
            {
                Dictionary<string, object?>? inner = null;

                if (c is object?[] tuple && tuple.Length >= 2)
                {
                    inner = tuple[1] as Dictionary<string, object?>;
                }

                if (inner == null) { continue; }

                if (inner.TryGetValue("Content", out var textObj) && textObj is string text && text.Length > 0)
                {
                    if (sb.Length > 0) { sb.Append('\n'); }
                    sb.Append(text);
                }
            }

            return sb.ToString();
        }

        /// <summary>
        /// Gets the inner data dictionary [ version, dict ] → dict for a message object.
        /// Returns null if the structure doesn't match.
        /// </summary>
        public static Dictionary<string, object?>? GetMessageData(object? msgObj)
        {
            if (msgObj is object?[] arr && arr.Length >= 2)
            {
                return arr[1] as Dictionary<string, object?>;
            }

            return null;
        }

        // ── Low-level MessagePack reader ───────────────────────────────────────

        /// <summary>
        /// Decodes a MessagePack Timestamp extension (type code -1) into an ISO-8601 string.
        /// Handles all three timestamp formats: 32-bit, 64-bit, and 96-bit.
        /// </summary>
        private static string? DecodeTimestamp(ReadOnlySequence<byte> data)
        {
            try
            {
                long seconds;
                uint nanoseconds;
                var bytes = data.ToArray();

                switch (bytes.Length)
                {
                    case 4: // Timestamp32: seconds in uint32
                        seconds = ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16)
                                | ((uint)bytes[2] << 8) | bytes[3];
                        nanoseconds = 0;
                        break;

                    case 8: // Timestamp64: upper 30 bits = nanoseconds, lower 34 bits = seconds
                        ulong val = 0;
                        for (int i = 0; i < 8; i++)
                            val = (val << 8) | bytes[i];
                        nanoseconds = (uint)(val >> 34);
                        seconds = (long)(val & 0x3FFFFFFFFUL);
                        break;

                    case 12: // Timestamp96: 4 bytes nanoseconds + 8 bytes signed seconds
                        nanoseconds = ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16)
                                    | ((uint)bytes[2] << 8) | bytes[3];
                        seconds = 0;
                        for (int i = 4; i < 12; i++)
                            seconds = (seconds << 8) | bytes[i];
                        break;

                    default:
                        return null;
                }

                var dt = DateTimeOffset.FromUnixTimeSeconds(seconds)
                                       .AddTicks(nanoseconds / 100)
                                       .UtcDateTime;
                return dt.ToString("o");
            }
            catch
            {
                return null;
            }
        }

        private static object? ReadValue(ref MessagePackReader reader)
        {
            switch (reader.NextMessagePackType)
            {
                case MessagePackType.Map:
                {
                    var count = reader.ReadMapHeader();
                    var dict  = new Dictionary<string, object?>(count);

                    for (var i = 0; i < count; i++)
                    {
                        var key = ReadValue(ref reader)?.ToString() ?? string.Empty;
                        var val = ReadValue(ref reader);
                        dict[key] = val;
                    }

                    return dict;
                }

                case MessagePackType.Array:
                {
                    var count = reader.ReadArrayHeader();
                    var arr   = new object?[count];

                    for (var i = 0; i < count; i++)
                    {
                        arr[i] = ReadValue(ref reader);
                    }

                    return arr;
                }

                case MessagePackType.String:
                    return reader.ReadString();

                case MessagePackType.Integer:
                    return reader.ReadInt64();

                case MessagePackType.Float:
                    return reader.ReadDouble();

                case MessagePackType.Boolean:
                    return reader.ReadBoolean();

                case MessagePackType.Nil:
                    reader.ReadNil();
                    return null;

                case MessagePackType.Binary:
                    reader.ReadBytes(); // consume and discard — not used in session analysis
                    return null;

                case MessagePackType.Extension:
                    var ext = reader.ReadExtensionFormat();
                    if (ext.TypeCode == -1) // MessagePack Timestamp
                    {
                        return DecodeTimestamp(ext.Data);
                    }
                    return null;

                default:
                    reader.Skip();
                    return null;
            }
        }
    }
}
