// Noise coastline and mountain ridges, port of REX INVIS MapGen (mapgen2 coast + mapgen4 peak seeds).
// Noise is sampled in map-relative coordinates, so the shape does not change with the cell count.

export type NoiseCoastGraph = {
  points: [number, number][];
  cells: { c: number[][]; b: number[] };
};

export type NoiseCoastOptions = {
  width: number;
  height: number;
  land: number; // land share of all cells, 0-1
  ranges: number; // mountain range seeds, 0 = none
  blobs: number; // land mask: 0 = one central ellipse, N = N circles scattered at random
  random: () => number;
  frequency: number; // coastline noise cycles per map half-size
  octaves: number;
  islandStart: number; // normalized center distance where the edge falloff starts
  islandPower: number;
  islandStrength: number;
  blobRadius: [number, number];
  blobMargin: number;
  ridgeWidth: number; // ridge band half-width as a share of the map half-size
  connectDistance: number; // peaks closer than this share of the half-size are joined by a ridge
  tailLength: number; // ridge tail of an isolated peak, share of the half-size
};

export const NOISE_COAST_DEFAULTS = {
  frequency: 1.2,
  octaves: 5,
  islandStart: 0.65,
  islandPower: 0.8,
  islandStrength: 0.7,
  blobRadius: [0.25, 0.6] as [number, number], // circle radius range, share of the half-size
  blobMargin: 0.12, // circle centers keep this share of the map size away from the edge
  ridgeWidth: 0.045,
  connectDistance: 0.45,
  tailLength: 1
};

export type NoiseCoastResult = {
  heights: Uint8Array;
  ridges: Float32Array; // ridge strength 0-1 per cell, 0 off the ridges
};

const SEA_LEVEL = 20;

export function noiseCoast(graph: NoiseCoastGraph, options: NoiseCoastOptions): NoiseCoastResult {
  const { points } = graph;
  const n = points.length;
  const { width, height, random } = options;
  const half = Math.min(width, height) / 2;

  // 1) coast: fbm noise minus a mask falloff, cut at the quantile that gives the requested land share.
  // The mask is one central ellipse, or circles scattered at random; the map edge always falls off
  const coastNoise = simplex(random);
  const circles: [number, number, number][] = [];
  for (let k = 0; k < options.blobs; k++) {
    const m = options.blobMargin;
    const [r0, r1] = options.blobRadius;
    const x = width * (m + random() * (1 - 2 * m));
    const y = height * (m + random() * (1 - 2 * m));
    circles.push([x, y, half * (r0 + random() * (r1 - r0))]);
  }
  const edgeStart = circles.length ? 0.85 : options.islandStart;
  const warpX = simplex(random);
  const warpY = simplex(random);
  const circleInside = (x: number, y: number) => {
    const wx = x + half * 0.3 * fbm(warpX, (x / half) * 1.5, (y / half) * 1.5, 3);
    const wy = y + half * 0.3 * fbm(warpY, (x / half) * 1.5, (y / half) * 1.5, 3);
    let inside = 0;
    for (const [cx, cy, r] of circles) inside = Math.max(inside, 1 - Math.hypot(wx - cx, wy - cy) / r);
    return inside;
  };
  // scale the circles so they cover a bit more than the land share: the land then sits inside them, not in stray shards
  if (circles.length) {
    for (let pass = 0; pass < 4; pass++) {
      let covered = 0;
      const samples = 64 * 36;
      for (let k = 0; k < samples; k++) {
        if (circleInside(((k % 64) + 0.5) * (width / 64), (Math.floor(k / 64) + 0.5) * (height / 36)) > 0) covered++;
      }
      const scale = Math.sqrt((Math.min(0.95, options.land * 1.35) * samples) / Math.max(1, covered));
      if (Math.abs(scale - 1) < 0.03) break;
      for (const circle of circles) circle[2] *= Math.min(2, Math.max(0.5, scale));
    }
  }
  const coastAt = (x: number, y: number) => {
    const u = (x - width / 2) / half;
    const v = (y - height / 2) / half;
    const e = (fbm(coastNoise, u * options.frequency, v * options.frequency, options.octaves) + 1) / 2;
    const nd = Math.hypot((x - width / 2) / (width / 2), (y - height / 2) / (height / 2));
    let fall = Math.min(1, Math.max(0, (nd - edgeStart) / (1 - edgeStart)));
    if (circles.length) fall = Math.max(fall, 1 - Math.min(1, Math.max(0, circleInside(x, y)) * 1.5));
    return e - fall ** options.islandPower * options.islandStrength;
  };
  const elevation = new Float32Array(n);
  for (let i = 0; i < n; i++) elevation[i] = graph.cells.b[i] ? -1 : coastAt(points[i][0], points[i][1]);
  const sorted = Float32Array.from(elevation).sort();
  const landShare = Math.min(0.95, Math.max(0.02, options.land));
  const threshold = sorted[Math.min(n - 1, Math.floor(n * (1 - landShare)))];

  let low = Infinity;
  let top = -Infinity;
  for (let i = 0; i < n; i++) {
    if (elevation[i] >= threshold) top = Math.max(top, elevation[i]);
    else low = Math.min(low, elevation[i]);
  }
  const heights = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const e = elevation[i];
    heights[i] =
      e >= threshold
        ? SEA_LEVEL + Math.round(((e - threshold) / Math.max(1e-6, top - threshold)) * 25)
        : Math.round(((e - low) / Math.max(1e-6, threshold - low)) * (SEA_LEVEL - 1));
  }

  const ridges = new Float32Array(n);
  if (options.ranges <= 0) return { heights, ridges };

  // 2) peaks on a fixed lattice, not on cells, so they do not move with the cell count
  const columns = 96;
  const rows = Math.max(2, Math.round((columns * height) / width));
  const cellW = width / columns;
  const cellH = height / rows;
  const latticeLand = new Uint8Array(columns * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++)
      latticeLand[r * columns + c] = coastAt((c + 0.5) * cellW, (r + 0.5) * cellH) >= threshold ? 1 : 0;
  const inland = new Float32Array(columns * rows).fill(-1);
  const queue: number[] = [];
  for (let k = 0; k < inland.length; k++) {
    if (latticeLand[k]) continue;
    inland[k] = 0;
    queue.push(k);
  }
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head];
    const c = k % columns;
    const r = (k - c) / columns;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const nc = c + dc;
        const nr = r + dr;
        if ((!dc && !dr) || nc < 0 || nr < 0 || nc >= columns || nr >= rows) continue;
        const next = nr * columns + nc;
        if (inland[next] >= 0) continue;
        inland[next] = inland[k] + Math.hypot(dc * cellW, dr * cellH);
        queue.push(next);
      }
  }
  let deepest = 0;
  for (let k = 0; k < inland.length; k++) if (inland[k] > inland[deepest]) deepest = k;
  const latticePoint = (k: number): [number, number] => [
    ((k % columns) + 0.5) * cellW,
    (Math.floor(k / columns) + 0.5) * cellH
  ];

  const ridgeNoise = simplex(random);
  const candidates: [number, number][] = [];
  for (let k = 0; k < inland.length; k++) {
    if (inland[k] < inland[deepest] * 0.3) continue;
    const [x, y] = latticePoint(k);
    candidates.push([1 - Math.abs(fbm(ridgeNoise, (x / half) * 2, (y / half) * 2, 4)), k]);
  }
  candidates.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const spacing = half / (options.ranges + 1);
  const peaks: [number, number][] = [];
  for (const [, k] of candidates) {
    if (peaks.length >= options.ranges) break;
    const [x, y] = latticePoint(k);
    if (peaks.every(([px, py]) => Math.hypot(px - x, py - y) >= spacing)) peaks.push([x, y]);
  }
  if (!peaks.length) peaks.push(latticePoint(deepest));

  // 3) ridge lines as segments: the main peak 1, the others 0.55-0.8; close peaks joined with a saddle, lone ones get a wandering tail
  type Segment = { ax: number; ay: number; bx: number; by: number; ha: number; hb: number; saddle: boolean };
  const segments: Segment[] = [];
  const peakHeight = peaks.map((_, index) => (index ? 0.55 + random() * 0.25 : 1));
  const linked = new Set<number>();
  for (let a = 0; a < peaks.length; a++) {
    for (let b = a + 1; b < peaks.length; b++) {
      const [ax, ay] = peaks[a];
      const [bx, by] = peaks[b];
      if (Math.hypot(bx - ax, by - ay) > half * options.connectDistance) continue;
      linked.add(a).add(b);
      segments.push({ ax, ay, bx, by, ha: peakHeight[a], hb: peakHeight[b], saddle: true });
    }
  }
  const step = half * 0.02;
  peaks.forEach(([px, py], index) => {
    const tails = linked.has(index) ? 0 : 2; // a lone peak gets a range running both ways
    let angle = random() * Math.PI * 2;
    for (let tail = 0; tail < tails; tail++, angle += Math.PI) {
      let heading = angle;
      let [x, y] = [px, py];
      const steps = Math.ceil((half * options.tailLength) / step / 2);
      for (let s = 1; s <= steps; s++) {
        if (random() < 0.08) heading += (random() < 0.5 ? 1 : -1) * (Math.PI / 6);
        const nx = x + Math.cos(heading) * step;
        const ny = y + Math.sin(heading) * step;
        if (nx < 0 || ny < 0 || nx > width || ny > height || coastAt(nx, ny) < threshold) break;
        const h0 = peakHeight[index] * (1 - 0.3 * ((s - 1) / steps));
        const h1 = peakHeight[index] * (1 - 0.3 * (s / steps));
        segments.push({ ax: x, ay: y, bx: nx, by: ny, ha: h0, hb: h1, saddle: false });
        [x, y] = [nx, ny];
      }
    }
  });

  // 4) ridge band: falloff with noise-jittered distance to the nearest segment, over land only
  const bandWidth = half * options.ridgeWidth;
  const jitterNoise = simplex(random);
  for (let i = 0; i < n; i++) {
    if (elevation[i] < threshold) continue;
    const [x, y] = points[i];
    const jitter = 1 + 0.35 * fbm(jitterNoise, (x / half) * 8, (y / half) * 8, 3);
    let strength = 0;
    for (const sg of segments) {
      if (x < Math.min(sg.ax, sg.bx) - bandWidth * 1.5 || x > Math.max(sg.ax, sg.bx) + bandWidth * 1.5) continue;
      if (y < Math.min(sg.ay, sg.by) - bandWidth * 1.5 || y > Math.max(sg.ay, sg.by) + bandWidth * 1.5) continue;
      const dx = sg.bx - sg.ax;
      const dy = sg.by - sg.ay;
      const t = Math.min(1, Math.max(0, ((x - sg.ax) * dx + (y - sg.ay) * dy) / Math.max(1e-6, dx * dx + dy * dy)));
      const d = Math.hypot(x - (sg.ax + dx * t), y - (sg.ay + dy * t)) * jitter;
      if (d >= bandWidth) continue;
      const crest = (sg.ha + (sg.hb - sg.ha) * t) * (sg.saddle ? 0.85 + 0.15 * Math.abs(t * 2 - 1) : 1);
      strength = Math.max(strength, crest * (1 - d / bandWidth));
    }
    if (!strength) continue;
    ridges[i] = strength;
    heights[i] = Math.min(100, heights[i] + Math.round(strength * 45));
  }

  return { heights, ridges };
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves: number): number {
  let sum = 0;
  let amplitude = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x, y) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    x *= 2;
    y *= 2;
  }
  return sum / norm;
}

// 2D simplex noise (Gustavson), permutation drawn from the seeded generator
function simplex(random: () => number): (x: number, y: number) => number {
  const perm = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  const gradients = [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  const corner = (gi: number, x: number, y: number) => {
    const t = 0.5 - x * x - y * y;
    if (t < 0) return 0;
    const [gx, gy] = gradients[gi & 7];
    return t ** 4 * (gx * x + gy * y);
  };
  return (x: number, y: number) => {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const ii = i & 255;
    const jj = j & 255;
    const n0 = corner(perm[ii + perm[jj]], x0, y0);
    const n1 = corner(perm[ii + i1 + perm[jj + j1]], x0 - i1 + G2, y0 - j1 + G2);
    const n2 = corner(perm[ii + 1 + perm[jj + 1]], x0 - 1 + 2 * G2, y0 - 1 + 2 * G2);
    return 70 * (n0 + n1 + n2);
  };
}
