export { NetCluster, project, PREC } from './netcluster.js';
export { CellHash } from './cellhash.js';

/** Type guard: is this feature a cluster rather than a single point? */
export const isCluster = (f) => f != null && f.properties != null && f.properties.cluster === true;
