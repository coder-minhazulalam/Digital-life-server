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

// User Profile Endpoints
app.get("/users/profile/:email", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { email } = req.params;

    // Check user in 'user' collection (Better Auth) or 'users'
    const user =
      (await db.collection("user").findOne({ email })) ||
      (await db.collection("users").findOne({ email }));

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Get user stats (total lessons created, total likes, total saves)
    const userLessonsCount = await db
      .collection("lessons")
      .countDocuments({ creatorEmail: email });

    const lessonsStats = await db
      .collection("lessons")
      .aggregate([
        { $match: { creatorEmail: email } },
        {
          $group: {
            _id: null,
            totalLikes: { $sum: { $ifNull: ["$likesCount", 0] } },
            totalSaves: { $sum: { $ifNull: ["$savesCount", 0] } },
          },
        },
      ])
      .toArray();

    const stats = lessonsStats[0] || { totalLikes: 0, totalSaves: 0 };

    res.json({
      ...user,
      totalLessons: userLessonsCount,
      totalLikes: stats.totalLikes,
      totalSaves: stats.totalSaves,
    });
  } catch (err) {
    console.error("Error fetching user profile:", err);
    res.status(500).json({ message: "Failed to fetch user profile" });
  }
});

app.patch("/users/profile", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { email, name, image, photoURL } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const finalPhoto = image || photoURL;
    const updateDoc = {
      ...(name && { name: name.trim() }),
      ...(finalPhoto !== undefined && {
        image: finalPhoto.trim(),
        photoURL: finalPhoto.trim(),
      }),
      updatedAt: new Date(),
    };

    // Update 'user' collection
    await db.collection("user").updateOne({ email }, { $set: updateDoc });

    // Update 'users' collection as well
    await db.collection("users").updateOne({ email }, { $set: updateDoc }, { upsert: true });

    // Also update creatorName and creatorPhoto in user's lessons so changes reflect platform-wide!
    if (name || finalPhoto) {
      const lessonUpdates = {};
      if (name) lessonUpdates.creatorName = name.trim();
      if (finalPhoto) lessonUpdates.creatorPhoto = finalPhoto.trim();

      await db
        .collection("lessons")
        .updateMany({ creatorEmail: email }, { $set: lessonUpdates });
    }

    res.json({ success: true, message: "Profile updated successfully" });
  } catch (err) {
    console.error("Error updating user profile:", err);
    res.status(500).json({ message: "Failed to update profile" });
  }
});

// 1. Get featured lessons (for homepage)
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

// 2. Dynamic Section: Top Contributors of the Week
app.get("/lessons/top-contributors", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const contributors = await db
      .collection("lessons")
      .aggregate([
        { $match: { visibility: { $ne: "Private" } } },
        {
          $group: {
            _id: "$creatorEmail",
            creatorName: { $first: "$creatorName" },
            creatorPhoto: { $first: "$creatorPhoto" },
            creatorEmail: { $first: "$creatorEmail" },
            totalLessons: { $sum: 1 },
            totalLikes: { $sum: { $ifNull: ["$likesCount", 0] } },
            totalSaves: { $sum: { $ifNull: ["$savesCount", 0] } },
          },
        },
        { $sort: { totalLessons: -1, totalLikes: -1 } },
        { $limit: 4 },
      ])
      .toArray();

    res.json(contributors);
  } catch (err) {
    console.error("Error fetching top contributors:", err);
    res.status(500).json({ message: "Failed to fetch top contributors" });
  }
});

// 3. Dynamic Section: Most Saved Lessons
app.get("/lessons/most-saved", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const mostSaved = await db
      .collection("lessons")
      .find({ visibility: { $ne: "Private" } })
      .sort({ savesCount: -1 })
      .limit(4)
      .toArray();

    res.json(mostSaved);
  } catch (err) {
    console.error("Error fetching most saved lessons:", err);
    res.status(500).json({ message: "Failed to fetch most saved lessons" });
  }
});

// 4. Get all lessons with optional filtering / sorting / pagination
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

    let sortOption = { createdAt: -1 };
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

// 5. Get single lesson by id
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
