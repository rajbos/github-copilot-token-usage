# Test Data for Copilot Token Tracker Extension

This directory contains sample GitHub Copilot session files used for testing the extension's UI and screenshot generation.

## Directory Structure

```
test-data/
└── chatSessions/
    ├── sample-session-1.json    # React/TypeScript session (gpt-4o)
    ├── sample-session-2.json    # Python development session (mixed models)
    └── sample-session-3.json    # SQL schema design session (o1)
```

## Sample Sessions Overview

### sample-session-1.json
- **Mode**: `ask` (regular chat)
- **Model**: GPT-4o (2024-11-20)
- **Interactions**: 2
- **Topic**: React component development with TypeScript
- **Date**: January 19, 2024

### sample-session-2.json
- **Mode**: `edit` (code editing)
- **Model**: Mixed (Claude 3.5 Sonnet, GPT-4o)
- **Interactions**: 3
- **Topic**: Python Fibonacci function with tests
- **Date**: January 20, 2024

### sample-session-3.json
- **Mode**: `agent` (autonomous agent)
- **Model**: o1 (2024-12-17)
- **Interactions**: 1
- **Topic**: SQL schema design for blog system
- **Date**: January 21, 2024

## Using Test Data

### For Manual Testing

Set the environment variable to point to this test data directory:

```bash
# Windows PowerShell
$env:COPILOT_TEST_DATA_PATH = "C:\path\to\repo\test-data\chatSessions"

# Linux/macOS
export COPILOT_TEST_DATA_PATH="/path/to/repo/test-data/chatSessions"
```

Then launch VS Code with the extension in debug mode (F5).

### For Screenshot Generation

The screenshot automation script automatically uses this test data when invoked. See `.github/skills/screenshot-ui-views/` for details.

## Adding More Test Data

To add additional test session files:

1. **Create a new JSON file** following the schema in `docs/logFilesSchema/session-file-schema.json`
2. **Use a unique sessionId** (e.g., `test-session-004`)
3. **Set realistic timestamps** (use current epoch milliseconds)
4. **Include diverse content** to test different scenarios:
   - Different models (gpt-4o, claude-3.5-sonnet, o1, etc.)
   - Different modes (ask, edit, agent)
   - Various message lengths (for token estimation testing)
   - Multiple interactions per session

### Minimal Session Template

```json
{
  "version": 3,
  "sessionId": "test-session-XXX",
  "responderUsername": "GitHub Copilot",
  "responderAvatarIconUri": { "id": "copilot" },
  "creationDate": 1705651200000,
  "lastMessageDate": 1705654800000,
  "mode": "ask",
  "requests": [
    {
      "requestId": "req-XXX",
      "message": {
        "text": "Your prompt here",
        "parts": [
          {
            "text": "Your prompt here",
            "kind": "text"
          }
        ]
      },
      "response": [
        {
          "value": "AI response text here",
          "kind": "markdownContent"
        }
      ],
      "result": {
        "metadata": {
          "model": "gpt-4o-2024-11-20"
        }
      }
    }
  ]
}
```

## Notes

- These files are **synthetic test data** and do not contain real user conversations
- Token counts are estimated based on character count (see `src/tokenEstimators.json`)
- The extension caches processed session files based on modification time
- File modification timestamps matter for cache testing

## Related Documentation

- Session file schema: `docs/logFilesSchema/session-file-schema.json`
- Extension source: `src/extension.ts`
- Token estimation logic: `src/extension.ts` (lines 1047-1121)
