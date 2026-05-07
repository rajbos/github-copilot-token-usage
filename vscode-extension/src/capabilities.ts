/**
 * Capability registry for companion extension grants.
 *
 * Companion extensions register a capability UUID on activation.
 * The host reads the registry at panel-open time to gate UI features.
 *
 * This is a soft-gating mechanism for UI visibility; it does not enforce
 * licensing or entitlement — any installed extension can register a UUID.
 */

/** Grants the Session Efficiency view to companion extensions that register this UUID. */
export const EFFICIENCY_CAPABILITY_UUID = 'a7f3c912-8b4e-4d5f-9c2a-1e6b8f0d3a5c';

const _grantedCapabilities = new Set<string>();

/** Register a capability UUID. Called by companion extensions on activation. */
export function registerCapability(uuid: string): void {
  _grantedCapabilities.add(uuid);
}

/** Unregister a capability UUID. Call from companion extension's deactivate(). */
export function unregisterCapability(uuid: string): void {
  _grantedCapabilities.delete(uuid);
}

/** Returns true if the given capability UUID has been registered. */
export function hasCapability(uuid: string): boolean {
  return _grantedCapabilities.has(uuid);
}
