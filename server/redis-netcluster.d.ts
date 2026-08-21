/**
 * NetCluster backed by Redis — the index lives in Redis, Node stays stateless.
 * https://github.com/renatex314/NetCluster
 */
import type { BBox, DeviceId, NetClusterFeature } from '../src/index.js';

/**
 * The slice of an ioredis client this uses. Typed structurally so the package
 * does not require ioredis' types to be installed — it is an optional peer.
 */
export interface RedisLike {
  defineCommand(name: string, opts: { numberOfKeys: number; lua: string }): void;
  pipeline(): { exec(): Promise<Array<[Error | null, unknown]>> } & Record<string, any>;
  call(command: string, ...args: any[]): Promise<any>;
  [command: string]: any;
}

export interface RedisNetClusterOptions {
  /** Key prefix. Default 'nc'. Use a distinct one per index. */
  prefix?: string;
  radius?: number;
  extent?: number;
  maxZoom?: number;
  hysteresis?: number;
  /**
   * A client pointed at a read replica. Queries go there via EVALSHA_RO, which
   * Redis refuses to let write, so reads cost the write primary nothing.
   */
  readFrom?: RedisLike;
  /**
   * Upserts per pipeline. Redis finishes a whole pipeline before serving anyone
   * else, so this is the head-of-line delay other clients see. Default 25.
   */
  maxPipeline?: number;
}

/** 0 unchanged · 1 inserted · 2 moved · 3 moved with a local repair. */
export type UpsertResult = 0 | 1 | 2 | 3;

export interface RedisNetClusterStats {
  count: number;
  /** |C_z| for each zoom level. */
  centersPerLevel: number[];
}

export declare class RedisNetCluster<P = Record<string, unknown>> {
  constructor(redis: RedisLike, options?: RedisNetClusterOptions);

  readonly prefix: string;
  readonly radius: number;
  readonly extent: number;
  readonly maxZoom: number;
  readonly hysteresis: number;
  readonly maxPipeline: number;

  /**
   * Publish the geometry every pod must agree on. Safe to call from all of them;
   * a pod started with a different `radius` rejects instead of corrupting.
   */
  init(): Promise<this>;

  /** Insert or move — the same call. */
  upsert(id: DeviceId, lng: number, lat: number): Promise<UpsertResult>;

  /** Bulk upsert, split into pipelines of `maxPipeline`. */
  upsertMany(points: Array<{ id: DeviceId; lng: number; lat: number }>): Promise<UpsertResult[]>;

  /** @returns 1 if the point existed, 0 otherwise. */
  remove(id: DeviceId): Promise<0 | 1>;

  getClusters(bbox: BBox, zoom: number, limit?: number): Promise<Array<NetClusterFeature<P>>>;

  /** Which cluster a device is drawn inside; null if unknown. */
  representative(id: DeviceId, zoom: number): Promise<string | null>;

  /** Is a device with this id currently in the index? */
  has(id: DeviceId): Promise<boolean>;

  size(): Promise<number>;

  /** Debug only: SCANs the keyspace, cost is O(keys). */
  stats(): Promise<RedisNetClusterStats>;

  /** Delete the whole index. */
  drop(): Promise<void>;
}
