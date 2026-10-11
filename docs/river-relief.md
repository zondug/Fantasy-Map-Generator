# River-first relief (fork experiment)

`Rivers <top> [inertia] [ridgeWeight]` is a heightmap template step that rebuilds land heights from a drainage network.
It runs after the other steps: they shape the coastline and the rough relief, `Rivers` keeps the coastline and
the water heights and replaces land heights. Code: `src/generators/river-relief.ts`, ported from REX INVIS
`MapGenField.gd` (idea from dandrino/terrain-erosion-3-ways `river_network.py`, MIT).

Pipeline on the grid cells:

1. Sea = water connected to the map edge. Inland water is a lake the network flows through.
2. Initial relief = template land height × coast ramp `tanh(coastDistance / ramp)`; slope = mean neighbor difference, normalized, with a floor.
   Cells raised by template `Range` steps get slope and step cap × `1 + ridgeWeight × ridge` (default 4): ranges stay where the template put them and act as divides, rivers carve the valleys between them. `0` turns this off. Hills and other steps only shape the coast and the initial relief.
3. Preliminary height = cheapest climb from the coast (Dijkstra).
4. Network grows uphill from every coast edge, one cell at a time, preferring the previous direction (`inertia`).
5. Flux = orographic rain + upstream sum. Final height = Dijkstra again, edges along the network cheaper by `1 + flux^downcut`, so big rivers cut valleys and watershed borders become ridges.
6. Channels forced downhill, land smoothed, optionally blended with `reliefWeight` of the template relief (default 0, pure river relief), then rank-matched to a reference height distribution scaled to `top`.

Presets use `Rivers 80-95 0 4 0` (probability 0, pick them in the template list): `riverContinents`, `riverPangea`, `riverOldWorld`, `riverHighIsland`.

Measured on a 10k-cell grid: the top 2% flux cells sit at land height percentile 12–20 with `reliefWeight` 0,
19–25 with 0.3 (templates alone: 29–49). The step costs about 45 ms at 10k cells.
With ridgeWeight 4 (5 seeds): high-ground clusters (top 8% land) 7–12 vs 14–26 at 0, river percentile 16–21.
