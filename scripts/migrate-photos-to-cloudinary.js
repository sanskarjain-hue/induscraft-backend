/**
 * migrate-photos-to-cloudinary.js
 *
 * Moves photos that are stored INSIDE orders as base64 text (photo.data) to Cloudinary, one photo
 * at a time, and removes the embedded copy only after the upload has been proven identical.
 * Replaces the old scripts/migrateImages.js, which must not be run.
 *
 *   node scripts/migrate-photos-to-cloudinary.js                       DRY RUN: changes nothing, uploads nothing
 *   node scripts/migrate-photos-to-cloudinary.js --apply --limit 1 --smallest      first real test: 1 small photo
 *   node scripts/migrate-photos-to-cloudinary.js --apply --only BL-0865            one order
 *   node scripts/migrate-photos-to-cloudinary.js --apply                           everything
 *
 * Options: --limit N   --smallest   --only <order id like BL-0865>   --max-failures N (default 5)
 *          --pause-ms N (pause between orders, default 300)
 *          --backup <file> (repeatable; default: every orders-*.ndjson in ~/induscraft-backups)
 *          --backend <url> (default: the Railway URL; used to confirm the save guard is live)
 *
 * SAFETY RULES (each one is enforced in code and covered by tests):
 *  1. A photo's embedded copy is only touched if an earlier backup file contains that exact photo
 *     (same _id, same byte length and same SHA-256). Anything else is skipped and reported.
 *  2. Nothing is deleted until the uploaded copy has been checked twice: Cloudinary reports the same
 *     number of bytes as the original AND a fresh download of the uploaded file has the same SHA-256.
 *  3. The database is updated for that single photo only (url, publicId set; data removed), using an
 *     atomic positional update. The rest of the order is never rewritten, so a concurrent edit cannot
 *     be overwritten. If the photo changed meanwhile, the update simply does not match and is reported.
 *  4. It never deletes anything from Cloudinary and never deletes or replaces an order.
 *  5. --apply refuses to run unless the live backend reports save-guard version 2 (so a save made
 *     from a stale browser tab cannot wipe a freshly migrated photo).
 *  6. Safe to stop and re-run at any time: migrated photos are no longer candidates, and uploads use a
 *     fixed public id (the photo's own _id) so a repeat never creates duplicates.
 *
 * GENTLE ON THE DATABASE: it works order by order (one read of the order, then at most one write per 25 photos,
 * then one small verification read), pauses between orders, puts a time limit on every call, and stops by itself
 * if the database answers slowly three times. It never goes through the Railway server.
 *
 * Run it when nobody is using the OMS. Exit codes: 0 = done / nothing failed, 1 = some photos failed,
 * 2 = could not start (setup or safety check failed).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { PHOTO_FIELDS } = require("./analyze-backup");

const DEFAULT_BACKEND = "https://induscraft-backend-production.up.railway.app";
const REQUIRED_GUARD_VERSION = 2;
const IMAGE_MAX_BYTES = 9.5 * 1024 * 1024; // Cloudinary free plan: 10 MB per image
const VIDEO_MAX_BYTES = 95 * 1024 * 1024; // ... and 100 MB per video
const UPLOAD_ATTEMPTS = 3;

const mb = b => (b / 1024 / 1024).toFixed(2) + " MB";
const sha256 = x => crypto.createHash("sha256").update(x).digest("hex");
const hex = id => String(id);
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

// ───────────────────────── database queries (server-side; they never send photo data except fetchPhoto) ─────────────────────────

// Per order: every photo's _id, type, name, its embedded-data size in BYTES, and whether it already has a url.
const listingPipeline = id => [
  { $match: { _id: id } },
  {
    $project: {
      _id: 0,
      id: 1,
      items: {
        $map: {
          input: { $ifNull: ["$items", []] },
          as: "it",
          in: Object.assign(
            { _id: "$$it._id" },
            Object.fromEntries(PHOTO_FIELDS.map(f => [f, {
              $map: {
                input: { $ifNull: ["$$it." + f, []] },
                as: "p",
                in: {
                  _id: "$$p._id", type: "$$p.type", name: "$$p.name",
                  bytes: { $cond: [{ $eq: [{ $type: "$$p.data" }, "string"] }, { $strLenBytes: "$$p.data" }, 0] },
                  url: "$$p.url",
                  hasUrl: { $cond: [{ $and: [{ $eq: [{ $type: "$$p.url" }, "string"] }, { $gt: [{ $strLenBytes: "$$p.url" }, 0] }] }, true, false] },
                },
              },
            }]))
          ),
        },
      },
    },
  },
];

// One photo, found by its _id (not by position, so a concurrent edit cannot make us pick the wrong one).
const photoPipeline = (orderId, itemId, field, photoId) => [
  { $match: { _id: orderId } },
  {
    $project: {
      _id: 0,
      p: {
        $let: {
          vars: { it: { $arrayElemAt: [{ $filter: { input: { $ifNull: ["$items", []] }, as: "i", cond: { $eq: ["$$i._id", itemId] } } }, 0] } },
          in: { $arrayElemAt: [{ $filter: { input: { $ifNull: ["$$it." + field, []] }, as: "p", cond: { $eq: ["$$p._id", photoId] } } }, 0] },
        },
      },
    },
  },
];

// ───────────────────────── backup index ─────────────────────────

/** Reads every backup file and records, for each photo that has embedded data: byte length + SHA-256. */
async function buildBackupIndex(files, EJSON) {
  const photos = new Map(); // photoId -> { bytes, sha256, file }
  const orders = new Set();
  const conflicts = [];
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const order = EJSON.parse(line);
      orders.add(hex(order._id));
      for (const item of order.items || []) {
        for (const f of PHOTO_FIELDS) {
          for (const p of item[f] || []) {
            if (!p || p._id == null || typeof p.data !== "string" || !p.data.length) continue;
            const entry = { bytes: Buffer.byteLength(p.data), sha256: sha256(p.data), file: path.basename(file) };
            const prev = photos.get(hex(p._id));
            if (prev && prev.sha256 !== entry.sha256) conflicts.push({ photoId: hex(p._id), a: prev.file, b: entry.file });
            else if (!prev) photos.set(hex(p._id), entry);
          }
        }
      }
    }
  }
  return { photos, orders, conflicts };
}

// ───────────────────────── core ─────────────────────────

// LOAD CONTROL. Opening a photo means the database must load the WHOLE order (a few of yours are ~14 MB), so
// the work is done order by order, not photo by photo:
//   one read of the order  ->  upload + verify all its photos  ->  one write per batch of up to BATCH_SIZE photos
//   ->  one small verification read.
// On top of that: a pause between orders, a time limit on every call, and a circuit breaker that stops the run
// by itself if the database starts answering slowly.
const BATCH_SIZE = 25;
const SLOW_MS = 30000;
const MAX_SLOW_CALLS = 3;

/** Wraps database calls: counts them, notices slow ones, and tells the loop when to stop. */
function makeDb({ now = Date.now, sleep = defaultSleep, slowMs = SLOW_MS, maxSlow = MAX_SLOW_CALLS, log }) {
  const stats = { reads: 0, writes: 0, slow: 0 };
  const timed = async (kind, fn) => {
    const t0 = now();
    try { return await fn(); } finally {
      stats[kind]++;
      const dt = now() - t0;
      if (dt > slowMs) {
        stats.slow++;
        log(`      database call took ${(dt / 1000).toFixed(0)}s (slow call ${stats.slow} of ${maxSlow})`);
        await sleep(Math.min(dt, 60000)); // give the database time to recover
      }
    }
  };
  return { stats, read: fn => timed("reads", fn), write: fn => timed("writes", fn), shouldStop: () => stats.slow >= maxSlow };
}

/** Lists every photo that has embedded data and no url, with its size on the server. No photo data is transferred. */
async function listCandidates(col, db, log, sleep, pauseMs) {
  const ids = (await db.read(() => col.find({}, { projection: { _id: 1 }, hint: { _id: 1 }, sort: { _id: 1 }, maxTimeMS: 60000 }).toArray())).map(d => d._id);
  const candidates = [];
  let photosSeen = 0;
  for (const orderId of ids) {
    if (db.shouldStop()) break;
    const rows = await db.read(() => col.aggregate(listingPipeline(orderId), { maxTimeMS: 120000 }).toArray());
    if (rows.length) {
      const { id: displayId, items } = rows[0];
      for (const item of items || []) {
        for (const field of PHOTO_FIELDS) {
          for (const p of item[field] || []) {
            photosSeen++;
            if (p.bytes > 0 && !p.hasUrl) candidates.push({ orderId, displayId: displayId || hex(orderId), itemId: item._id, field, photoId: p._id, bytes: p.bytes, type: p.type, name: p.name });
          }
        }
      }
    }
    if (pauseMs) await sleep(pauseMs);
  }
  log(`Scanned ${ids.length} orders and ${photosSeen} photos; ${candidates.length} have embedded data and no Cloudinary url.`);
  return { candidates, orders: ids.length, photosSeen };
}

function parseDataUri(data) {
  const m = /^data:([^;,]+);base64,/.exec(data);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const b64 = data.slice(m[0].length).replace(/\s+/g, "");
  const buffer = Buffer.from(b64, "base64");
  if (!buffer.length || buffer.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) return null; // not valid base64
  return { mime, buffer };
}

async function withRetries(label, fn, log, sleep, attempts = UPLOAD_ATTEMPTS) {
  for (let a = 1; ; a++) {
    try { return await fn(); } catch (err) {
      if (a >= attempts) throw err;
      log(`      retry ${a}/${attempts - 1} (${label}): ${err.message}`);
      await sleep(2000 * a);
    }
  }
}

/** Reads one order ONCE and returns Map(photoId -> embedded data string); null if that read fails (caller falls back). */
async function loadOrderPhotoData(col, db, orderId, log, sleep) {
  try {
    const doc = await withRetries("read order", () => db.read(() => col.findOne({ _id: orderId }, { projection: { id: 1, items: 1 }, maxTimeMS: 300000 })), log, sleep, 2);
    if (!doc) return new Map();
    const map = new Map();
    for (const item of doc.items || []) for (const f of PHOTO_FIELDS) for (const p of item[f] || []) if (p && typeof p.data === "string" && p.data.length) map.set(hex(p._id), p.data);
    return map;
  } catch (err) {
    log(`      could not read the whole order (${err.message}); fetching its photos one at a time instead`);
    return null;
  }
}

/** One write for a batch of photos of the SAME order. Each photo has its own array filter, so each only changes if it is still untouched. */
function batchUpdateFor(orderId, list) {
  const set = {}, unset = {}, arrayFilters = [];
  list.forEach((v, k) => {
    const base = `items.$[i${k}].${v.c.field}.$[p${k}]`;
    set[`${base}.url`] = v.url; set[`${base}.publicId`] = v.publicId; unset[`${base}.data`] = "";
    arrayFilters.push({ [`i${k}._id`]: v.c.itemId }, { [`p${k}._id`]: v.c.photoId, [`p${k}.data`]: { $type: "string" }, [`p${k}.url`]: { $in: [null, ""] } });
  });
  return { filter: { _id: orderId }, update: { $set: set, $unset: unset }, options: { arrayFilters } };
}

/**
 * deps: { col, backup, upload(buffer, {publicId}) -> cloudinary result, download(url) -> Buffer, report(entry), log, sleep, now }
 * opts: { apply, limit, smallest, only, maxFailures, pauseMs, slowMs, maxSlow }
 */
async function migrate({ col, backup, upload, download, report = () => {}, log = console.log, sleep = defaultSleep, now = Date.now }, opts = {}) {
  const pauseMs = opts.pauseMs === undefined ? 300 : opts.pauseMs;
  const maxFailures = opts.maxFailures || 5;
  const db = makeDb({ now, sleep, slowMs: opts.slowMs || SLOW_MS, maxSlow: opts.maxSlow || MAX_SLOW_CALLS, log });
  const { candidates: all, orders, photosSeen } = await listCandidates(col, db, log, sleep, Math.min(pauseMs, 100));
  const summary = { orders, photosSeen, candidates: all.length, ready: 0, migrated: 0, failed: 0, skipped: 0, bytesMigrated: 0, skippedReasons: {}, wouldMigrateBytes: 0, aborted: false, abortReason: null, dbCalls: db.stats };
  const skip = (c, reason) => { summary.skipped++; summary.skippedReasons[reason] = (summary.skippedReasons[reason] || 0) + 1; report({ status: "skipped", reason, order: c.displayId, field: c.field, photoId: hex(c.photoId), bytes: c.bytes }); log(`  skip  ${c.displayId} ${c.field} ${mb(c.bytes)}: ${reason}`); };
  const stopIfSlow = () => { if (db.shouldStop()) { summary.aborted = true; summary.abortReason = `the database answered slowly ${db.stats.slow} times (over ${SLOW_MS / 1000}s each), so the run stopped by itself to avoid slowing the live app. Nothing is half-done; run it again later.`; return true; } return false; };
  if (db.shouldStop()) { stopIfSlow(); return summary; }

  // Rule 1 (part 1): the photo must exist in a backup with the same size. (The SHA-256 is checked on the real data when applying.)
  let work = [];
  for (const c of all) {
    if (opts.only && c.displayId !== opts.only && hex(c.orderId) !== opts.only) continue;
    const b = backup.photos.get(hex(c.photoId));
    if (!b) { skip(c, "not found in any backup file"); continue; }
    if (b.bytes !== c.bytes) { skip(c, `size differs from backup (database ${c.bytes} bytes, backup ${b.bytes} bytes)`); continue; }
    work.push(c);
  }
  if (opts.smallest) work.sort((a, b) => a.bytes - b.bytes);
  if (opts.limit > 0) work = work.slice(0, opts.limit);
  summary.ready = work.length;
  summary.wouldMigrateBytes = work.reduce((s, c) => s + c.bytes, 0);

  if (!opts.apply) {
    const byType = {};
    for (const c of work) { const t = (/^image\//.test(c.type || "") ? "image" : /^video\//.test(c.type || "") ? "video" : c.type || "unknown"); byType[t] = (byType[t] || 0) + 1; }
    log(`\nDRY RUN: ${work.length} photo(s), ${mb(summary.wouldMigrateBytes)}, would be moved to Cloudinary (${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}). Nothing was changed.`);
    for (const c of work.slice(0, 5)) log(`  e.g. ${c.displayId}  ${c.field}  ${mb(c.bytes)}  ${c.type || ""}`);
    for (const c of work) report({ status: "ready", order: c.displayId, field: c.field, photoId: hex(c.photoId), bytes: c.bytes, type: c.type });
    return summary;
  }

  // group by order, keeping the order the work was sorted in
  const groups = new Map();
  for (const c of work) { const k = hex(c.orderId); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }

  let n = 0;
  const total = work.length;
  const failC = (c, label, reason, extra = {}) => {
    summary.failed++;
    report({ status: "failed", reason, order: c.displayId, field: c.field, photoId: hex(c.photoId), bytes: c.bytes, ...extra });
    log(`${label}  FAILED: ${reason}`);
    if (summary.failed >= maxFailures) { summary.aborted = true; summary.abortReason = `${summary.failed} photos failed; stopped. See the messages above.`; }
  };

  for (const [, cands] of groups) {
    if (summary.aborted || stopIfSlow()) break;
    const orderId = cands[0].orderId;
    const dataMap = await loadOrderPhotoData(col, db, orderId, log, sleep); // ONE read of the order
    const verified = []; // photos uploaded and proven identical, waiting for the database write

    for (const c of cands) {
      n++;
      const label = `[${n}/${total}] ${c.displayId} ${c.field} ${mb(c.bytes)}`;
      if (summary.aborted) break;
      try {
        let data = dataMap ? dataMap.get(hex(c.photoId)) : undefined;
        if (!dataMap) { // fallback: this one photo only
          const rows = await withRetries("fetch photo", () => db.read(() => col.aggregate(photoPipeline(c.orderId, c.itemId, c.field, c.photoId), { maxTimeMS: 300000 }).toArray()), log, sleep);
          data = rows[0] && rows[0].p && rows[0].p.data;
        }
        if (typeof data !== "string" || !data.length) { skip(c, "photo no longer has embedded data (changed since the scan)"); continue; }

        // Rule 1 (part 2): identical to the backup, byte for byte
        const b = backup.photos.get(hex(c.photoId));
        if (sha256(data) !== b.sha256) { skip(c, "content differs from the backup (changed since it was taken)"); continue; }

        const parsed = parseDataUri(data);
        if (!parsed) { skip(c, "embedded data is not a valid base64 data URI"); continue; }
        const kind = parsed.mime.startsWith("image/") ? "image" : parsed.mime.startsWith("video/") ? "video" : null;
        if (!kind) { skip(c, `unsupported type ${parsed.mime}`); continue; }
        if (parsed.buffer.length > (kind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES)) { skip(c, `too large for Cloudinary's free plan (${mb(parsed.buffer.length)} ${kind})`); continue; }

        // Rule 2: two independent checks of the uploaded copy
        const result = await withRetries("upload", () => upload(parsed.buffer, { publicId: hex(c.photoId) }), log, sleep);
        if (!result || !result.secure_url || !result.public_id) { failC(c, label, "Cloudinary returned no url / public id"); continue; }
        if (result.bytes !== parsed.buffer.length) { failC(c, label, `Cloudinary reports ${result.bytes} bytes but the original is ${parsed.buffer.length}`, { publicId: result.public_id }); continue; }
        const downloaded = await withRetries("download check", () => download(result.secure_url), log, sleep);
        if (sha256(downloaded) !== sha256(parsed.buffer)) { failC(c, label, "a fresh download of the uploaded file does not match the original", { publicId: result.public_id }); continue; }

        verified.push({ c, label, url: result.secure_url, publicId: result.public_id, existing: !!result.existing });
      } catch (err) {
        failC(c, label, err.message);
      }
    }
    if (dataMap) dataMap.clear();

    // Rule 3: write this order's verified photos in a few batched updates, then check what really happened
    for (let i = 0; i < verified.length; i += BATCH_SIZE) {
      const chunk = verified.slice(i, i + BATCH_SIZE);
      const u = batchUpdateFor(orderId, chunk);
      try { await db.write(() => col.updateOne(u.filter, u.update, u.options)); }
      catch (err) {
        log(`      batched update failed (${err.message}); falling back to one photo at a time for this order`);
        for (const v of chunk) {
          const one = batchUpdateFor(orderId, [v]);
          try { await db.write(() => col.updateOne(one.filter, one.update, one.options)); } catch (e2) { /* the check below reports it */ }
        }
      }
      const rows = await db.read(() => col.aggregate(listingPipeline(orderId), { maxTimeMS: 120000 }).toArray());
      const state = new Map();
      for (const item of (rows[0] && rows[0].items) || []) for (const f of PHOTO_FIELDS) for (const p of item[f] || []) state.set(hex(p._id), p);
      for (const v of chunk) {
        const p = state.get(hex(v.c.photoId));
        if (p && p.url === v.url && p.bytes === 0) {
          summary.migrated++; summary.bytesMigrated += v.c.bytes;
          report({ status: "migrated", order: v.c.displayId, field: v.c.field, photoId: hex(v.c.photoId), bytes: v.c.bytes, publicId: v.publicId, url: v.url, existing: v.existing });
          log(`${v.label}  ok -> ${v.publicId}`);
        } else {
          failC(v.c, v.label, "photo changed while migrating; database left as it was (the uploaded copy stays in Cloudinary)", { publicId: v.publicId });
        }
      }
    }
    if (pauseMs) await sleep(pauseMs);
  }
  if (!summary.aborted) stopIfSlow();
  return summary;
}

// ───────────────────────── wiring ─────────────────────────

const isDnsLookupError = err => /query(Srv|Txt)/i.test(String((err && (err.syscall || "")) + " " + (err && err.message)));
async function connectWithDnsFallback(mongoose, uri, opts, log) {
  try { await mongoose.connect(uri, opts); } catch (err) {
    if (!isDnsLookupError(err)) throw err;
    log("Your computer's DNS could not look up the database address. Retrying once using public DNS (1.1.1.1 and 8.8.8.8)...");
    try { require("dns").setServers(["1.1.1.1", "8.8.8.8"]); } catch (e) { /* the retry reports its own error */ }
    await mongoose.disconnect().catch(() => {});
    await mongoose.connect(uri, opts);
  }
}

function parseArgs(argv) {
  const out = { apply: false, smallest: false, limit: 0, pauseMs: undefined, only: null, maxFailures: 5, backups: [], backend: process.env.BACKEND_URL || DEFAULT_BACKEND };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === "--apply") out.apply = true;
    else if (a === "--smallest") out.smallest = true;
    else if (a === "--limit") out.limit = parseInt(next(), 10) || 0;
    else if (a === "--only") out.only = next();
    else if (a === "--max-failures") out.maxFailures = parseInt(next(), 10) || 5;
    else if (a === "--pause-ms") out.pauseMs = Math.max(0, parseInt(next(), 10) || 0);
    else if (a === "--backup") out.backups.push(next());
    else if (a === "--backend") out.backend = next();
  }
  return out;
}

const defaultFetchJson = async url => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try { const r = await fetch(url, { signal: ctl.signal }); return await r.json(); } finally { clearTimeout(t); }
};
const defaultDownload = async url => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 180000);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); } finally { clearTimeout(t); }
};
const makeUploader = cloudinary => (buffer, { publicId }) => new Promise((resolve, reject) => {
  const stream = cloudinary.uploader.upload_stream(
    { folder: "induscraft/migrated", public_id: publicId, resource_type: "auto", overwrite: false, unique_filename: false, use_filename: false },
    (err, result) => (err ? reject(err) : resolve(result))
  );
  stream.end(buffer);
});

async function main(argv = process.argv.slice(2), log = console.log, deps = {}) {
  require("dotenv").config({ path: path.join(__dirname, "../.env") });
  const mongoose = require("mongoose");
  const EJSON = mongoose.mongo.BSON.EJSON;
  const args = parseArgs(argv);

  if (!process.env.MONGODB_URI) { log("MONGODB_URI is not set. Put it in the .env file in the backend folder."); return 2; }

  // backups
  const dir = path.join(os.homedir(), "induscraft-backups");
  const files = args.backups.length ? args.backups : (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^orders-.*\.ndjson$/.test(f)).map(f => path.join(dir, f)) : []);
  if (!files.length || files.some(f => !fs.existsSync(f))) { log(`No backup files found${args.backups.length ? " (check the --backup paths)" : " in " + dir}. Make the backups first; this script refuses to run without them.`); return 2; }
  log(`Reading ${files.length} backup file(s):\n${files.map(f => "  " + f).join("\n")}`);
  const backup = await buildBackupIndex(files, EJSON);
  log(`Backups cover ${backup.orders.size} orders and ${backup.photos.size} photos that carry embedded data.`);
  if (backup.conflicts.length) { log(`STOP: ${backup.conflicts.length} photo(s) have DIFFERENT contents in different backup files, e.g. ${backup.conflicts[0].photoId} (${backup.conflicts[0].a} vs ${backup.conflicts[0].b}). Resolve this before migrating.`); return 2; }

  // safety checks that only matter when changing data
  const fetchJson = deps.fetchJson || defaultFetchJson;
  let guardVersion = null;
  try { guardVersion = (await fetchJson(args.backend + "/")).photoGuard || 0; } catch (e) { guardVersion = null; }
  log(`Live backend save guard: ${guardVersion === null ? "could not be checked" : "version " + guardVersion} (needs ${REQUIRED_GUARD_VERSION}).`);

  let cloudinary = deps.cloudinary;
  if (args.apply) {
    if (guardVersion === null || guardVersion < REQUIRED_GUARD_VERSION) { log(`STOP: --apply needs the live backend to report save guard version ${REQUIRED_GUARD_VERSION} (at ${args.backend}/). Deploy the backend update first, wait for it to go Active, then try again.`); return 2; }
    if (!cloudinary) {
      for (const k of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) if (!process.env[k]) { log(`STOP: ${k} is not set in .env (copy the three Cloudinary values from Railway).`); return 2; }
      cloudinary = require("cloudinary").v2;
      cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
    }
    try { await cloudinary.api.ping(); log("Cloudinary credentials: OK."); } catch (e) { log(`STOP: Cloudinary rejected the credentials: ${(e && e.message) || e}`); return 2; }
  }

  // report file (outside the repo; contains only ids, sizes and Cloudinary links - no customer data)
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  fs.mkdirSync(dir, { recursive: true });
  const reportPath = path.join(dir, `migration-${args.apply ? "apply" : "dryrun"}-${ts}.jsonl`);
  const report = entry => fs.appendFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

  log("Connecting to MongoDB (gives up after 20 seconds)...");
  try { await connectWithDnsFallback(mongoose, process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000, socketTimeoutMS: 360000 }, log); log("Connected."); }
  catch (err) { log(`Could not connect to MongoDB: ${err.message}`); return 2; }

  if (args.apply) log("\nAPPLY MODE. Please make sure nobody is using the OMS right now.\n");
  let s;
  try {
    const col = mongoose.connection.db.collection("orders");
    s = await migrate({ col, backup, upload: makeUploader(cloudinary || {}), download: deps.download || defaultDownload, report, log }, args);
    if (!args.apply) { /* dry run needs no uploader */ }
  } catch (err) { log(`Stopped: ${err.message}`); return 2; }
  finally { await mongoose.disconnect().catch(() => {}); }

  log("\n──────── SUMMARY ────────");
  log(`Photos with embedded data   : ${s.candidates}`);
  log(args.apply ? `Moved to Cloudinary         : ${s.migrated}  (${mb(s.bytesMigrated)})` : `Ready to move               : ${s.ready}  (${mb(s.wouldMigrateBytes)})`);
  log(`Skipped                     : ${s.skipped}`);
  for (const [r, n] of Object.entries(s.skippedReasons)) log(`   ${n} x ${r}`);
  if (args.apply) log(`Failed                      : ${s.failed}`);
  if (s.aborted) log(`STOPPED EARLY               : ${s.abortReason}`);
  log(`Database calls              : ${s.dbCalls.reads} reads, ${s.dbCalls.writes} writes, ${s.dbCalls.slow} slow`);
  log(`Report                      : ${reportPath}`);
  if (!args.apply) log("\nNothing was changed. To try one small photo for real:  node scripts\\migrate-photos-to-cloudinary.js --apply --limit 1 --smallest");
  return s.failed ? 1 : 0;
}

module.exports = { migrate, buildBackupIndex, listCandidates, parseDataUri, parseArgs, main, listingPipeline, photoPipeline, batchUpdateFor, BATCH_SIZE };

if (require.main === module) {
  main().then(code => process.exit(code), err => { console.error(err); process.exit(2); });
}
