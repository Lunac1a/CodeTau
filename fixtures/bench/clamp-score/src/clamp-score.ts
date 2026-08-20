export function clampScore(score: number): number {
    return Math.max(0, Math.min(10, score));
}

