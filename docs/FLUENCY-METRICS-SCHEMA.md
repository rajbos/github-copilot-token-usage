---
title: Fluency Metrics in Cloud Storage
description: Schema documentation for fluency metrics stored in Azure Tables
lastUpdated: 2026-02-25
status: implemented
---

# Fluency Metrics in Cloud Storage

## Overview

As of schema version 4, the extension uploads comprehensive fluency metrics to Azure Table Storage, enabling team-level dashboards to display Copilot Fluency Scores and adoption analytics.

## Schema Version

- **Version**: 4 (`SCHEMA_VERSION_WITH_FLUENCY_METRICS`)
- **Location**: `src/backend/constants.ts`
- **Backward Compatibility**: Fully compatible with versions 1-3 (entities without fluency metrics)

## Entity Structure

### Base Fields (All Versions)

Standard fields present in all schema versions:

```typescript
{
  partitionKey: string;      // "ds:{datasetId}|d:{YYYY-MM-DD}"
  rowKey: string;            // "m:{model}|w:{workspaceId}|mc:{machineId}|u:{userId}"
  schemaVersion: number;     // 1, 2, 3, or 4
  datasetId: string;
  day: string;               // YYYY-MM-DD
  model: string;
  workspaceId: string;
  workspaceName?: string;
  machineId: string;
  machineName?: string;
  userId?: string;
  userKeyType?: string;
  shareWithTeam?: boolean;
  consentAt?: string;
  inputTokens: number;
  outputTokens: number;
  interactions: number;
  updatedAt: string;         // ISO timestamp
}
```

### Fluency Metrics (Schema Version 4+)

Additional fields for fluency score calculation:

#### Mode Usage Counts

```typescript
{
  askModeCount: number;          // Ask-mode interactions
  editModeCount: number;         // Edit-mode interactions (inline code edits)
  agentModeCount: number;        // Agent-mode interactions (autonomous coding)
  planModeCount: number;         // Plan-mode interactions
  customAgentModeCount: number;  // Custom agent interactions
}
```

#### Serialized Complex Objects

JSON-serialized objects for detailed breakdowns:

```typescript
{
  toolCallsJson: string;        // JSON: { total: number, byTool: { [name]: count } }
  contextRefsJson: string;      // JSON: { file: n, selection: n, workspace: n, ... }
  mcpToolsJson: string;         // JSON: { total: n, byServer: {}, byTool: {} }
  modelSwitchingJson: string;   // JSON: { mixedTierSessions: n, switchingFrequency: n, ... }
}
```

#### Conversation & Edit Patterns

```typescript
{
  multiTurnSessions: number;    // Count of multi-turn sessions
  avgTurnsPerSession: number;   // Average turns per session
  multiFileEdits: number;       // Count of multi-file edit operations
  avgFilesPerEdit: number;      // Average files edited per session
  codeBlockApplyRate: number;   // Code block apply rate (0-1)
  sessionCount: number;         // Number of sessions in this rollup
}
```

## JSON Field Schemas

### toolCallsJson

```json
{
  "total": 15,
  "byTool": {
    "explain": 5,
    "fix": 3,
    "tests": 4,
    "doc": 2,
    "generate": 1
  }
}
```

### contextRefsJson

```json
{
  "file": 8,
  "selection": 12,
  "symbol": 3,
  "codebase": 2,
  "workspace": 5,
  "terminal": 1,
  "vscode": 0,
  "terminalLastCommand": 2,
  "terminalSelection": 1,
  "clipboard": 0,
  "changes": 3,
  "outputPanel": 0,
  "problemsPanel": 1,
  "byKind": {
    "copilot.file": 8,
    "copilot.selection": 12
  },
  "copilotInstructions": 2,
  "agentsMd": 0,
  "byPath": {}
}
```

### mcpToolsJson

```json
{
  "total": 3,
  "byServer": {
    "github-server": 2,
    "custom-server": 1
  },
  "byTool": {
    "search-repos": 1,
    "create-issue": 1,
    "custom-action": 1
  }
}
```

### modelSwitchingJson

```json
{
  "uniqueModels": ["gpt-4o", "claude-sonnet-3.5"],
  "modelCount": 2,
  "switchCount": 3,
  "tiers": {
    "standard": ["gpt-4o"],
    "premium": ["claude-sonnet-3.5"],
    "unknown": []
  },
  "hasMixedTiers": true,
  "standardRequests": 5,
  "premiumRequests": 3,
  "unknownRequests": 0,
  "totalRequests": 8
}
```

## Aggregation Logic

### Merging Rollups

When multiple sessions contribute to the same rollup key (same day+model+workspace+machine+user), metrics are aggregated as follows:

#### Numeric Counts (Addition)
- `askModeCount`, `editModeCount`, `agentModeCount`, etc. are summed
- `multiTurnSessions`, `multiFileEdits`, `sessionCount` are summed

#### JSON Objects (Deep Merge)
- Numeric values within JSON objects are added
- Example: `{ total: 5, byTool: { fix: 2 } }` + `{ total: 3, byTool: { fix: 1, tests: 2 } }` = `{ total: 8, byTool: { fix: 3, tests: 2 } }`

#### Averages (Recalculated)
- `avgTurnsPerSession` and `avgFilesPerEdit` are stored as-is per session
- Team dashboards should recalculate weighted averages from `sessionCount` totals

### Implementation

Aggregation is handled in `src/backend/rollups.ts`:
- `upsertDailyRollup()` - Main aggregation function
- `mergeJsonMetrics()` - Deep merge for JSON-serialized objects

## Data Source

Fluency metrics are extracted from the `usageAnalysis` field in cached session data:

**Source**: `SessionFileCache.usageAnalysis` (computed by `calculateUsageAnalysisStats()`)

**Location**: `src/backend/services/syncService.ts::extractFluencyMetricsFromCache()`

## Usage in Team Dashboard

To display team-level fluency scores:

1. **Fetch Entities**: Query Azure Tables for the relevant date range and dataset
2. **Deserialize JSON**: Parse `toolCallsJson`, `contextRefsJson`, etc.
3. **Aggregate by User**: Group entities by `userId` and sum/merge metrics
4. **Calculate Scores**: Apply fluency scoring rules from `docs/FLUENCY-LEVELS.md`
5. **Display**: Show team aggregate and per-user comparisons

## Migration & Compatibility

### From Earlier Versions

- **Version 1-3 entities**: Will not have fluency metrics fields (all undefined)
- **Version 4 entities**: Will have fluency metrics if available from session data
- **Mixed environments**: Team dashboards should handle missing fluency metrics gracefully

### Future Extensions

To add new metrics:
1. Extend `BackendAggDailyEntityLike` interface in `src/backend/storageTables.ts`
2. Update `extractFluencyMetricsFromCache()` in sync service
3. Update `upsertDailyRollup()` merge logic if needed
4. Consider bumping schema version if breaking changes

## Example Entity

```json
{
  "partitionKey": "ds:my-team|d:2026-02-25",
  "rowKey": "m:gpt-4o|w:abc123|mc:machine456|u:alice",
  "schemaVersion": 4,
  "datasetId": "my-team",
  "day": "2026-02-25",
  "model": "gpt-4o",
  "workspaceId": "abc123",
  "workspaceName": "my-project",
  "machineId": "machine456",
  "machineName": "laptop",
  "userId": "alice",
  "userKeyType": "teamAlias",
  "shareWithTeam": true,
  "consentAt": "2026-02-20T10:00:00Z",
  "inputTokens": 5000,
  "outputTokens": 3000,
  "interactions": 15,
  "askModeCount": 10,
  "editModeCount": 2,
  "agentModeCount": 3,
  "planModeCount": 0,
  "customAgentModeCount": 0,
  "toolCallsJson": "{\"total\":8,\"byTool\":{\"explain\":3,\"fix\":2,\"tests\":3}}",
  "contextRefsJson": "{\"file\":5,\"selection\":8,\"workspace\":2}",
  "mcpToolsJson": "{\"total\":2,\"byServer\":{\"github\":2}}",
  "modelSwitchingJson": "{\"uniqueModels\":[\"gpt-4o\"],\"modelCount\":1}",
  "multiTurnSessions": 2,
  "avgTurnsPerSession": 3.5,
  "multiFileEdits": 1,
  "avgFilesPerEdit": 2.0,
  "codeBlockApplyRate": 0.8,
  "sessionCount": 3,
  "updatedAt": "2026-02-25T12:00:00Z"
}
```

## Performance Considerations

### Storage Size

- JSON fields increase entity size by ~500-2000 bytes per entity
- For 100 users × 30 days × 5 models = 15,000 entities/month
- Estimated storage: ~15-30 MB/month (negligible for Azure Tables)

### Query Performance

- Partition key is `ds:{datasetId}|d:{day}` - efficient for date range queries
- Row key includes all dimensions - enables efficient filtering
- JSON deserialization is fast (< 1ms per entity)

### Sync Performance

- Fluency metrics are extracted from cached session data (already computed)
- Minimal overhead: ~1-2ms per session file
- JSON serialization is optimized for small objects

## References

- [Fluency Levels Documentation](FLUENCY-LEVELS.md) - Scoring rules and thresholds
- [Trackable Data Documentation](TRACKABLE-DATA.md) - Complete list of tracked metrics
- [Backend Schema](../src/backend/storageTables.ts) - TypeScript interface definitions
- [Rollup Aggregation](../src/backend/rollups.ts) - Aggregation logic implementation
