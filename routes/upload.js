const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Use memory storage so we can stream to Cloudinary
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only images and PDFs are allowed"));
  },
});

// Helper to upload buffer to Cloudinary
function uploadToCloudinary(buffer, folder, resourceType = "auto") {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `induscraft/${folder}`, resource_type: resourceType },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
}

// POST /api/upload/image — upload single image or PDF
router.post("/image", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const folder = req.body.folder || "general";
    const result = await uploadToCloudinary(req.file.buffer, folder);
    res.json({
      name: req.file.originalname,
      type: req.file.mimetype,
      url: result.secure_url,
      publicId: result.public_id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload/multiple — upload multiple files
router.post("/multiple", auth, upload.array("files", 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: "No files uploaded" });
    const folder = req.body.folder || "general";
    const results = await Promise.all(
      req.files.map(async (file) => {
        const result = await uploadToCloudinary(file.buffer, folder);
        return {
          name: file.originalname,
          type: file.mimetype,
          url: result.secure_url,
          publicId: result.public_id,
        };
      })
    );
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/upload/:publicId — delete file from Cloudinary
router.delete("/:publicId(*)", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admin only" });
    await cloudinary.uploader.destroy(req.params.publicId);
    res.json({ message: "File deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
