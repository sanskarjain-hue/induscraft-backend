/**
 * migrateImages.js
 * One-time script to upload base64 images from MongoDB to Cloudinary.
 *
 * Run from the backend root:
 *   node scripts/migrateImages.js
 *
 * Requires env vars: MONGODB_URI, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 * Install deps if needed: npm install cloudinary mongoose dotenv
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;

// ── CONFIG ────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── ORDER SCHEMA (minimal, just enough to read/write) ─────
const photoSchema = new mongoose.Schema({
  name: String,
  type: String,
  url: String,
  data: String,
  publicId: String,
});

const itemSchema = new mongoose.Schema({
  images: [photoSchema],
  measurementPhotos: [photoSchema],
  rawPhotos: [photoSchema],
  finishingPhotos: [photoSchema],
  qcPhotos: [photoSchema],
}, { strict: false });

const orderSchema = new mongoose.Schema({
  id: String,
  items: [itemSchema],
}, { strict: false });

const Order = mongoose.model("Order", orderSchema);

// ── HELPERS ───────────────────────────────────────────────
const PHOTO_FIELDS = ["images", "measurementPhotos", "rawPhotos", "finishingPhotos", "qcPhotos"];

async function uploadBase64(base64Data, folder, name) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(base64Data, {
      folder: `induscraft/${folder}`,
      public_id: `${Date.now()}_${name.replace(/[^a-z0-9]/gi, "_")}`,
      resource_type: "auto",
    }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function needsMigration(photo) {
  return photo.data && photo.data.startsWith("data:") && !photo.url;
}

// ── MAIN ──────────────────────────────────────────────────
async function migrate() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected.\n");

  const orders = await Order.find({});
  console.log(`Found ${orders.length} orders to check.\n`);

  let totalPhotos = 0;
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const order of orders) {
    let orderModified = false;

    for (const item of order.items) {
      for (const field of PHOTO_FIELDS) {
        const photos = item[field] || [];
        for (let i = 0; i < photos.length; i++) {
          const photo = photos[i];
          totalPhotos++;

          if (!needsMigration(photo)) {
            skipped++;
            continue;
          }

          try {
            process.stdout.write(`  Uploading ${order.id} / ${field}[${i}] (${photo.name || "unnamed"})... `);
            const result = await uploadBase64(photo.data, field, photo.name || "image");
            photos[i].url = result.secure_url;
            photos[i].publicId = result.public_id;
            photos[i].data = undefined; // clear base64 after successful upload
            orderModified = true;
            migrated++;
            console.log(`done → ${result.secure_url.slice(0, 60)}...`);
          } catch (err) {
            failed++;
            console.log(`FAILED: ${err.message}`);
          }
        }
      }
    }

    if (orderModified) {
      try {
        // Use markModified since we're editing nested arrays
        order.markModified("items");
        await order.save();
        console.log(`  Saved order ${order.id}\n`);
      } catch (err) {
        console.log(`  FAILED to save order ${order.id}: ${err.message}\n`);
      }
    }
  }

  console.log("\n── MIGRATION COMPLETE ─────────────────────────");
  console.log(`Total photos checked : ${totalPhotos}`);
  console.log(`Already on Cloudinary: ${skipped}`);
  console.log(`Migrated to Cloudinary: ${migrated}`);
  console.log(`Failed               : ${failed}`);
  console.log("───────────────────────────────────────────────\n");

  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch(err => {
  console.error("Migration error:", err);
  process.exit(1);
});