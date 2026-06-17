require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(cors({
  origin: [
    "https://induscraft-oms.vercel.app",
    "https://ops.induscraft.store",
    "http://localhost:5173",
  ],
  credentials: true,
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ── ROUTES ────────────────────────────────────────────────
app.use("/api/auth", require("./routes/auth"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/vendors", require("./routes/vendors"));
app.use("/api/aftersales", require("./routes/aftersales"));
app.use("/api/upload", require("./routes/upload"));
app.use("/api/deals", require("./routes/deals"));
app.use("/api/customers", require("./routes/customers"));

// ── TEMPORARY SEED ROUTES — REMOVE AFTER RUNNING ─────────
app.get("/api/seed-trina", async (req, res) => {
  if (req.query.secret !== "induscraft2026") return res.status(403).json({ error: "Forbidden" });
  try {
    const bcrypt = require("bcryptjs");
    const User = require("./models/User");
    const exists = await User.findOne({ username: "trina" });
    if (exists) return res.json({ message: "Trina already exists" });
    const hashed = await bcrypt.hash("sales123", 10);
    await User.create({ username: "trina", password: hashed, name: "Trina", initials: "TR", role: "sales" });
    res.json({ success: true, message: "Trina created with password sales123" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/seed-deals", async (req, res) => {
  if (req.query.secret !== "induscraft2026") return res.status(403).json({ error: "Forbidden" });
  try {
    const Deal = require("./models/Deal");
    const TODAY = new Date().toISOString().split("T")[0];
    const deals = [
      { customerName: "Suraj Adhikari", customerPhone: "+91 97734 51811", channel: "Website", enquiry: "Interested in Meher cabinet — 3 door only (size limitation). Not interested in other cabinets, likes Meher's design specifically.", salesperson: "Sanskar", stage: "Lead", lastContacted: TODAY, logs: [{ text: "Interested in Meher cabinet 3 door only due to size limitations. Likes the design, not open to alternatives.", author: "Sanskar", createdAt: new Date() }] },
      { customerName: "Unknown", customerPhone: "+91 95971 22126", channel: "Website", enquiry: "Interested in Brendon Dining Table and Chair set + Modern Cane Bed. Wants to reduce cane work in legboard.", salesperson: "Sanskar", stage: "Lead", lastContacted: TODAY, logs: [{ text: "Enquired about Brendon Dining Table + Chair and Modern Cane Bed. Specific request: reduce cane work in legboard.", author: "Sanskar", createdAt: new Date() }] },
      { customerName: "Nagesh", customerPhone: "+91 96660 55355", channel: "Website", enquiry: "Interested in sofa similar to one made for Siddhi Enterprises — thicker cushions as per picture reference.", salesperson: "Sanskar", stage: "Lead", lastContacted: TODAY, logs: [{ text: "Wants sofa like the one made for Siddhi Enterprises with thicker cushions. Has picture reference.", author: "Sanskar", createdAt: new Date() }] },
      { customerName: "Cheryl", customerPhone: "+971 56 671 7731", channel: "Website", enquiry: "Needs delivery in Chennai. Concerned about timeline and online payment. Found us through MouthShut reviews mentioning Shivraj.", salesperson: "Sanskar", stage: "Lead", lastContacted: TODAY, logs: [{ text: "Can ONLY be reached via WhatsApp text — no calls. Delivery to Chennai. Worried about timeline and online payment. Found us through MouthShut reviews mentioning Shivraj.", author: "Sanskar", createdAt: new Date() }] },
      { customerName: "Surya Prakash", customerPhone: "+91 98412 82790", channel: "Website", enquiry: "Interested in bed without headboard and platform — like the new Kriya bed.", salesperson: "Sanskar", stage: "Lead", lastContacted: TODAY, logs: [{ text: "Wants a bed without headboard and platform, similar to Kriya bed.", author: "Sanskar", createdAt: new Date() }] },
      { customerName: "Yogesh", customerPhone: "76761 87519", channel: "Bangalore", enquiry: "Hydraulic Bed & Furniture", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Anjali", customerPhone: "73584 31494", channel: "Bangalore", enquiry: "Dining Table", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Ms. Ipsita", customerPhone: "97390 49045", channel: "Bangalore", enquiry: "King Size Bed", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Mehak", customerPhone: "85308 70383", channel: "Bangalore", enquiry: "Set of 4 products", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Gayatri", customerPhone: "98805 18137", channel: "Bangalore", enquiry: "1 King Size Bed + 1 single bed with storage", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Mr. Akash", customerPhone: "95450 60681", channel: "Bangalore", enquiry: "Furniture for new house — possession in August", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [{ text: "New house possession in August. Full furniture requirement.", author: "Kishore", createdAt: new Date() }] },
      { customerName: "Chitra", customerPhone: "99863 48873", channel: "Bangalore", enquiry: "Grocery Unit", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Riya", customerPhone: "73385 67033", channel: "Bangalore", enquiry: "Dining Table", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Dipali", customerPhone: "76766 41235", channel: "Bangalore", enquiry: "Sofa 2-seater", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Shilpa", customerPhone: "97390 81592", channel: "Bangalore", enquiry: "Sofa 3+2+1 set", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Kundan", customerPhone: "97400 08124", channel: "Bangalore", enquiry: "Furniture for new house — Sofa 3+1+1, Dining Table, Queen Size Bed etc.", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Akhil Ahuja", customerPhone: "97412 40826", channel: "Bangalore", enquiry: "Sofa + Dining Set", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Srikant ji", customerPhone: "87420 35425", channel: "Bangalore", enquiry: "Sofa", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Amit ji", customerPhone: "98452 09638", channel: "Bangalore", enquiry: "Bunk Bed", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Manoj", customerPhone: "9591202995", channel: "Bangalore", enquiry: "Sofa cum bed + 1+1 recliner sofa + queen size bed with drawer + bedside table", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Chetan", customerPhone: "9980703580", channel: "Bangalore", enquiry: "5 seater fabric sofa", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Sajan", customerPhone: "9033607557", channel: "Bangalore", enquiry: "Shoe rack", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Akshay", customerPhone: "7012528320", channel: "Bangalore", enquiry: "", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Muralidharan Raju", customerPhone: "9844473986", channel: "Bangalore", enquiry: "Dining Set", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Tapan", customerPhone: "7676060099", channel: "Bangalore", enquiry: "Dining Table", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Gautham", customerPhone: "9900811560", channel: "Bangalore", enquiry: "Box Storage Bed", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Mr. Ararsh", customerPhone: "8791649619", channel: "Bangalore", enquiry: "Dining Table", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Mr. Frutlin", customerPhone: "8508859338", channel: "Bangalore", enquiry: "Non-storage bed", salesperson: "Kishore", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Abhisek ji", customerPhone: "+91 98279 52867", channel: "Bangalore", enquiry: "Budget 1.8 to 2 lakh. Design finalized.", estimatedValue: 190000, salesperson: "Rajveer", stage: "Design & Concept", lastContacted: TODAY, logs: [{ text: "Budget 1.8-2L. Design has been finalized.", author: "Rajveer", createdAt: new Date() }] },
      { customerName: "Parishrut", customerPhone: "8007285999", channel: "Pune", enquiry: "Dining table and sofa set", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Harshita Hadapsar", customerPhone: "9819108661", channel: "Pune", enquiry: "Shoe rack 4x3x2", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Dipti A", customerPhone: "9881867733", channel: "Pune", enquiry: "Sofa set", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Ravi Chavan", customerPhone: "9822888803", channel: "Pune", enquiry: "", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Dhiraj Kothari", customerPhone: "7387099007", channel: "Pune", enquiry: "", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Sandeep", customerPhone: "8983229879", channel: "Pune", enquiry: "Sofa set", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Pratap", customerPhone: "7708111189", channel: "Pune", enquiry: "Mandir", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Ramesh Kumar", customerPhone: "8425081139", channel: "Pune", enquiry: "", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "C H Trishul", customerPhone: "7875942811", channel: "Pune", enquiry: "Rattan furniture", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Shital Bhosle", customerPhone: "7767899882", channel: "Pune", enquiry: "Dining table with 6 chairs and sofa", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Sandeep", customerPhone: "9960138849", channel: "Pune", enquiry: "Sofa set", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Sangeeta", customerPhone: "9818207284", channel: "Pune", enquiry: "Outdoor coffee table with 2 chairs + sofa cum bed", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Biraj Pawar", customerPhone: "9970064422", channel: "Pune", enquiry: "Dining table", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Alhad Rathaparth", customerPhone: "9766090416", channel: "Pune", enquiry: "Double bed + wardrobe + sofa", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "K S", customerPhone: "9834374181", channel: "Pune", enquiry: "Sofa cum bed rattan", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Pankaja mam", customerPhone: "9970714684", channel: "Pune", enquiry: "3 seater sofa", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
      { customerName: "Bhandari mam", customerPhone: "8605423434", channel: "Pune", enquiry: "Dining table (standalone)", salesperson: "Trina", stage: "Lead", lastContacted: TODAY, logs: [] },
    ];
    await Deal.insertMany(deals);
    res.json({ success: true, inserted: deals.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ── END TEMPORARY SEED ROUTES ─────────────────────────────

// ── HEALTH CHECK ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Induscraft OMS API is running", version: "1.0.0" });
});

// ── MONGODB ───────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("MongoDB connected");
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

// ── ERROR HANDLER ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || "Server error" });
});