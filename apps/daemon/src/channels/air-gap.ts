/**
 * @file air-gap.ts
 * Sovereign Air-Gap Enforcement Policy for Exocortex Daemon.
 */

export class AirGapViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirGapViolationError";
  }
}

export class AirGapPolicy {
  private static enabled: boolean = process.env.EXOCORTEX_AIR_GAP === "true";

  /**
   * Check if strict air-gap mode is currently active.
   */
  static isAirGapActive(): boolean {
    return this.enabled;
  }

  /**
   * Enable or disable strict air-gap mode at runtime.
   */
  static setAirGapActive(active: boolean): void {
    this.enabled = active;
  }

  /**
   * Assert that an outbound request to an external domain is permitted.
   * Throws AirGapViolationError if air-gap is active.
   */
  static assertOutboundAllowed(targetDomain: string): void {
    if (this.enabled) {
      throw new AirGapViolationError(
        `Outbound network request to "${targetDomain}" was blocked by Sovereign Air-Gap Policy.`
      );
    }
  }
}
