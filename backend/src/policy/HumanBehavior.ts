/**
 * Human Behavior Simulation and Jitter Synthesis
 * Uses Box-Muller transform for realistic Gaussian-distributed delays.
 */
export class HumanBehavior {
  /**
   * Generates a random number following a normal distribution
   * @param mean Center point of delay in ms
   * @param stdev Standard deviation
   */
  public static gaussianRandom(mean: number, stdev: number): number {
    let u1 = 0;
    let u2 = 0;
    while (u1 === 0) u1 = Math.random();
    while (u2 === 0) u2 = Math.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return z0 * stdev + mean;
  }

  /**
   * Calculates a human-like delay with bounded jitter
   * @param minMs Minimum delay threshold
   * @param maxMs Maximum delay threshold
   * @param targetMean Optimal average delay
   */
  public static calculateDelay(minMs: number, maxMs: number, targetMean?: number): number {
    const mean = targetMean ?? (minMs + maxMs) / 2;
    const stdev = (maxMs - minMs) / 6; // 99.7% of values within range
    const raw = this.gaussianRandom(mean, stdev);
    return Math.max(minMs, Math.min(maxMs, Math.round(raw)));
  }

  /**
   * Inter-keystroke delay for human typing simulation
   */
  public static getKeystrokeDelay(): number {
    return this.calculateDelay(40, 220, 95);
  }

  /**
   * Action cooldown between consecutive browser interactions
   */
  public static getActionCooldown(): number {
    return this.calculateDelay(1500, 8000, 3200);
  }

  /**
   * Page reading micro-pause
   */
  public static getPageReadingPause(): number {
    return this.calculateDelay(5000, 25000, 11000);
  }

  /**
   * Asynchronous sleep helper
   */
  public static async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
