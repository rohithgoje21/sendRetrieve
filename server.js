const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require('body-parser');
const path = require("path");

const app = express();
const PORT = 8080;

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Connect to MongoDB
mongoose.connect("mongodb://localhost:27017/textDB", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

const textSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    text: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 },
});

const Text = mongoose.model("Text", textSchema);

// Generate a 4-digit unique ID
const generateId = async () => {
    let id;
    let exists;
    do {
        id = Math.floor(1000 + Math.random() * 9000).toString();
        exists = await Text.findOne({ id });
    } while (exists);
    return id;
};

// Endpoint to send text
app.post("/send", async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Text is required" });

    const id = await generateId();
    const newText = new Text({ id, text });
    await newText.save();

    res.json({ id });
});

// Endpoint to retrieve text
app.get("/retrieve/:id", async (req, res) => {
    const { id } = req.params;
    const record = await Text.findOne({ id });
    if (!record)
        return res.status(404).json({ error: "Text not found or expired" });

    res.json({ text: record.text });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
