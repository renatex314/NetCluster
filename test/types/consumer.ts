// Compiled under `strict` by `npm run test:types`. It is not run, only checked:
// if the published typings drift from the API, this stops compiling.
import { NetCluster, isCluster, project, PREC } from '../../src/index.js';
import type { BBox, NetClusterFeature, ClusterFeature } from '../../src/index.js';
import { RedisNetCluster } from '../../server/redis-netcluster.js';
import type { RedisLike, UpsertResult } from '../../server/redis-netcluster.js';

interface Vehicle { plate: string; status: number }

const index = new NetCluster<Vehicle>({ radius: 40, maxZoom: 16, categories: 4 });

index.insert('v1', -46.63, -23.55, { plate: 'ABC-1234', status: 2 });
index.insert(42, -46.63, -23.55, { plate: 'XYZ-9', status: 0 });
index.moveTo('v1', -46.64, -23.56);
const gone: boolean = index.remove('v1');

const bbox: BBox = [-47, -24, -46, -23];
const features: Array<NetClusterFeature<Vehicle>> = index.getClusters(bbox, 11);
const filtered = index.getClusters(bbox, 11, 2);

// the type guard must narrow both ways
for (const f of features) {
  if (isCluster(f)) {
    const n: number = f.properties.point_count;
    const id: number = f.properties.cluster_id;
    void n; void id;
  } else {
    const plate: string = f.properties.plate;   // narrowed to the point feature
    void plate;
  }
}

const cluster = features.find(isCluster) as ClusterFeature | undefined;
if (cluster) {
  const z: number = index.getClusterExpansionZoom(cluster.properties.cluster_id);
  const kids = index.getChildren(cluster.properties.cluster_id);
  const leaves = index.getLeaves(cluster.properties.cluster_id, 10);
  const firstPlate: string = leaves[0].properties.plate;
  void z; void kids; void firstPlate;
}

const marker: number = index.representative('v1', 11);
const tile = index.getTile(11, 758, 1161);
const tileCount: number = tile ? tile.features.length : 0;
const size: number = index.size;
const fast: number = index.stats.movesFast;
const [x, y]: [number, number] = project(-46.63, -23.55);
void gone; void filtered; void marker; void tileCount; void size; void fast; void x; void y; void PREC;

// --- redis side ---------------------------------------------------------------
declare const redis: RedisLike;
const remote = new RedisNetCluster<Vehicle>(redis, { prefix: 'nc', maxPipeline: 25 });

async function useRemote(): Promise<void> {
  await remote.init();
  const r: UpsertResult = await remote.upsert('v1', -46.63, -23.55);
  await remote.upsertMany([{ id: 'v2', lng: -46.6, lat: -23.5 }]);
  const clusters = await remote.getClusters(bbox, 11);
  const rep: string | null = await remote.representative('v1', 11);
  const n: number = await remote.size();
  void r; void clusters; void rep; void n;
}
void useRemote;

// has(): the existence check, on both backends
{
  const idx = new NetCluster<{ status: number }>({ maxZoom: 16 });
  const present: boolean = idx.has('truck-1');
  const numeric: boolean = idx.has(42);
  void present; void numeric;
  // @ts-expect-error -- has() takes an id, not a cluster id object
  idx.has({ id: 1 });
}

// --- GeoJSON ingest ---------------------------------------------------------
import type {
  InputPointFeature, InputFeatureCollection, NetClusterFeatureCollection,
} from '../../src/index.js';

const gjIndex = new NetCluster<Vehicle>({ idField: 'plate', categories: 4 });

const one: InputPointFeature<Vehicle> = {
  type: 'Feature',
  id: 'v9',
  properties: { plate: 'ABC-1234', status: 1 },
  geometry: { type: 'Point', coordinates: [-46.63, -23.55] },
};
const slot: number = gjIndex.insertFeature(one);
gjIndex.moveToFeature(one);

const fc: InputFeatureCollection<Vehicle> = { type: 'FeatureCollection', features: [one] };
const loaded: number = gjIndex.load(fc);
gjIndex.load([one]);
gjIndex.load(one);
gjIndex.load(fc, { onError: 'skip' });

// properties may be null, and a third coordinate is allowed
gjIndex.load([{ type: 'Feature', id: 1, properties: null,
                geometry: { type: 'Point', coordinates: [0, 0, 120] } }]);

const collection: NetClusterFeatureCollection<Vehicle> = gjIndex.getFeatureCollection(bbox, 11, 2);
const dump: NetClusterFeatureCollection<Vehicle> = gjIndex.toGeoJSON();
for (const f of collection.features) {
  if (isCluster(f)) { const c: number = f.properties.point_count; void c; }
  else { const plate: string = f.properties.plate; void plate; }
}
void slot; void loaded; void dump;

// --- GeoJSON through the Redis backend --------------------------------------
declare const redisLike: RedisLike;
const rIndex = new RedisNetCluster(redisLike, { idField: 'plate' });
const rLoaded: Promise<number> = rIndex.load(fc);
void rLoaded;
