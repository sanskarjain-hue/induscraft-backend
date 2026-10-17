/**
 * photoData.js
 *
 * Legacy orders contain photos saved as base64 text INSIDE the order document
 * (photo.data), in the five per-item photo arrays. Those orders are 1-15 MB each,
 * which made "load every order" (GET /api/orders) so heavy that the app could not
 * finish loading. This module:
 *
 *   1. lets the order LIST (and the PUT response) leave photo.data out, and
 *   2. makes sure a SAVE can never erase that data just because the client did not
 *      send it back. Without (2), (1) would permanently delete photos whose
 *      embedded copy is the only copy.
 *
 * Switch: set the environment variable STRIP_PHOTO_DATA=false to send photo data
 * again exactly as before. The save guard (2) always stays on; it is a no-op when
 * the client does send the data.
 */

const PHOTO_FIELDS = ["images", "measurementPhotos", "rawPhotos", "finishingPhotos", "qcPhotos"];

const stripEnabled = () => String(process.env.STRIP_PHOTO_DATA || "true").toLowerCase() !== "false";

// MongoDB projection: exclude photo.data inside every item's five photo arrays.
// { "items.images.data": 0, "items.measurementPhotos.data": 0, ... }
const STRIP_PROJECTION = Object.fromEntries(PHOTO_FIELDS.map(f => [`items.${f}.data`, 0]));

/** Map of photo _id (string) -> embedded base64 data, for every photo in a stored order. */
function buildDataIndex(storedOrder) {
  const index = new Map();
  for (const item of (storedOrder && storedOrder.items) || []) {
    for (const f of PHOTO_FIELDS) {
      for (const photo of (item && item[f]) || []) {
        if (photo && photo._id != null && typeof photo.data === "string" && photo.data.length > 0) {
          index.set(String(photo._id), photo.data);
        }
      }
    }
  }
  return index;
}

/**
 * Save guard. For every photo in the incoming `items` that has an _id matching a stored
 * photo, but arrives WITHOUT its data, put the stored data back before the order is saved.
 * Photos with no _id (new uploads) are left alone. A photo that is simply absent from the
 * incoming array is treated as deleted by the user, exactly as before.
 * Mutates `items` in place. Returns counts for logging.
 */
function restorePhotoData(items, storedOrder) {
  const result = { restored: 0, storedWithData: 0, absentFromPayload: 0 };
  if (!Array.isArray(items)) return result;
  const index = buildDataIndex(storedOrder);
  result.storedWithData = index.size;
  if (!index.size) return result;

  const seen = new Set();
  for (const item of items) {
    for (const f of PHOTO_FIELDS) {
      const arr = item && item[f];
      if (!Array.isArray(arr)) continue;
      for (const photo of arr) {
        if (!photo || typeof photo !== "object" || photo._id == null) continue;
        const key = String(photo._id);
        seen.add(key);
        if (!photo.data) {
          const stored = index.get(key);
          if (stored) { photo.data = stored; result.restored++; }
        }
      }
    }
  }
  for (const key of index.keys()) if (!seen.has(key)) result.absentFromPayload++;
  return result;
}

/** Removes photo.data from the five photo arrays of every item, in place, on a plain object. */
function stripPhotoDataInPlace(items) {
  if (!Array.isArray(items)) return items;
  for (const item of items) {
    for (const f of PHOTO_FIELDS) {
      const arr = item && item[f];
      if (!Array.isArray(arr)) continue;
      for (const photo of arr) if (photo && typeof photo === "object") delete photo.data;
    }
  }
  return items;
}

/** What to send the client for a single saved order: the document itself, or a copy without photo.data. */
function clientView(order) {
  if (!stripEnabled()) return order;
  const out = typeof order.toJSON === "function" ? order.toJSON() : JSON.parse(JSON.stringify(order));
  stripPhotoDataInPlace(out.items);
  return out;
}

module.exports = { PHOTO_FIELDS, STRIP_PROJECTION, stripEnabled, restorePhotoData, stripPhotoDataInPlace, clientView, buildDataIndex };
