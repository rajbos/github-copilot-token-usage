/**
 * Constants for the backend module.
 */

/**
 * Minimum backend sync interval in milliseconds (5 minutes).
 * Prevents excessive syncing when UI refreshes frequently.
 */
export const BACKEND_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Query result cache TTL in milliseconds (30 seconds).
 * Cached results are reused within this window to reduce Azure API calls.
 */
export const QUERY_CACHE_TTL_MS = 30 * 1000;

/**
 * Maximum number of items to display in UI lists.
 */
export const MAX_UI_LIST_ITEMS = 50;

/**
 * Minimum lookback days (1 day).
 */
export const MIN_LOOKBACK_DAYS = 1;

/**
 * Maximum lookback days (1 year).
 */
export const MAX_LOOKBACK_DAYS = 365;

/**
 * Default lookback days (30 days).
 */
export const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * Azure Tables forbidden characters in PartitionKey/RowKey.
 * These must be sanitized before use.
 */
export const AZURE_TABLES_FORBIDDEN_CHARS = ['/', '\\', '#', '?'];

/**
 * Schema version for rollups without userId.
 */
export const SCHEMA_VERSION_NO_USER = 1;

/**
 * Schema version for rollups with userId.
 */
export const SCHEMA_VERSION_WITH_USER = 2;

/**
 * Schema version for rollups with userId + consent metadata.
 */
export const SCHEMA_VERSION_WITH_USER_AND_CONSENT = 3;

/**
 * Default dataset ID.
 */
export const DEFAULT_DATASET_ID = 'default';

/**
 * Default aggregate table name.
 */
export const DEFAULT_AGG_TABLE = 'usageAggDaily';

/**
 * Default events table name.
 */
export const DEFAULT_EVENTS_TABLE = 'usageEvents';

/**
 * Default raw container name.
 */
export const DEFAULT_RAW_CONTAINER = 'raw-usage';
