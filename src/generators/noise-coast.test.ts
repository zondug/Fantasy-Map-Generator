import Alea from "alea";
import { beforeAll, describe, expect, it } from "vitest";
import { NOISE_COAST_DEFAULTS, noiseCoast } from "./noise-coast";

const W = 960;
const H = 540;
const run = (graph: any, seed: string, land = 0.45, ranges = 3) =>
  noiseCoast(graph, { ...NOISE_COAST_DEFAULTS, width: W, height: H, land, ranges, random: Alea(seed) });

let coarse: any;
let fine: any;

beforeAll(async () => {
  globalThis.TIME = false;
  globalThis.window = globalThis.window || ({} as any);
  await import("./grid-generator");
  coarse = Grid.generate("1", W, H, 5000);
  fine = Grid.generate("1", W, H, 40000);
});

describe("noiseCoast", () => {
  it("hits the requested land share and keeps the edge wet", () => {
    const { heights } = run(coarse, "a", 0.3);
    const land = heights.filter(h => h >= 20).length / heights.length;
    expect(land).toBeCloseTo(0.3, 2);
    coarse.cells.b.forEach((border: number, i: number) => {
      if (border) expect(heights[i]).toBeLessThan(20);
    });
  });

  it("is deterministic for a seed", () => {
    expect(run(coarse, "b").heights).toEqual(run(coarse, "b").heights);
  });

  it("gives the same coast and ridges at any cell count", () => {
    const a = run(coarse, "c");
    const b = run(fine, "c");
    let same = 0;
    let ridgeSame = 0;
    let ridgeCells = 0;
    coarse.points.forEach(([x, y]: [number, number], i: number) => {
      const j = Grid.findCell(x, y, fine);
      if (a.heights[i] >= 20 === b.heights[j] >= 20) same++;
      if (a.ridges[i] > 0.3) {
        ridgeCells++;
        if (b.ridges[j] > 0) ridgeSame++;
      }
    });
    expect(same / coarse.points.length).toBeGreaterThan(0.95);
    expect(ridgeSame / ridgeCells).toBeGreaterThan(0.9);
  });

  it("places no ridges when ranges is 0", () => {
    expect(run(coarse, "d", 0.45, 0).ridges.some(r => r > 0)).toBe(false);
  });
});
