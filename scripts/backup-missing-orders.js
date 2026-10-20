/**
 * backup-missing-orders.js
 * READ-ONLY. Backs up the orders that are in the database but missing from an earlier
 * backup file (for example the ones that timed out in backup-orders.js).
 *
 *   node scripts/backup-missing-orders.js
 *   node scripts/backup-missing-orders.js --backup "C:\\path\\to\\orders-....ndjson" --out "D:\\folder"
 *
 * How it works:
 *  1. Lists every order _id in the database (index only) and every _id already in the backup
 *     file. The difference is what is missing - no ids to copy by hand.
 *  2. For each missing order it first asks the server how big the order is (optional check).
 *  3. Then it tries a normal whole-order fetch, but patiently (up to 15 minutes per order).
 *  4. If that still fails, it rebuilds the order from small pieces: the order without its
 *     photo arrays, then ONE photo at a time. It then compares the rebuilt order's size with
 *     the size the server reported and refuses to save it if they differ.
 *  5. Output goes to a separate file (orders-missing-<time>.ndjson) next to the first backup,
 *     with the same verification and SHA-256 as backup-orders.js.
 *
 * It only ever reads. Exit codes: 0 = everything missing is now backed up and verified,
 * 1 = some orders could not be fetched, 2 = could not start.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { backupCollection } = require("./backup-orders");
const { PHOTO_FIELDS, newestBackup } = require("./analyze-backup");

const LONG_MS = 15 * 60 * 1000; // whole-order fetch limit
const PIECE_MS = 5 * 60 * 1000; // per-piece limit
const PROBE_MS = 60 * 1000; // size probe limit

const mb = bytes => (bytes / 1024 / 1024).toFixed(2) + " MB";
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));
const idKey = (EJSON, id) => EJSON.stringify(id, { relaxed: false });

// ── Database queries (kept as plain functions so they can be tested against an in-memory engine) ──
// Excludes the five photo arrays inside every item, leaving the rest of the order.
const EXCLUDE_PHOTOS = Object.fromEntries(PHOTO_FIELDS.map(f => ["items." + f, 0]));

// For each item: how many photos are in each photo array (-1 = the field is not an array / absent).
const countsPipeline = id => [
  { $match: { _id: id } },
  {
    $project: {
      _id: 0,
      c: {
        $map: {
          input: { $ifNull: ["$items", []] },
          as: "it",
          in: Object.fromEntries(PHOTO_FIELDS.map(f => [f, { $cond: [{ $isArray: "$$it." + f }, { $size: "$$it." + f }, -1] }])),
        },
      },
    },
  },
];

// Exactly one photo: item i, array f, position j.
const piecePipeline = (id, i, f, j) => [
  { $match: { _id: id } },
  {
    $project: {
      _id: 0,
      p: { $let: { vars: { it: { $arrayElemAt: ["$items", i] } }, in: { $arrayElemAt: [{ $ifNull: ["$$it." + f, []] }, j] } } },
    },
  },
];

// Size the SERVER holds for the whole document (needs MongoDB 4.4+; optional).
const probePipeline = id => [{ $match: { _id: id } }, { $project: { _id: 0, total: { $bsonSize: "$$ROOT" } } }];

async function probeSize(col, id, log) {
  try {
    const r = await col.aggregate(probePipeline(id), { maxTimeMS: PROBE_MS }).toArray();
    return r[0] && typeof r[0].total === "number" ? r[0].total : null;
  } catch (err) {
    log(`    (size check unavailable: ${err.message})`);
    return null;
  }
}

async function withRetries(label, fn, log, sleep, attempts = 3) {
  for (let a = 1; ; a++) {
    try {
      return await fn();
    } catch (err) {
      if (a >= attempts) throw new Error(`${label}: ${err.message}`);
      log(`    retry ${a}/${attempts - 1} (${label}): ${err.message}`);
      await sleep(2000 * a);
    }
  }
}

/** Rebuilds one order from small queries. Returns null if the order vanished. */
async function fetchInPieces(col, id, { log, sleep }) {
  const base = await withRetries("order without photos", () => col.findOne({ _id: id }, { projection: EXCLUDE_PHOTOS, maxTimeMS: PIECE_MS }), log, sleep);
  if (base === null) return null;
  const countsRes = await withRetries("photo counts", () => col.aggregate(countsPipeline(id), { maxTimeMS: PIECE_MS }).toArray(), log, sleep);
  if (!countsRes.length) return null;
  const counts = countsRes[0].c || [];
  const items = Array.isArray(base.items) ? base.items : [];
  if (counts.length !== items.length) throw new Error(`item count mismatch (${counts.length} counted vs ${items.length} fetched)`);

  let pieces = 0;
  for (let i = 0; i < items.length; i++) {
    for (const f of PHOTO_FIELDS) {
      const n = counts[i][f];
      if (n === -1) continue; // the field does not exist on this item: leave it absent
      const arr = [];
      for (let j = 0; j < n; j++) {
        const photo = await withRetries(
          `item ${i + 1} ${f} ${j + 1}/${n}`,
          async () => {
            const r = await col.aggregate(piecePipeline(id, i, f, j), { maxTimeMS: PIECE_MS }).toArray();
            if (!r.length || r[0].p === undefined) throw new Error("photo missing in the response");
            return r[0].p;
          },
          log, sleep
        );
        arr.push(photo);
        pieces++;
      }
      items[i][f] = arr; // an empty array stays an empty array
      if (n > 0) log(`    item ${i + 1} ${f}: ${n} photo(s) fetched`);
    }
  }
  log(`    rebuilt from ${pieces} photo piece(s)`);
  return base;
}

/** Whole-order fetch with a long limit; falls back to pieces; verifies size when the server reported one. */
async function fetchPatiently(col, id, { log = () => {}, sleep = defaultSleep, BSON } = {}) {
  const serverBytes = await probeSize(col, id, log);
  if (serverBytes) log(`    size on the server: ${mb(serverBytes)}`);
  try {
    log("    trying a whole-order fetch (patient, up to 15 minutes)...");
    return await col.findOne({ _id: id }, { maxTimeMS: LONG_MS });
  } catch (err) {
    log(`    whole-order fetch failed (${err.message}). Switching to piece-by-piece...`);
  }
  const doc = await fetchInPieces(col, id, { log, sleep });
  if (doc && serverBytes && BSON) {
    const local = BSON.calculateObjectSize(doc);
    const diff = Math.abs(local - serverBytes);
    const tolerance = Math.max(1024, serverBytes * 0.005);
    log(`    size check: rebuilt ${mb(local)} vs server ${mb(serverBytes)} (difference ${diff} bytes)`);
    if (diff > tolerance) throw new Error(`rebuilt order is ${local} bytes but the database holds ${serverBytes}; not saving a possibly incomplete copy`);
  } else if (doc && !serverBytes) {
    log("    (no server size available, so the rebuilt order was checked by photo counts only)");
  }
  return doc;
}

async function readBackupIds(file, EJSON) {
  const keys = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    keys.add(idKey(EJSON, EJSON.parse(line)._id));
  }
  return keys;
}

const isDnsLookupError = err => /query(Srv|Txt)/i.test(String((err && (err.syscall || "")) + " " + (err && err.message)));
async function connectWithDnsFallback(mongoose, uri, opts, log) {
  try {
    await mongoose.connect(uri, opts);
  } catch (err) {
    if (!isDnsLookupError(err)) throw err;
    log("Your computer's DNS could not look up the database address. Retrying once using public DNS (1.1.1.1 and 8.8.8.8)...");
    try { require("dns").setServers(["1.1.1.1", "8.8.8.8"]); } catch (e) { /* the retry reports its own error */ }
    await mongoose.disconnect().catch(() => {});
    await mongoose.connect(uri, opts);
  }
}

function timestamp(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseArgs(argv) {
  const get = flag => { const i = argv.indexOf(flag); return i !== -1 && argv[i + 1] ? argv[i + 1] : null; };
  return { backup: get("--backup"), outDir: get("--out") };
}

async function main(argv = process.argv.slice(2), log = console.log) {
  require("dotenv").config({ path: path.join(__dirname, "../.env") });
  const mongoose = require("mongoose");
  const { EJSON } = mongoose.mongo.BSON;
  const BSON = mongoose.mongo.BSON;

  if (!process.env.MONGODB_URI) {
    log("MONGODB_URI is not set. Put it in the .env file in the backend folder (the same one backup-orders.js uses).");
    return 2;
  }
  const args = parseArgs(argv);
  const defaultDir = path.join(os.homedir(), "induscraft-backups");
  const backupFile = args.backup || newestBackup(defaultDir);
  if (!backupFile || !fs.existsSync(backupFile)) {
    log(`No earlier backup file found${args.backup ? ": " + args.backup : " in " + defaultDir}. Pass it with --backup "<path>".`);
    return 2;
  }
  const outDir = args.outDir || path.dirname(backupFile);
  let outPath;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    outPath = path.join(outDir, `orders-missing-${timestamp()}.ndjson`);
  } catch (err) {
    log(`Cannot create the backup folder ${outDir}: ${err.message}`);
    return 2;
  }

  log(`Comparing the database against:\n  ${backupFile}`);
  const haveKeys = await readBackupIds(backupFile, EJSON);
  log(`That file contains ${haveKeys.size} orders.\n`);

  log("Connecting to MongoDB (gives up after 20 seconds)...");
  try {
    await connectWithDnsFallback(mongoose, process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000, socketTimeoutMS: LONG_MS + 60000 }, log);
    log("Connected.");
  } catch (err) {
    log(`Could not connect to MongoDB: ${err.message}`);
    log(isDnsLookupError(err)
      ? "This is a DNS problem on this computer/network. Change Windows DNS to 1.1.1.1 / 8.8.8.8, or try another network."
      : "If this says it timed out or cannot select a server, check Atlas > Network Access: your current IP address must be on the allow list.");
    return 2;
  }

  let result, dbIds;
  try {
    const col = mongoose.connection.db.collection("orders");
    log("Listing order IDs (index only)...");
    dbIds = (await col.find({}, { projection: { _id: 1 }, hint: { _id: 1 }, sort: { _id: 1 }, maxTimeMS: 60000 }).toArray()).map(d => d._id);
    const missing = dbIds.filter(id => !haveKeys.has(idKey(EJSON, id)));
    log(`Database has ${dbIds.length} orders; ${missing.length} are not in the backup file.`);
    if (!missing.length) {
      log("\nNothing is missing. The backup file already covers every order.");
      return 0;
    }
    const patient = { log: m => log(m), sleep: defaultSleep, BSON };
    const source = {
      estimatedCount: async () => missing.length,
      listIds: async () => missing,
      getById: async id => { log(`  fetching ${idKey(EJSON, id)}`); return fetchPatiently(col, id, patient); },
    };
    // retries: 1 -> fetchPatiently already has its own patience; do not wait 15 minutes three times over.
    result = await backupCollection({ source, outPath, EJSON, log, retries: 1 });
  } catch (err) {
    log(`Stopped: ${err.message}`);
    return 2;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }

  log("\n──────── SUMMARY ────────");
  log(`Missing orders found : ${result.listed}`);
  log(`Now written          : ${result.written}  (${mb(result.bytes)})`);
  if (result.skipped.length) log(`Deleted meanwhile    : ${result.skipped.length}`);
  if (result.failed.length) {
    log(`STILL FAILED         : ${result.failed.length}`);
    result.failed.forEach(f => log(`   ${f.id}: ${f.error}`));
  }
  log(`File check           : ${result.verification.ok ? "OK - every line re-read and matched" : "PROBLEMS"}`);
  result.verification.problems.forEach(p => log(`   ${p}`));
  log(`SHA-256              : ${result.sha256}`);
  log(`File                 : ${result.outPath}`);
  const covered = haveKeys.size + result.written + result.skipped.length;
  if (result.ok) log(`\nTogether with the first file that is ${haveKeys.size} + ${result.written} = ${haveKeys.size + result.written} orders, out of ${dbIds.length} in the database.`);
  log(result.ok && covered >= dbIds.length ? "\nCOMPLETE SET: the two files together cover every order." : "\nSET NOT COMPLETE - see the problems above.");
  return result.ok && covered >= dbIds.length ? 0 : 1;
}

module.exports = { fetchPatiently, fetchInPieces, readBackupIds, main, countsPipeline, piecePipeline, EXCLUDE_PHOTOS };

if (require.main === module) {
  main().then(code => process.exit(code), err => { console.error(err); process.exit(2); });
}
