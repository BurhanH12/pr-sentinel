/**
 * Tracks whether a review run is still the latest for its PR.
 * In-memory implementation used by the default queue; Redis mode extends this later.
 */
export interface RunFreshnessChecker {
  isCurrentRun(runKey: string): boolean;
}

export class InMemoryRunFreshnessChecker implements RunFreshnessChecker {
  private readonly supersededRunKeys = new Set<string>();

  markSuperseded(runKey: string): void {
    this.supersededRunKeys.add(runKey);
  }

  isCurrentRun(runKey: string): boolean {
    return !this.supersededRunKeys.has(runKey);
  }

  clearSuperseded(runKey: string): void {
    this.supersededRunKeys.delete(runKey);
  }
}
