/**
 * backup-orders.js
 * READ-ONLY backup of the `orders` collection to a local file.
 *
 * Run from the backend root (needs MONGODB_URI in .env, same as migrateImages.js):
 *   node scripts/backup-orders.js
 *   node scripts/backup-orders.js --out "D:\\some\\folder"
 *
 * Why it is built this way:
 *  - Orders are ~1 MB each, so the Atlas web page and Compass time out when they try to
 *    load many at once. This reads the list of _ids first (tiny), then fetches ONE order at
 *    a time and appends it to the file straight away. Nothing big is ever held in memory.
 *  - Each line is one order in MongoDB Extended JSON (canonical), so ObjectIds, dates and
 *    number types are preserved exactly and the file can be restored with `mongoimport`.
 *  - It only ever calls countDocuments / find / findOne. It never writes to the database.
 *  - The default output folder is OUTSIDE the repo (your user folder), because the file
 *    contains customer names, phone numbers and addresses and must never be committed.
 *  - After writing, it re-reads the file, re-parses every line, and checks the count and
 *    the set of _ids against the database before saying "OK".
 *
 * Exit codes: 0 = backup complete and verified, 1 = incomplete or failed verification,
 *             2 = could not start (missing env var / cannot connect / cannot write).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

const COLLECTION = "orders";
const RETRIES = 3; // attempts per order before it is reported as failed

function getEJSON() {
  const mongoose = require("mongoose");
  return mongoose.mongo.BSON.EJSON;
}

const idKey = (EJSON, id) => EJSON.stringify(id, { relaxed: false });
const mb = bytes => (bytes / 1024 / 1024).toFixed(2) + " MB";
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Core logic, independent of mongoose so it can be tested without a database.
 * source = { estimatedCount(), listIds(), getById(id) }
 */
async function backupCollection({ source, outPath, EJSON, log = console.log, sleep = defaultSleep, retries = RETRIES }) {
  const estimatedCount = await source.estimatedCount();
  log("Listing order IDs (index only, no documents are opened)...");
  const ids = await source.listIds();
  log(`Found ${ids.length} orders (database estimate: ${estimatedCount}). Writing to:\n  ${outPath}\n`);

  // "wx" = fail if the file already exists, so a backup can never overwrite an older one.
  const fd = fs.openSync(outPath, "wx");
  const written = []; // idKeys actually written
  const failed = []; // { id, error }
  const skipped = []; // deleted between listing and fetching
  let bytes = 0;

  try {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      let doc = null;
      let lastErr = null;
      let ok = false;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          doc = await source.getById(id);
          ok = true;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < retries) {
            log(`  retry ${attempt}/${retries - 1} for ${idKey(EJSON, id)}: ${err.message}`);
            await sleep(1000 * 2 ** (attempt - 1));
          }
        }
      }
      const label = `[${i + 1}/${ids.length}]`;
      if (!ok) {
        failed.push({ id: idKey(EJSON, id), error: lastErr && lastErr.message });
        log(`${label} FAILED ${idKey(EJSON, id)}: ${lastErr && lastErr.message}`);
        continue;
      }
      if (doc === null) {
        skipped.push(idKey(EJSON, id));
        log(`${label} skipped (deleted while the backup was running)`);
        continue;
      }
      const line = EJSON.stringify(doc, { relaxed: false }) + "\n";
      fs.writeSync(fd, line);
      bytes += Buffer.byteLength(line);
      written.push(idKey(EJSON, doc._id));
      log(`${label} ${doc.id || idKey(EJSON, doc._id)}  ${mb(Buffer.byteLength(line))}  (total ${mb(bytes)})`);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  log("\nVerifying the file you just wrote...");
  const verification = await verifyFile({ outPath, EJSON, expectedKeys: written });
  const sha256 = await sha256File(outPath);
  fs.writeFileSync(outPath + ".sha256", `${sha256}  ${path.basename(outPath)}\n`);

  const complete = failed.length === 0 && verification.ok;
  return {
    ok: complete,
    estimatedCount,
    listed: ids.length,
    written: written.length,
    failed,
    skipped,
    bytes,
    sha256,
    verification,
    outPath,
  };
}

/** Re-reads the file, parses every line, and checks it matches exactly what was written. */
async function verifyFile({ outPath, EJSON, expectedKeys }) {
  const seen = new Set();
  let lines = 0;
  const problems = [];
  const rl = readline.createInterface({ input: fs.createReadStream(outPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines++;
    try {
      const doc = EJSON.parse(line);
      if (doc._id === undefined) throw new Error("no _id");
      seen.add(idKey(EJSON, doc._id));
    } catch (err) {
      problems.push(`line ${lines} is not valid: ${err.message}`);
    }
  }
  const expected = new Set(expectedKeys);
  if (lines !== expectedKeys.length) problems.push(`file has ${lines} lines but ${expectedKeys.length} orders were written`);
  for (const k of expected) if (!seen.has(k)) problems.push(`missing from file: ${k}`);
  return { ok: problems.length === 0, lines, problems };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", d => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

function timestamp(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseArgs(argv) {
  const i = argv.indexOf("--out");
  return { outDir: i !== -1 && argv[i + 1] ? argv[i + 1] : path.join(os.homedir(), "induscraft-backups") };
}

// mongodb+srv:// strings need a DNS "SRV" lookup. Some routers/ISPs refuse it ("querySrv ECONNREFUSED"),
// which has nothing to do with Atlas's IP allow list. This recognises that case.
const isDnsLookupError = err => /query(Srv|Txt)/i.test(String((err && (err.syscall || "")) + " " + (err && err.message)));

async function connectWithDnsFallback(mongoose, uri, opts, log) {
  try {
    await mongoose.connect(uri, opts);
  } catch (err) {
    if (!isDnsLookupError(err)) throw err;
    log("Your computer's DNS could not look up the database address. Retrying once using public DNS (1.1.1.1 and 8.8.8.8)...");
    try { require("dns").setServers(["1.1.1.1", "8.8.8.8"]); } catch (e) { /* keep going; the retry will report its own error */ }
    await mongoose.disconnect().catch(() => {});
    await mongoose.connect(uri, opts);
  }
}

/** Wiring: connects with mongoose, adapts the native collection to the `source` shape. */
async function main(argv = process.argv.slice(2), log = console.log) {
  require("dotenv").config({ path: path.join(__dirname, "../.env") });
  const mongoose = require("mongoose");
  const EJSON = getEJSON();

  if (!process.env.MONGODB_URI) {
    log("MONGODB_URI is not set. Put it in the .env file in the backend folder (the same one migrateImages.js uses).");
    return 2;
  }

  const { outDir } = parseArgs(argv);
  let outPath;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    outPath = path.join(outDir, `orders-${timestamp()}.ndjson`);
  } catch (err) {
    log(`Cannot create the backup folder ${outDir}: ${err.message}`);
    return 2;
  }

  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
  log("Connecting to MongoDB (gives up after 20 seconds)...");
  try {
    await connectWithDnsFallback(mongoose, process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000, socketTimeoutMS: 120000 }, log);
    log(`Connected (${secs()}).`);
  } catch (err) {
    log(`Could not connect to MongoDB: ${err.message}`);
    if (isDnsLookupError(err)) {
      log("This is a DNS problem on this computer/network, not an Atlas setting. Try, in this order:");
      log("  1. Change Windows DNS: Settings > Network & internet > your connection > DNS server assignment > Manual > IPv4 > Preferred 1.1.1.1, Alternate 8.8.8.8. Then run this again.");
      log("  2. Try another network (for example your phone's hotspot).");
      log("  3. In Atlas: Connect > Drivers, choose an older Node.js version (2.2.12 or later) to get the long 'mongodb://' string (no SRV lookup), and put THAT in .env as MONGODB_URI.");
    } else {
      log("If this says it timed out or cannot select a server, check Atlas > Network Access: your current IP address must be on the allow list.");
    }
    return 2;
  }

  let result;
  try {
    const col = mongoose.connection.db.collection(COLLECTION);
    // estimatedDocumentCount reads collection metadata (instant); countDocuments would scan every order.
    // hint({_id:1}) + projection {_id:1} makes MongoDB answer from the _id index alone, without opening
    // any ~1 MB order. maxTimeMS makes the SERVER give up and return an error instead of hanging silently.
    const source = {
      estimatedCount: () => col.estimatedDocumentCount({ maxTimeMS: 30000 }),
      listIds: async () =>
        (await col.find({}, { projection: { _id: 1 }, hint: { _id: 1 }, sort: { _id: 1 }, maxTimeMS: 60000 }).toArray()).map(d => d._id),
      getById: id => col.findOne({ _id: id }, { maxTimeMS: 120000 }),
    };
    result = await backupCollection({ source, outPath, EJSON, log });
  } catch (err) {
    log(`Backup stopped: ${err.message}`);
    return 2;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }

  log("\n──────── SUMMARY ────────");
  log(`Orders found       : ${result.listed}`);
  log(`Orders written     : ${result.written}  (${mb(result.bytes)})`);
  if (result.skipped.length) log(`Deleted mid-backup : ${result.skipped.length}`);
  if (result.failed.length) {
    log(`FAILED             : ${result.failed.length}`);
    result.failed.forEach(f => log(`   ${f.id}: ${f.error}`));
  }
  log(`File check         : ${result.verification.ok ? "OK - every line re-read and matched" : "PROBLEMS"}`);
  result.verification.problems.forEach(p => log(`   ${p}`));
  log(`SHA-256            : ${result.sha256}`);
  log(`File               : ${result.outPath}`);
  log(result.ok ? "\nBACKUP COMPLETE." : "\nBACKUP INCOMPLETE - do not rely on this file. See the problems above.");
  return result.ok ? 0 : 1;
}

module.exports = { backupCollection, verifyFile, main, parseArgs };

if (require.main === module) {
  main().then(code => process.exit(code), err => { console.error(err); process.exit(2); });
}
