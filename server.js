const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require('body-parser');
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 8080;

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Connect to MongoDB
mongoose.connect("mongodb://localhost:27017/dataDB", {
});

// Set up file storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, "uploads");
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath);
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        cb(null, `${file.originalname}-${Date.now()}`);
    }
});
const upload = multer({ storage });

// Define Schema
const dataSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    text: String,
    fileUrl: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 },
});

const Data = mongoose.model("Data", dataSchema);

// Generate a 4-digit unique ID
const generateId = async () => {
    let id;
    let exists;
    do {
        id = Math.floor(1000 + Math.random() * 9000).toString();
        exists = await Data.findOne({ id });
    } while (exists);
    return id;
};

// Endpoint to send data (text or file)
app.post("/send", upload.single("file"), async (req, res) => {
    const { text } = req.body;
    const file = req.file;

    if (!text && !file) {
        return res.status(400).json({ error: "Text or file is required" });
    }

    const id = await generateId();
    const fileUrl = file ? `/uploads/${file.filename}` : null;

    const newData = new Data({ id, text, fileUrl });
    await newData.save();

    res.json({ id });
});

// Endpoint to retrieve data
app.get("/retrieve/:id", async (req, res) => {
    const { id } = req.params;
    const record = await Data.findOne({ id });

    if (!record) {
        return res.status(404).json({ error: "Data not found or expired" });
    }

    res.json({ text: record.text, fileUrl: record.fileUrl });
});

// Serve the index.html file
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
