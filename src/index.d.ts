/**
 * NetCluster — fully dynamic hierarchical geospatial clustering.
 * https://github.com/renatex314/NetCluster
 */

/** [west, south, east, north] in degrees. */
export type BBox = [number, number, number, number];

/** Device identifier. Numbers keep the index smallest; strings are fine too. */
export type DeviceId = string | number;

export interface NetClusterOptions {
  /** Cluster radius in screen pixels. Default 40. */
  radius?: number;
  /** Finest zoom level maintained. Default 16, maximum 20. */
  maxZoom?: number;
  /** Coarsest zoom level served by queries. Default 0. */
  minZoom?: number;
  /** Tile extent the radius is expressed in. Default 512. */
  extent?: number;
  /**
   * How far an existing assignment may stretch before a point is re-homed.
   * Higher means fewer visible marker changes and a larger worst-case cluster
   * radius, bounded by `2 * (1 + hysteresis) * radius`. Default 0.25.
   */
  hysteresis?: number;
  /**
   * Number of filter categories, enabling `getClusters(bbox, zoom, category)`.
   * Costs 20 bytes per point per category. Default 0 (disabled).
   *
   * Equivalent to a single dimension; use `dimensions` for anything more.
   * Passing both is an error.
   */
  categories?: number;
  /** Property name holding the category on inserted points. Default 'category'. */
  categoryField?: string;
  /**
   * Properties you can filter on, each with its possible values — either a count
   * (values are `0 .. n-1`) or a list of labels.
   *
   * `{ multi: true }` lets one device hold several values for that dimension,
   * which a single category cannot express. Values are read from the properties
   * passed to `insert` / `moveTo` under the dimension's own name; a missing value
   * means index 0.
   *
   * ```ts
   * new NetCluster({
   *   dimensions: { client: { values: 40, multi: true }, status: ['idle', 'enroute'] },
   *   filters: [['client'], ['status'], ['client', 'status']],
   * });
   * ```
   */
  dimensions?: Record<string, number | readonly string[] | {
    values: number | readonly string[];
    multi?: boolean;
  }>;
  /**
   * Which combinations of dimensions a query may name. Defaults to each
   * dimension on its own.
   *
   * Every shape is stored separately, so this is what filtering costs: a device
   * contributes one aggregate entry per shape per tree level. A query must match
   * a declared shape exactly, or it throws — a filter never silently degrades
   * into a scan.
   */
  filters?: ReadonlyArray<readonly string[]>;
  /**
   * Largest number of cells one device may occupy. Defaults to the number of
   * shapes, times 8 when any dimension is `multi`. A device past the cap is
   * rejected by name rather than quietly costing many times its neighbours.
   */
  maxCellsPerDevice?: number;
  /**
   * Cell count at or below which aggregates are stored densely — an array index
   * per (node, cell) rather than a hash probe. Default 32.
   *
   * Dense is faster; it costs 20 bytes per device per cell whether or not the
   * cell occurs, which is why a large cell space goes sparse instead. Set to 0 to
   * force the sparse table. Filtering results are identical either way.
   */
  denseCells?: number;
  /**
   * Where `insertFeature` / `load` look for the id when a GeoJSON Feature has no
   * `id` of its own. Default 'id'.
   */
  idField?: string;
}

/**
 * What a filtered query selects: a category index (the `categories` spelling), or
 * one value per dimension of a declared filter shape.
 *
 * A device may hold several values for a `multi` dimension, but a query names one
 * of them — "client 7" is a question with an answer, "client 7 or 9" is two.
 */
export type FilterSelector = number | Record<string, string | number>;

export interface ClusterProperties {
  cluster: true;
  /** Pass this to getChildren / getLeaves / getClusterExpansionZoom. */
  cluster_id: number;
  point_count: number;
  point_count_abbreviated: string;
}

export interface PointGeometry {
  type: 'Point';
  /** [longitude, latitude] */
  coordinates: [number, number];
}

/** A drawn cluster of two or more points. */
export interface ClusterFeature {
  type: 'Feature';
  properties: ClusterProperties;
  geometry: PointGeometry;
}

/** A single point, drawn on its own. */
export interface SinglePointFeature<P = Record<string, unknown>> {
  type: 'Feature';
  id: DeviceId;
  properties: P;
  geometry: PointGeometry;
}

export type NetClusterFeature<P = Record<string, unknown>> = ClusterFeature | SinglePointFeature<P>;

/** What `getFeatureCollection` and `toGeoJSON` return. */
export interface NetClusterFeatureCollection<P = Record<string, unknown>> {
  type: 'FeatureCollection';
  features: Array<NetClusterFeature<P>>;
}

/**
 * A GeoJSON Feature accepted by `insertFeature` / `moveToFeature` / `load`.
 *
 * Looser than what comes back out: the id may sit on the feature (where GeoJSON
 * puts it) or in `properties[idField]`, `properties` may be null, and a third
 * coordinate is allowed and ignored. The geometry must be a Point.
 */
export interface InputPointFeature<P = Record<string, unknown>> {
  type: 'Feature';
  id?: DeviceId;
  properties: P | null;
  geometry: {
    type: 'Point';
    /** [longitude, latitude] or [longitude, latitude, altitude]. */
    coordinates: [number, number] | [number, number, number] | number[];
  };
}

export interface InputFeatureCollection<P = Record<string, unknown>> {
  type: 'FeatureCollection';
  features: Array<InputPointFeature<P>>;
}

export interface LoadOptions {
  /**
   * 'throw' (default) stops at the first feature that cannot be read, naming its
   * index. 'skip' ingests everything that parses; compare the return value with
   * the input length to see how much was dropped.
   */
  onError?: 'throw' | 'skip';
}

/** Narrow a feature to a cluster. */
export declare function isCluster<P>(f: NetClusterFeature<P>): f is ClusterFeature;

export interface Tile<P = Record<string, unknown>> {
  features: Array<{
    type: 1;
    geometry: Array<[number, number]>;
    tags: ClusterProperties | P;
  }>;
}

export interface NetClusterStats {
  inserts: number;
  removes: number;
  moves: number;
  /** Moves that needed no structural repair. */
  movesFast: number;
  /** Moves that required a local repair. */
  movesRebuilt: number;
  promotions: number;
  reparents: number;
  probes: number;
}

export declare class NetCluster<P = Record<string, unknown>> {
  constructor(options?: NetClusterOptions);

  readonly minZoom: number;
  readonly maxZoom: number;
  readonly radius: number;
  readonly extent: number;
  readonly hysteresis: number;
  readonly categories: number;
  /** True when aggregates use the dense layout; see `denseCells`. */
  readonly dense: boolean;
  /** Number of live points. */
  readonly size: number;
  readonly stats: NetClusterStats;

  /** Is a point with this id currently in the index? */
  has(id: DeviceId): boolean;

  /** Add a point. If the id already exists this moves it instead. */
  insert(id: DeviceId, lng: number, lat: number, props?: P): number;

  /** Report a new position. Inserts if the id is unknown. */
  moveTo(id: DeviceId, lng: number, lat: number, props?: P): number;

  /**
   * Insert one GeoJSON Feature; moves it if the id is already known.
   *
   * The wrapper, its geometry and its coordinates array are read and dropped --
   * only `properties` is retained, exactly as `insert` retains it.
   */
  insertFeature(feature: InputPointFeature<P>): number;

  /** Report a new position for one GeoJSON Feature. Inserts if the id is new. */
  moveToFeature(feature: InputPointFeature<P>): number;

  /**
   * Ingest a FeatureCollection, an array of Features, or one Feature.
   *
   * **Upserts** rather than replacing, and does not retain the input.
   *
   * @returns how many features were ingested.
   */
  load(
    data: InputFeatureCollection<P> | Array<InputPointFeature<P>> | InputPointFeature<P>,
    options?: LoadOptions,
  ): number;

  /** @returns true if the point existed. */
  remove(id: DeviceId): boolean;

  /**
   * Clusters whose marker falls inside `bbox` at `zoom`.
   * @param filter with `categories` enabled, a category index; with `dimensions`,
   *   an object naming exactly the dimensions of one declared filter shape, e.g.
   *   `{ client: 7, status: 'enroute' }`. Omit for everything.
   */
  getClusters(bbox: BBox, zoom: number, filter?: FilterSelector): Array<NetClusterFeature<P>>;

  /**
   * The same features `getClusters` returns, wrapped as a FeatureCollection --
   * the shape `setData()` and `L.geoJSON()` want.
   */
  getFeatureCollection(bbox: BBox, zoom: number, filter?: FilterSelector): NetClusterFeatureCollection<P>;

  /**
   * Every live point as a FeatureCollection, unclustered, in insertion order.
   * For export, not for drawing: it materialises one object per point.
   */
  toGeoJSON(): NetClusterFeatureCollection<P>;

  /** Clusters for one Web-Mercator tile, in tile-extent coordinates. */
  getTile(z: number, x: number, y: number): Tile<P> | null;

  /**
   * The sub-clusters one expansion step below a cluster.
   * @param clusterId from `properties.cluster_id`. Passing a device id throws.
   */
  getChildren(clusterId: number | string): Array<NetClusterFeature<P>>;

  /** The individual points inside a cluster. */
  getLeaves(clusterId: number | string, limit?: number, offset?: number): Array<SinglePointFeature<P>>;

  /** The zoom at which a cluster first splits. */
  getClusterExpansionZoom(clusterId: number | string): number;

  /** Which cluster a device is drawn inside at `zoom`; -1 if unknown. */
  representative(id: DeviceId, zoom: number): number;

  /** Approximate heap footprint in bytes. */
  memoryBytes(): number;

  /**
   * Live aggregate entries — what the filter is actually costing, as opposed to
   * what it could cost. Zero when no dimensions are declared.
   */
  aggEntries(): number;

  /** Total (centre, level) listings held by the grid. */
  gridEntries(): number;
}

/** Fixed-point world units: 2^30. */
export declare const PREC: number;

/** Project lng/lat to the fixed-point Web-Mercator grid the index works in. */
export declare function project(lng: number, lat: number): [number, number];

/** Typed-array open-addressed hash map used by the grid. Exported for reuse. */
export declare class CellHash {
  constructor(initialCapacity?: number);
  get(key: number): number;
  set(key: number, val: number): void;
  delete(key: number): boolean;
  readonly size: number;
  bytes(): number;
}
