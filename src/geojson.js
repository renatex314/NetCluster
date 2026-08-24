/**
 * GeoJSON ingest.
 *
 * NetCluster's own API takes flat arguments -- an id, two numbers, an optional
 * properties object -- because that is what a database row or a websocket frame
 * already looks like, and because a point then costs exactly its bytes: the
 * coordinates go straight into typed arrays and no wrapper object is created.
 *
 * GeoJSON is what the rest of the mapping ecosystem speaks. This module reads it
 * *without adopting it*: the Feature wrapper, its `geometry` object and its
 * `coordinates` array are read once and dropped on the floor. The only thing
 * retained is `properties`, and only because the flat path retains it too.
 *
 * So steady-state memory after `load()` is identical to the flat path -- you pay
 * GeoJSON's object overhead while parsing, not for as long as the index lives.
 * What makes that possible is that queries build their own result features from
 * the arena rather than handing your objects back, so nothing downstream needs
 * the input to stay alive: once `load()` returns, the wrappers are garbage.
 */

/**
 * Read one Feature into `out` = [id, lng, lat, props].
 *
 * Writes into a caller-owned scratch array rather than returning an object: at
 * half a million features, one short-lived object each is exactly the kind of
 * allocation this library exists to avoid.
 *
 * `where` names the feature in any error -- "feature" for the single-feature
 * entry points, "features[8123]" from load(), which is the difference between a
 * fixable error and a bisect through a 200 MB file.
 */
export function readFeature(f, idField, out, where) {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) {
    throw new TypeError(
      `netcluster: ${where} is ${f === null ? 'null' : Array.isArray(f) ? 'an array' : typeof f}, ` +
      `expected a GeoJSON Feature`);
  }
  if (f.type !== undefined && f.type !== 'Feature') {
    throw new TypeError(f.type === 'FeatureCollection'
      ? `netcluster: ${where} is a FeatureCollection, not a Feature. Pass it to load() instead.`
      : `netcluster: ${where} has type ${JSON.stringify(f.type)}, expected "Feature"`);
  }

  const g = f.geometry;
  if (g === null || typeof g !== 'object') {
    throw new TypeError(
      `netcluster: ${where} has ${g === null ? 'a null' : 'no'} geometry. ` +
      `A null-geometry Feature has no position to cluster.`);
  }
  if (g.type !== 'Point') {
    throw new TypeError(
      `netcluster: ${where} has a ${JSON.stringify(g.type)} geometry, expected "Point". ` +
      `NetCluster clusters positions; reduce areas and lines to a representative ` +
      `point (a centroid, say) before loading them.`);
  }
  const c = g.coordinates;
  if (!Array.isArray(c) || c.length < 2) {
    throw new TypeError(`netcluster: ${where} has no [longitude, latitude] coordinates`);
  }
  // A third element is altitude, which GeoJSON allows and clustering ignores.
  const lng = c[0], lat = c[1];
  if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new TypeError(
      `netcluster: ${where} has non-numeric coordinates [${JSON.stringify(c[0])}, ${JSON.stringify(c[1])}]`);
  }
  // GeoJSON is [longitude, latitude] -- the reverse of how coordinates are
  // spoken and written almost everywhere else, and comfortably the most common
  // mistake in a hand-built FeatureCollection. Web Mercator clamps latitude, so
  // without this a swapped pair does not fail, it silently lands the point at a
  // pole. Only catches the swap when it puts a longitude past +-90 in the
  // latitude slot; a swapped Sao Paulo is two in-range numbers and no check can
  // tell. That still covers most of the world.
  if (lat < -90 || lat > 90) {
    throw new RangeError(
      `netcluster: ${where} has latitude ${lat}, which is outside [-90, 90]. ` +
      `GeoJSON coordinates are [longitude, latitude] -- are yours the other way round?`);
  }

  let props = f.properties;
  if (props === null) props = undefined;          // GeoJSON's "no properties"
  if (props !== undefined && (typeof props !== 'object' || Array.isArray(props))) {
    throw new TypeError(
      `netcluster: ${where} has ${Array.isArray(props) ? 'an array' : `a ${typeof props}`} ` +
      `for properties, expected an object or null`);
  }

  let id = f.id;
  if (id === undefined && props !== undefined) id = props[idField];
  if (id === undefined || id === null) {
    throw new TypeError(
      `netcluster: ${where} has no id. Put it on the feature ("id": "vehicle-7", which is ` +
      `where GeoJSON says it goes) or in properties.${idField}, or set the idField option ` +
      `to name the property that holds it.`);
  }

  out[0] = id; out[1] = lng; out[2] = lat; out[3] = props;
  return out;
}

/**
 * The feature array of a FeatureCollection, an array of Features, or a lone
 * Feature wrapped in one. Returns the array and a label to build error messages
 * from.
 */
export function featuresOf(data) {
  if (data === null || typeof data !== 'object') {
    throw new TypeError(
      `netcluster: load() takes a GeoJSON FeatureCollection, an array of Features, or one ` +
      `Feature; got ${data === null ? 'null' : typeof data}`);
  }
  if (Array.isArray(data)) return [data, 'features'];
  if (data.type === 'Feature') return [[data], 'features'];
  const fs = data.features;
  if (!Array.isArray(fs)) {
    throw new TypeError(data.type === undefined
      ? `netcluster: load() got an object with no "features" array. A FeatureCollection ` +
        `looks like { "type": "FeatureCollection", "features": [...] }.`
      : `netcluster: load() got type ${JSON.stringify(data.type)}. It takes a ` +
        `FeatureCollection, an array of Features, or one Feature.`);
  }
  return [fs, 'features'];
}
