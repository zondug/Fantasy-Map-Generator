// River-first relief: grow a drainage network from the coast inland, then derive land heights from it, so large
// rivers sit in valleys and watershed borders become ridges. Port of REX INVIS MapGenField (dandrino/terrain-erosion-3-ways
// river_network idea). The coastline and the rough relief come from the heights already built by the template steps.

export type RiverReliefGraph = {
  points: [number, number][];
  cells: { c: number[][]; b: number[] };
  spacing: number;
};

export type RiverReliefOptions = {
  top: number; // land height of the highest cell, 21-100
  inertia: number; // growth direction persistence, 0-1
  jitter: number; // growth priority noise
  downcut: number; // how strongly flux deepens valleys
  maxDelta: number; // cap of a single edge height step, normalized slope units
  minDelta: number; // slope floor so plains still rise from the coast
  coastRamp: number; // share of the map half-size over which land rises from the coast
  costNoise: number; // per-cell slope noise, breaks the square-grid bias
  smooth: number; // land smoothing passes before ranking, removes cell-scale speckle
  reliefWeight: number; // share of the template relief kept in the final ranking, 0 = pure river relief
  ridges?: Float32Array; // per-cell height added by template Range steps
  ridgeWeight: number; // extra slope cost on those ridges, 0 = ignore them
  random: () => number;
};

export const RIVER_RELIEF_DEFAULTS: Omit<RiverReliefOptions, "random" | "top" | "ridges"> = {
  inertia: 0.4,
  jitter: 0.1,
  downcut: 1.3,
  maxDelta: 0.35,
  minDelta: 0.04,
  coastRamp: 0.25,
  costNoise: 0.1,
  smooth: 2,
  reliefWeight: 0,
  ridgeWeight: 4
};

// land height quantiles of the REX INVIS peaks generator: keeps mountain and hill shares, changes only their placement
const REFERENCE_QUANTILES = [
  0.009, 0.015, 0.038, 0.062, 0.081, 0.1, 0.117, 0.134, 0.151, 0.171, 0.19, 0.209, 0.228, 0.246, 0.267, 0.292, 0.325,
  0.37, 0.45, 0.598, 1
];

const SEA_LEVEL = 20;

export type RiverReliefResult = {
  heights: Uint8Array;
  down: Int32Array; // downstream cell of the drainage tree, -1 for sea and unassigned cells
  flux: Float32Array;
};

export function riverRelief(
  graph: RiverReliefGraph,
  source: Uint8Array,
  options: RiverReliefOptions
): RiverReliefResult {
  const { points, spacing } = graph;
  const neighbors = graph.cells.c;
  const n = source.length;
  const random = options.random;
  const dist = (a: number, b: number) => Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1]);

  const sea = markSea(graph, source);

  const coastDistance = new Float32Array(n).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < n; i++)
    if (sea[i]) {
      coastDistance[i] = 0;
      queue.push(i);
    }
  for (let head = 0; head < queue.length; head++) {
    const x = queue[head];
    for (const y of neighbors[x])
      if (coastDistance[y] < 0) {
        coastDistance[y] = coastDistance[x] + spacing;
        queue.push(y);
      }
  }

  let maxX = 0;
  let maxY = 0;
  for (const [x, y] of points) {
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const ramp = Math.max(spacing, (Math.min(maxX, maxY) / 2) * options.coastRamp);

  const initial = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const relief = Math.min(1, Math.max(0, (source[i] - SEA_LEVEL) / (100 - SEA_LEVEL)));
    initial[i] = (relief + 0.1) * Math.tanh(Math.max(0, coastDistance[i]) / ramp);
  }

  const delta = new Float32Array(n);
  let deltaMax = 1e-6;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const j of neighbors[i]) sum += Math.abs(initial[i] - initial[j]) / Math.max(1e-4, dist(i, j) / spacing);
    delta[i] = (sum / Math.max(1, neighbors[i].length)) * (1 + (random() * 2 - 1) * options.costNoise);
    deltaMax = Math.max(deltaMax, delta[i]);
  }
  for (let i = 0; i < n; i++) delta[i] = Math.max(options.minDelta, delta[i] / deltaMax);

  // template ranges stay costly to climb, so they rise as divides and rivers grow away from them
  const ridgeFactor = new Float32Array(n).fill(1);
  if (options.ridges && options.ridgeWeight > 0) {
    let ridgeMax = 0;
    for (let i = 0; i < n; i++) ridgeMax = Math.max(ridgeMax, options.ridges[i]);
    if (ridgeMax > 0)
      for (let i = 0; i < n; i++) ridgeFactor[i] += (options.ridgeWeight * options.ridges[i]) / ridgeMax;
  }
  for (let i = 0; i < n; i++) delta[i] *= ridgeFactor[i];

  const preliminary = coastDijkstra(graph, sea, delta, ridgeFactor, null, null, 0, Infinity);

  // grow the network uphill from every coast edge, preferring steps aligned with the previous direction
  const down = new Int32Array(n).fill(-1);
  const assigned = new Uint8Array(n);
  const order: number[] = [];
  const heap = new Heap();
  const from: number[] = [];
  const to: number[] = [];
  const dirX: number[] = [];
  const dirY: number[] = [];
  const pushStep = (a: number, b: number, dx: number, dy: number, key: number) => {
    from.push(a);
    to.push(b);
    dirX.push(dx);
    dirY.push(dy);
    heap.push(key, from.length - 1);
  };
  const unit = (a: number, b: number): [number, number] => {
    const d = dist(a, b) || 1;
    return [(points[b][0] - points[a][0]) / d, (points[b][1] - points[a][1]) / d];
  };

  for (let i = 0; i < n; i++) {
    if (!sea[i]) continue;
    for (const j of neighbors[i]) {
      if (sea[j]) continue;
      const [ux, uy] = unit(i, j);
      pushStep(i, j, ux, uy, -1 + random() * options.jitter);
    }
  }
  while (heap.size) {
    const step = heap.pop();
    const cell = to[step];
    if (assigned[cell]) continue;
    assigned[cell] = 1;
    down[cell] = from[step];
    order.push(cell);
    const dx = dirX[step];
    const dy = dirY[step];
    for (const next of neighbors[cell]) {
      if (sea[next] || assigned[next] || preliminary[next] < preliminary[cell]) continue;
      const [ux, uy] = unit(cell, next);
      let wx = ux + (dx - ux) * options.inertia;
      let wy = uy + (dy - uy) * options.inertia;
      const wl = Math.hypot(wx, wy) || 1;
      wx /= wl;
      wy /= wl;
      pushStep(cell, next, wx, wy, -(dx * ux + dy * uy) + random() * options.jitter);
    }
  }

  // flux = orographic rain plus everything upstream
  let preliminaryMax = 1e-6;
  for (let i = 0; i < n; i++) preliminaryMax = Math.max(preliminaryMax, preliminary[i]);
  const flux = new Float32Array(n);
  let rainSum = 0;
  for (const cell of order) {
    const e = Math.min(1, preliminary[cell] / preliminaryMax);
    flux[cell] = 0.3 + 2.2 * e * e;
    rainSum += flux[cell];
  }
  for (let k = order.length - 1; k >= 0; k--) {
    const cell = order[k];
    if (!sea[down[cell]]) flux[down[cell]] += flux[cell];
  }
  const rainMean = Math.max(1e-6, rainSum / Math.max(1, order.length));
  const relativeFlux = flux.map(f => f / rainMean);

  const carved = coastDijkstra(graph, sea, delta, ridgeFactor, down, relativeFlux, options.downcut, options.maxDelta);

  // channels must fall downstream
  const sortedFlux = order.map(cell => flux[cell]).sort((a, b) => a - b);
  const channelFlux = sortedFlux.length ? sortedFlux[Math.floor(sortedFlux.length * 0.98)] * 0.12 : Infinity;
  for (let k = order.length - 1; k >= 0; k--) {
    const cell = order[k];
    const next = down[cell];
    if (flux[cell] < channelFlux || sea[next]) continue;
    if (carved[next] > carved[cell] - 1e-6) carved[next] = carved[cell] - 1e-6;
  }

  for (let pass = 0; pass < options.smooth; pass++) {
    const previous = Float32Array.from(carved);
    for (const cell of order) {
      let sum = previous[cell];
      let count = 1;
      for (const j of neighbors[cell]) {
        if (sea[j]) continue;
        sum += previous[j];
        count++;
      }
      carved[cell] = sum / count;
    }
  }
  if (options.reliefWeight > 0) {
    const scale = Math.max(1e-6, ...order.map(cell => carved[cell]));
    for (const cell of order) carved[cell] = carved[cell] / scale + options.reliefWeight * initial[cell];
  }

  // rank-match land heights to the reference distribution, keep sea and lake cells as built by the template
  const heights = Uint8Array.from(source);
  const land = order.filter(cell => source[cell] >= SEA_LEVEL).sort((a, b) => carved[a] - carved[b] || a - b);
  const last = Math.max(1, land.length - 1);
  const qLast = REFERENCE_QUANTILES.length - 1;
  const top = Math.min(100, Math.max(SEA_LEVEL + 1, options.top));
  land.forEach((cell, rank) => {
    const q = (rank / last) * qLast;
    const qi = Math.min(Math.floor(q), qLast - 1);
    const value = REFERENCE_QUANTILES[qi] + (REFERENCE_QUANTILES[qi + 1] - REFERENCE_QUANTILES[qi]) * (q - qi);
    heights[cell] = Math.round(SEA_LEVEL + 1 + value * (top - SEA_LEVEL - 1));
  });

  return { heights, down, flux };
}

/** sinks: water connected to the map edge. Inland water stays a lake the network flows through */
function markSea(graph: RiverReliefGraph, source: Uint8Array): Uint8Array {
  const n = source.length;
  const neighbors = graph.cells.c;
  const sea = new Uint8Array(n);
  const queue: number[] = [];
  for (let i = 0; i < n; i++)
    if (graph.cells.b[i] && source[i] < SEA_LEVEL) {
      sea[i] = 1;
      queue.push(i);
    }
  if (!queue.length)
    for (let i = 0; i < n; i++)
      if (source[i] < SEA_LEVEL) {
        sea[i] = 1;
        queue.push(i);
      }
  if (!queue.length)
    for (let i = 0; i < n; i++)
      if (graph.cells.b[i]) {
        sea[i] = 1;
        queue.push(i);
      }
  for (let head = 0; head < queue.length; head++) {
    for (const j of neighbors[queue[head]]) {
      if (sea[j] || source[j] >= SEA_LEVEL) continue;
      sea[j] = 1;
      queue.push(j);
    }
  }
  return sea;
}

/** height = cheapest climb from the coast; edges along the drainage tree are discounted by their flux, ridges raise the step cap */
function coastDijkstra(
  graph: RiverReliefGraph,
  sea: Uint8Array,
  delta: Float32Array,
  capFactor: Float32Array,
  down: Int32Array | null,
  relativeFlux: Float32Array | null,
  downcut: number,
  cap: number
): Float32Array {
  const { points, spacing } = graph;
  const neighbors = graph.cells.c;
  const n = sea.length;
  const height = new Float32Array(n).fill(-1);
  const heap = new Heap();
  for (let i = 0; i < n; i++) {
    if (!sea[i]) continue;
    if (neighbors[i].some(j => !sea[j])) heap.push(0, i);
    else height[i] = 0;
  }
  while (heap.size) {
    const key = heap.topKey();
    const cell = heap.pop();
    if (height[cell] >= 0) continue;
    height[cell] = key;
    for (const next of neighbors[cell]) {
      if (height[next] >= 0) continue;
      const d = Math.hypot(points[cell][0] - points[next][0], points[cell][1] - points[next][1]) / spacing;
      let cost = delta[next] * d;
      if (down && relativeFlux && downcut > 0 && down[next] === cell) cost /= 1 + relativeFlux[next] ** downcut;
      heap.push(key + Math.min(cap * capFactor[next] * d, cost), next);
    }
  }
  for (let i = 0; i < n; i++) if (height[i] < 0) height[i] = 0;
  return height;
}

class Heap {
  private keys: number[] = [];
  private values: number[] = [];

  get size() {
    return this.keys.length;
  }

  topKey() {
    return this.keys[0];
  }

  push(key: number, value: number) {
    const keys = this.keys;
    const values = this.values;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  pop(): number {
    const keys = this.keys;
    const values = this.values;
    const top = values[0];
    const lastKey = keys.pop() as number;
    const lastValue = values.pop() as number;
    const size = keys.length;
    if (!size) return top;
    let i = 0;
    while (true) {
      const left = i * 2 + 1;
      if (left >= size) break;
      const child = left + 1 < size && keys[left + 1] < keys[left] ? left + 1 : left;
      if (lastKey <= keys[child]) break;
      keys[i] = keys[child];
      values[i] = values[child];
      i = child;
    }
    keys[i] = lastKey;
    values[i] = lastValue;
    return top;
  }
}
