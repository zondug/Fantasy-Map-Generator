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
  blobMargin: 0.1, // every circle, warp included, stays this share of the map half-size off the edge
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
  const warp = half * 0.15; // fbm of 3 octaves stays inside ±1, so the warp moves a shore at most this far
  const keepOff = half * options.blobMargin + warp;
  const shelfWidth = half * options.blobMargin;
  // pull a circle fully inside the map; one too large for the map is shrunk to fit
  const keepInside = (circle: [number, number, number]) => {
    circle[2] = Math.min(circle[2], width / 2 - keepOff, height / 2 - keepOff);
    circle[0] = Math.min(width - keepOff - circle[2], Math.max(keepOff + circle[2], circle[0]));
    circle[1] = Math.min(height - keepOff - circle[2], Math.max(keepOff + circle[2], circle[1]));
  };
  const warpX = simplex(random);
  const warpY = simplex(random);
  const circleInside = (x: number, y: number) => {
    const wx = x + warp * fbm(warpX, (x / half) * 1.5, (y / half) * 1.5, 3);
    const wy = y + warp * fbm(warpY, (x / half) * 1.5, (y / half) * 1.5, 3);
    let inside = 0;
    for (const [cx, cy, r] of circles) inside = Math.max(inside, 1 - Math.hypot(wx - cx, wy - cy) / r);
    return inside;
  };
  for (const circle of circles) keepInside(circle);
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
      for (const circle of circles) {
        circle[2] *= Math.min(2, Math.max(0.5, scale));
        keepInside(circle);
      }
    }
  }
  // rank decides land and sea; depth only shades the sea, so the edge shelf that keeps land away leaves no dark band
  const coastAt = (x: number, y: number, forDepth = false) => {
    const u = (x - width / 2) / half;
    const v = (y - height / 2) / half;
    const e = (fbm(coastNoise, u * options.frequency, v * options.frequency, options.octaves) + 1) / 2;
    const nd = Math.hypot((x - width / 2) / (width / 2), (y - height / 2) / (height / 2));
    if (!circles.length) {
      const fall = Math.min(1, Math.max(0, (nd - options.islandStart) / (1 - options.islandStart)));
      return e - fall ** options.islandPower * options.islandStrength;
    }
    const inside = circleInside(x, y);
    if (forDepth) return e - options.islandStrength + Math.max(-0.6, Math.min(inside, 0)) * 1.5;
    // a band along the map edge always ranks lowest, so land can never touch it whatever the circles do
    const edge = Math.min(x, width - x, y, height - y) / (shelfWidth * 2.5);
    const shelf = edge < 1 ? (1 - edge) ** 2 * 4 : 0; // gentle far out, steep near the edge: shores bend away instead of being cut
    // past a circle the shore can wander out a little, then the floor drops with distance
    if (inside <= 0) return e - options.islandStrength + inside * 6 - shelf;
    return e - (1 - Math.min(1, inside * 1.5)) ** options.islandPower * options.islandStrength - shelf;
  };
  const elevation = new Float32Array(n);
  for (let i = 0; i < n; i++) elevation[i] = graph.cells.b[i] ? -9 : coastAt(points[i][0], points[i][1]);
  const sorted = Float32Array.from(elevation).sort();
  const landShare = Math.min(0.95, Math.max(0.02, options.land));
  const threshold = sorted[Math.min(n - 1, Math.floor(n * (1 - landShare)))];

  const depth = new Float32Array(n);
  let low = Infinity;
  let shore = -Infinity;
  let top = -Infinity;
  for (let i = 0; i < n; i++) {
    if (elevation[i] >= threshold) {
      top = Math.max(top, elevation[i]);
      continue;
    }
    depth[i] = circles.length ? coastAt(points[i][0], points[i][1], true) : elevation[i];
    low = Math.min(low, depth[i]);
    shore = Math.max(shore, depth[i]);
  }
  const heights = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    heights[i] =
      elevation[i] >= threshold
        ? SEA_LEVEL + Math.round(((elevation[i] - threshold) / Math.max(1e-6, top - threshold)) * 25)
        : Math.round(((depth[i] - low) / Math.max(1e-6, shore - low)) * (SEA_LEVEL - 1));
  }
  // shallow shelf: water stays shallow near land and deepens over ~0.12 × half-size, so no shore drops straight to the deep
  const shelfDepth = new Float32Array(n).fill(Infinity);
  const shelfQueue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (elevation[i] < threshold) continue;
    shelfDepth[i] = 0;
    shelfQueue.push(i);
  }
  const shelfReach = half * 0.12;
  for (let head = 0; head < shelfQueue.length; head++) {
    const cell = shelfQueue[head];
    for (const next of graph.cells.c[cell]) {
      if (shelfDepth[next] !== Infinity) continue;
      const d = shelfDepth[cell] + Math.hypot(points[cell][0] - points[next][0], points[cell][1] - points[next][1]);
      if (d > shelfReach) continue;
      shelfDepth[next] = d;
      heights[next] = Math.max(heights[next], Math.round((SEA_LEVEL - 1) * (1 - (d / shelfReach) * 0.6)));
      shelfQueue.push(next);
    }
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

  // 3) ridge lines as curved polylines: the main peak 1, the others 0.55-0.8. Close peaks are joined by a
  // midpoint-displaced line with a saddle, lone peaks grow two wandering arms; spurs branch off both
  type Segment = { ax: number; ay: number; bx: number; by: number; ha: number; hb: number; wa: number; wb: number };
  type Vertex = [number, number, number]; // x, y, crest height
  const segments: Segment[] = [];
  const bandWidth = half * options.ridgeWidth;
  const widthNoise = simplex(random);
  const widthAt = (x: number, y: number) =>
    bandWidth * (0.65 + 0.7 * ((fbm(widthNoise, (x / half) * 3, (y / half) * 3, 2) + 1) / 2));
  const onLand = (x: number, y: number) => x > 0 && y > 0 && x < width && y < height && coastAt(x, y) >= threshold;
  const step = half * 0.02;

  const addLine = (line: Vertex[], scale = 1) => {
    for (let k = 1; k < line.length; k++) {
      const [ax, ay, ha] = line[k - 1];
      const [bx, by, hb] = line[k];
      segments.push({ ax, ay, bx, by, ha, hb, wa: widthAt(ax, ay) * scale, wb: widthAt(bx, by) * scale });
    }
  };
  // a wandering arm: heading drifts with a slowly changing curvature, height falls off to `fade` of the start
  const growArm = (x: number, y: number, heading: number, length: number, h: number, fade: number): Vertex[] => {
    const arm: Vertex[] = [[x, y, h]];
    const steps = Math.max(2, Math.ceil(length / step));
    let curve = (random() - 0.5) * 0.06;
    for (let k = 1; k <= steps; k++) {
      curve = Math.max(-0.06, Math.min(0.06, curve + (random() - 0.5) * 0.03) * 0.97); // drifts back toward straight
      heading += curve + (random() - 0.5) * 0.12;
      const nx = x + Math.cos(heading) * step;
      const ny = y + Math.sin(heading) * step;
      if (!onLand(nx, ny)) break;
      [x, y] = [nx, ny];
      arm.push([x, y, h * (1 - (1 - fade) * (k / steps))]);
    }
    return arm;
  };
  // spurs: short side ridges off a main line, lower and narrower
  const addSpurs = (line: Vertex[]) => {
    for (let k = 1; k < line.length - 1; k++) {
      if (random() > 0.1) continue;
      const [x, y, h] = line[k];
      const dir = Math.atan2(line[k + 1][1] - line[k - 1][1], line[k + 1][0] - line[k - 1][0]);
      const side = (random() < 0.5 ? 1 : -1) * (Math.PI / 2.6 + random() * (Math.PI / 5));
      const spur = growArm(x, y, dir + side, half * (0.1 + random() * 0.15), h * 0.8, 0.35);
      if (spur.length > 2) addLine(spur, 0.75);
    }
  };
  const displace = (a: Vertex, b: Vertex, depth: number): Vertex[] => {
    if (depth === 0) return [a, b];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const offset = (random() * 2 - 1) * length * 0.22;
    const nx = -(b[1] - a[1]) / (length || 1);
    const ny = (b[0] - a[0]) / (length || 1);
    const mid: Vertex = [(a[0] + b[0]) / 2 + nx * offset, (a[1] + b[1]) / 2 + ny * offset, (a[2] + b[2]) / 2];
    return [...displace(a, mid, depth - 1), ...displace(mid, b, depth - 1).slice(1)];
  };

  const peakHeight = peaks.map((_, index) => (index ? 0.55 + random() * 0.25 : 1));
  const linked = new Set<number>();
  for (let a = 0; a < peaks.length; a++) {
    for (let b = a + 1; b < peaks.length; b++) {
      const [ax, ay] = peaks[a];
      const [bx, by] = peaks[b];
      if (Math.hypot(bx - ax, by - ay) > half * options.connectDistance) continue;
      linked.add(a).add(b);
      const line = displace([ax, ay, peakHeight[a]], [bx, by, peakHeight[b]], 5);
      line.forEach((vertex, k) => {
        vertex[2] *= 0.85 + 0.15 * Math.abs((k / (line.length - 1)) * 2 - 1); // saddle between the peaks
      });
      addLine(line);
      addSpurs(line);
    }
  }
  peaks.forEach(([px, py], index) => {
    if (linked.has(index)) return;
    const angle = random() * Math.PI * 2;
    for (const heading of [angle, angle + Math.PI + (random() - 0.5) * 0.8]) {
      const arm = growArm(px, py, heading, (half * options.tailLength) / 2, peakHeight[index], 0.7);
      addLine(arm);
      addSpurs(arm);
    }
  });

  // 4) ridge band: falloff with noise-jittered distance to the nearest segment, width varying along the ridge, land only
  const jitterNoise = simplex(random);
  for (let i = 0; i < n; i++) {
    if (elevation[i] < threshold) continue;
    const [x, y] = points[i];
    const jitter = 1 + 0.35 * fbm(jitterNoise, (x / half) * 8, (y / half) * 8, 3);
    let strength = 0;
    for (const sg of segments) {
      const reach = Math.max(sg.wa, sg.wb) * 1.5;
      if (x < Math.min(sg.ax, sg.bx) - reach || x > Math.max(sg.ax, sg.bx) + reach) continue;
      if (y < Math.min(sg.ay, sg.by) - reach || y > Math.max(sg.ay, sg.by) + reach) continue;
      const dx = sg.bx - sg.ax;
      const dy = sg.by - sg.ay;
      const t = Math.min(1, Math.max(0, ((x - sg.ax) * dx + (y - sg.ay) * dy) / Math.max(1e-6, dx * dx + dy * dy)));
      const band = sg.wa + (sg.wb - sg.wa) * t;
      const d = Math.hypot(x - (sg.ax + dx * t), y - (sg.ay + dy * t)) * jitter;
      if (d >= band) continue;
      strength = Math.max(strength, (sg.ha + (sg.hb - sg.ha) * t) * (1 - d / band));
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
