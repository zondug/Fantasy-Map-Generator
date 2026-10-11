import Alea from "alea";
import { beforeAll, describe, expect, it } from "vitest";
import type { GridGraph } from "@/types/GridGraph";
import { RIVER_RELIEF_DEFAULTS, riverRelief } from "./river-relief";

let graph: GridGraph;
let base: Uint8Array;

beforeAll(async () => {
  globalThis.TIME = false;
  globalThis.window = globalThis.window || ({} as any);
  await import("./grid-generator");
  await import("./heightmap-generator");
  const config = { width: 960, height: 540, points: 10000 } as any;
  graph = Grid.generate("4242", config.width, config.height, config.points);
  Math.random = Alea("4242");
  base = HeightmapGenerator.fromTemplate(graph, "continents", config);
});

const run = (seed: string) => riverRelief(graph, base, { ...RIVER_RELIEF_DEFAULTS, top: 90, random: Alea(seed) });

describe("riverRelief", () => {
  it("keeps the coastline and stays in the height range", () => {
    const { heights } = run("1");
    for (let i = 0; i < base.length; i++) {
      expect(heights[i] >= 20).toBe(base[i] >= 20);
      if (base[i] < 20) expect(heights[i]).toBe(base[i]);
      else expect(heights[i]).toBeLessThanOrEqual(90);
    }
  });

  it("is deterministic for a seed", () => {
    expect(run("7").heights).toEqual(run("7").heights);
  });

  it("puts big rivers in the low ground", () => {
    const { heights, flux } = run("3");
    const land = [...heights.keys()].filter(i => heights[i] >= 20);
    const byHeight = [...land].sort((a, b) => heights[a] - heights[b]);
    const rank = new Map(byHeight.map((cell, i) => [cell, i / byHeight.length]));
    const big = [...land].sort((a, b) => flux[b] - flux[a]).slice(0, Math.ceil(land.length * 0.02));
    const meanRank = big.reduce((sum, cell) => sum + (rank.get(cell) as number), 0) / big.length;
    expect(meanRank).toBeLessThan(0.3);
  });

  it("runs as a template step", () => {
    Math.random = Alea("4242");
    const heights = HeightmapGenerator.fromTemplate(graph, "riverContinents", { width: 960, height: 540 } as any);
    expect(heights.length).toBe(base.length);
    expect(heights.some(h => h >= 60)).toBe(true);
  });
});
