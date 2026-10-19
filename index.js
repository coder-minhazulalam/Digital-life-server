const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const DB_NAME = process.env.MONGODB_DB || process.env.DB_NAME || "digital-life-lessons";

if (!MONGO_URI) {
  console.error("Error: MONGO_URI or MONGODB_URI is not set in .env");
}

const client = new MongoClient(MONGO_URI);
let db;

async function connectToMongoDB() {
  try {
    await client.connect();
    db = client.db(DB_NAME);
    console.log(`Connected successfully to MongoDB database: "${DB_NAME}"`);
    return db;
  } catch (err) {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  }
}

app.get("/", (req, res) => {
  res.send({ status: "ok", message: "Digital Life Lessons API Server is running" });
});

// Get featured lessons (for homepage)
app.get("/lessons/featured", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const featuredLessons = await db
      .collection("lessons")
      .find({
        $or: [{ isFeatured: true }, { isFeatured: "true" }],
        visibility: { $ne: "Private" },
      })
      .limit(6)
      .toArray();

    // If less than 4 featured, fallback to newest public lessons to ensure homepage has lessons
    if (!featuredLessons || featuredLessons.length < 4) {
      const publicLessons = await db
        .collection("lessons")
        .find({ visibility: { $ne: "Private" } })
        .limit(4)
        .toArray();
      return res.json(publicLessons);
    }

    res.json(featuredLessons);
  } catch (err) {
    console.error("Error fetching featured lessons:", err);
    res.status(500).json({ message: "Failed to fetch featured lessons" });
  }
});

// Get all lessons with optional filtering / sorting / pagination
app.get("/lessons", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);

    const { category, emotionalTone, search, sort, page = 1, limit = 9 } = req.query;

    let filter = { visibility: { $ne: "Private" } };

    if (category && category !== "All") {
      filter.category = category;
    }

    if (emotionalTone && emotionalTone !== "All") {
      filter.emotionalTone = emotionalTone;
    }

    if (search && search.trim() !== "") {
      const searchRegex = new RegExp(search.trim(), "i");
      filter.$or = [
        { title: searchRegex },
        { description: searchRegex },
        { category: searchRegex },
      ];
    }

    let sortOption = { createdAt: -1 }; // newest by default
    if (sort === "most-saved") {
      sortOption = { savesCount: -1 };
    } else if (sort === "most-liked") {
      sortOption = { likesCount: -1 };
    } else if (sort === "oldest") {
      sortOption = { createdAt: 1 };
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = parseInt(limit, 10) || 9;
    const skip = (pageNum - 1) * limitNum;

    const totalCount = await db.collection("lessons").countDocuments(filter);
    const lessons = await db
      .collection("lessons")
      .find(filter)
      .sort(sortOption)
      .skip(skip)
      .limit(limitNum)
      .toArray();

    res.json({
      lessons,
      totalCount,
      totalPages: Math.ceil(totalCount / limitNum),
      currentPage: pageNum,
    });
  } catch (err) {
    console.error("Error fetching lessons:", err);
    res.status(500).json({ message: "Failed to fetch lessons" });
  }
});

// Get single lesson by id
app.get("/lessons/:id", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { id } = req.params;

    const query = ObjectId.isValid(id)
      ? { $or: [{ _id: new ObjectId(id) }, { _id: id }] }
      : { _id: id };

    const lesson = await db.collection("lessons").findOne(query);
    if (!lesson) {
      return res.status(404).json({ message: "Lesson not found" });
    }

    res.json(lesson);
  } catch (err) {
    console.error("Error fetching single lesson:", err);
    res.status(500).json({ message: "Failed to fetch lesson" });
  }
});

connectToMongoDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
});
