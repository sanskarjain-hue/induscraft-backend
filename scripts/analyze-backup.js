/**
 * analyze-backup.js
 * OFFLINE analysis of a backup file made by backup-orders.js.
 * No database, no network, no writes. It only reads the file on your computer.
 *
 *   node scripts/analyze-backup.js                 (uses the newest backup in your induscraft-backups folder)
 *   node scripts/analyze-backup.js "C:\path\to\orders-....ndjson"
 *
 * It answers one question: WHERE do the megabytes in an order actually live?
 * The report contains only field names, counts and sizes - no customer names, phone numbers,
 * addresses or photo contents - so it is safe to copy and paste to someone.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

// The five per-item photo arrays defined by the Order model.
const PHOTO_FIELDS = ["images", "measurementPhotos", "rawPhotos", "finishingPhotos", "qcPhotos"];

const mb = b => (b / 1024 / 1024).toFixed(2) + " MB";
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "0%");
const bytesOf = s => Buffer.byteLength(s);
const isPlainObject = v => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

function median(sortedNums) {
  if (!sortedNums.length) return 0;
  const m = Math.floor(sortedNums.length / 2);
  return sortedNums.length % 2 ? sortedNums[m] : (sortedNums[m - 1] + sortedNums[m]) / 2;
}

/** Walks any value, adding the byte length of every string to a "path template" such as items[].rawPhotos[].data */
function walk(value, p, acc) {
  if (typeof value === "string") {
    const b = bytesOf(value);
    const e = acc.paths.get(p) || { bytes: 0, count: 0, max: 0 };
    e.bytes += b; e.count++; if (b > e.max) e.max = b;
    acc.paths.set(p, e);
    if (value.startsWith("data:")) {
      const mime = (value.match(/^data:([^;,]+)/) || [])[1] || "unknown";
      acc.dataUris.set(mime, (acc.dataUris.get(mime) || 0) + 1);
    } else if (value.length > 2000 && /^[A-Za-z0-9+/=\r\n]+$/.test(value.slice(0, 400))) {
      acc.rawBase64 += 1;
    }
  } else if (Array.isArray(value)) {
    for (const v of value) walk(v, p + "[]", acc);
  } else if (isPlainObject(value)) {
    for (const k of Object.keys(value)) walk(value[k], p ? p + "." + k : k, acc);
  }
}

/**
 * Core: takes an async iterable of lines (one order per line) and returns the statistics.
 * Kept free of console output so it can be tested.
 */
async function analyzeLines(lines, EJSON) {
  const total = { orders: 0, bytes: 0, parseErrors: 0 };
  const sizes = [];
  const projectedSizes = [];
  const global = { paths: new Map(), dataUris: new Map(), rawBase64: 0 };
  const photoStats = {};
  for (const f of PHOTO_FIELDS) photoStats[f] = { photos: 0, withData: 0, withUrl: 0, both: 0, dataOnly: 0, urlOnly: 0, neither: 0, dataBytes: 0 };
  const heaviest = [];
  let allDataBytes = 0;

  for await (const line of lines) {
    if (!line.trim()) continue;
    let order;
    try { order = EJSON.parse(line); } catch (e) { total.parseErrors++; continue; }
    const lineBytes = bytesOf(line);
    total.orders++; total.bytes += lineBytes; sizes.push(lineBytes);

    const local = { paths: new Map(), dataUris: global.dataUris, rawBase64: 0 };
    walk(order, "", local);
    global.rawBase64 += local.rawBase64;
    let topPath = "", topBytes = 0;
    for (const [p, e] of local.paths) {
      const g = global.paths.get(p) || { bytes: 0, count: 0, max: 0 };
      g.bytes += e.bytes; g.count += e.count; if (e.max > g.max) g.max = e.max;
      global.paths.set(p, g);
      if (e.bytes > topBytes) { topBytes = e.bytes; topPath = p; }
    }

    let orderDataBytes = 0;
    for (const item of Array.isArray(order.items) ? order.items : []) {
      for (const f of PHOTO_FIELDS) {
        const arr = item && item[f];
        if (!Array.isArray(arr)) continue;
        const s = photoStats[f];
        for (const photo of arr) {
          s.photos++;
          const hasData = photo && typeof photo.data === "string" && photo.data.length > 0;
          const hasUrl = photo && typeof photo.url === "string" && photo.url.length > 0;
          if (hasData) { const b = bytesOf(photo.data); s.withData++; s.dataBytes += b; orderDataBytes += b; }
          if (hasUrl) s.withUrl++;
          if (hasData && hasUrl) s.both++;
          else if (hasData) s.dataOnly++;
          else if (hasUrl) s.urlOnly++;
          else s.neither++;
        }
      }
    }
    allDataBytes += orderDataBytes;
    projectedSizes.push(lineBytes - orderDataBytes);
    heaviest.push({ id: String(order.id || "(no id)"), bytes: lineBytes, topPath, topBytes, dataBytes: orderDataBytes });
  }

  heaviest.sort((a, b) => b.bytes - a.bytes);
  sizes.sort((a, b) => a - b);
  projectedSizes.sort((a, b) => a - b);
  return { total, sizes, projectedSizes, global, photoStats, heaviest: heaviest.slice(0, 10), allDataBytes };
}

function report(r, log) {
  const t = r.total;
  log("════════ BACKUP ANALYSIS (field names, counts and sizes only) ════════");
  log(`Orders analysed : ${t.orders}${t.parseErrors ? `   (${t.parseErrors} lines could not be read!)` : ""}`);
  log(`Total size      : ${mb(t.bytes)}`);
  if (!t.orders) return;
  log(`Per order       : smallest ${mb(r.sizes[0])} | median ${mb(median(r.sizes))} | largest ${mb(r.sizes[r.sizes.length - 1])}`);

  log("\n── Where the text bytes live (top 12 field paths) ──");
  const rows = [...r.global.paths.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 12);
  for (const [p, e] of rows) {
    log(`${(p || "(root)").padEnd(46)} ${mb(e.bytes).padStart(10)}  ${pct(e.bytes, t.bytes).padStart(6)}   ${String(e.count).padStart(5)} values, largest ${mb(e.max)}`);
  }

  log("\n── Photos stored on items ──");
  log("field".padEnd(20) + "photos  with-data  with-url  BOTH  DATA-ONLY  url-only  neither   data size");
  const sum = { photos: 0, withData: 0, withUrl: 0, both: 0, dataOnly: 0, urlOnly: 0, neither: 0, dataBytes: 0 };
  for (const f of PHOTO_FIELDS) {
    const s = r.photoStats[f];
    for (const k of Object.keys(sum)) sum[k] += s[k];
    log(f.padEnd(20) + [s.photos, s.withData, s.withUrl, s.both, s.dataOnly, s.urlOnly, s.neither].map(n => String(n).padStart(8)).join("") + "   " + mb(s.dataBytes));
  }
  log("ALL FIVE".padEnd(20) + [sum.photos, sum.withData, sum.withUrl, sum.both, sum.dataOnly, sum.urlOnly, sum.neither].map(n => String(n).padStart(8)).join("") + "   " + mb(sum.dataBytes));
  log("  BOTH = has a Cloudinary url AND an embedded copy (the embedded copy is redundant)");
  log("  DATA-ONLY = the embedded copy is the ONLY copy of that photo");

  if (r.global.dataUris.size) log(`\nEmbedded data-URIs by type: ${[...r.global.dataUris.entries()].map(([m, n]) => `${m} x${n}`).join(", ")}`);
  if (r.global.rawBase64) log(`Long base64-looking strings without a data: prefix: ${r.global.rawBase64}`);

  const share = r.allDataBytes / t.bytes;
  const projTotal = r.projectedSizes.reduce((a, b) => a + b, 0);
  log("\n── If the five photo `data` fields were left out of the order list ──");
  log(`Total would be  : ${mb(projTotal)}  (${pct(t.bytes - projTotal, t.bytes)} smaller)`);
  log(`Per order       : median ${mb(median(r.projectedSizes))} | largest ${mb(r.projectedSizes[r.projectedSizes.length - 1])}`);

  log("\n── 10 heaviest orders in this file ──");
  for (const h of r.heaviest) log(`${h.id.padEnd(12)} ${mb(h.bytes).padStart(10)}   biggest field: ${h.topPath || "-"} (${mb(h.topBytes)})   embedded photo data: ${mb(h.dataBytes)}`);

  log("\n── Reading ──");
  if (share >= 0.8) log(`Embedded photo data is ${pct(r.allDataBytes, t.bytes)} of everything. Leaving it out of the list WOULD fix the loading problem.`);
  else if (share >= 0.4) log(`Embedded photo data is ${pct(r.allDataBytes, t.bytes)} of everything: a big part, but not all. Leaving it out helps a lot; the next-biggest fields above may need attention too.`);
  else log(`Embedded photo data is only ${pct(r.allDataBytes, t.bytes)} of everything. It is NOT the main weight - look at the top field paths above before changing anything.`);
  log("(This file excludes any orders that failed to back up; those are likely the heaviest ones.)");
}

async function* linesOf(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const l of rl) yield l;
}

/** Newest ordinary backup (ignores the *-missing-* files) in the default folder. */
function newestBackup(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => /^orders-\d.*\.ndjson$/.test(f)).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }));
  files.sort((a, b) => b.t - a.t);
  return files.length ? path.join(dir, files[0].f) : null;
}

async function main(argv = process.argv.slice(2), log = console.log) {
  const defaultDir = path.join(os.homedir(), "induscraft-backups");
  const file = argv[0] || newestBackup(defaultDir);
  if (!file || !fs.existsSync(file)) {
    log(`No backup file found${argv[0] ? ": " + argv[0] : " in " + defaultDir}. Pass the path as the first argument.`);
    return 2;
  }
  log(`Reading ${file}\n`);
  const EJSON = require("mongoose").mongo.BSON.EJSON;
  const result = await analyzeLines(linesOf(file), EJSON);
  report(result, log);
  return 0;
}

module.exports = { analyzeLines, report, main, newestBackup, PHOTO_FIELDS };

if (require.main === module) {
  main().then(code => process.exit(code), err => { console.error(err); process.exit(2); });
}
