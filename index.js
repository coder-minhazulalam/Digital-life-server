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

// Upgrade user to Premium (mock payment)
app.patch("/users/upgrade-premium", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const updateDoc = { isPremium: true, updatedAt: new Date() };

    // Update in 'user' collection (Better Auth primary collection)
    const result1 = await db
      .collection("user")
      .updateOne({ email }, { $set: updateDoc });

    // Also update in 'users' collection as fallback
    await db
      .collection("users")
      .updateOne({ email }, { $set: updateDoc }, { upsert: false });

    if (result1.matchedCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ success: true, message: "User upgraded to Premium successfully" });
  } catch (err) {
    console.error("Error upgrading user to premium:", err);
    res.status(500).json({ message: "Failed to upgrade user" });
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

// 4.5 Get user's own lessons (both public & private)
app.get("/lessons/my", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ message: "User email query parameter is required" });
    }

    const lessons = await db
      .collection("lessons")
      .find({ creatorEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(lessons);
  } catch (err) {
    console.error("Error fetching user lessons:", err);
    res.status(500).json({ message: "Failed to fetch user lessons" });
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

// 6. Create a new lesson
app.post("/lessons", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);

    const {
      title,
      description,
      category,
      emotionalTone,
      visibility,
      accessLevel,
      creatorName,
      creatorEmail,
      creatorPhoto,
    } = req.body;

    // Validation
    if (!title || !description || !category || !emotionalTone || !creatorEmail) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const newLesson = {
      title: title.trim(),
      description: description.trim(),
      category,
      emotionalTone,
      visibility: visibility || "Public",
      accessLevel: accessLevel || "Free",
      isFeatured: false,
      likes: [],
      likesCount: 0,
      savesCount: 0,
      creatorName: creatorName || "Anonymous",
      creatorEmail,
      creatorPhoto: creatorPhoto || "",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("lessons").insertOne(newLesson);

    res.status(201).json({
      success: true,
      message: "Lesson created successfully",
      lessonId: result.insertedId,
      lesson: { ...newLesson, _id: result.insertedId },
    });
  } catch (err) {
    console.error("Error creating lesson:", err);
    res.status(500).json({ message: "Failed to create lesson" });
  }
});

// 7. Update an existing lesson
app.put("/lessons/:id", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { id } = req.params;
    const {
      title,
      description,
      category,
      emotionalTone,
      visibility,
      accessLevel,
    } = req.body;

    const query = ObjectId.isValid(id)
      ? { $or: [{ _id: new ObjectId(id) }, { _id: id }] }
      : { _id: id };

    const updateDoc = {
      ...(title !== undefined && { title: title.trim() }),
      ...(description !== undefined && { description: description.trim() }),
      ...(category !== undefined && { category }),
      ...(emotionalTone !== undefined && { emotionalTone }),
      ...(visibility !== undefined && { visibility }),
      ...(accessLevel !== undefined && { accessLevel }),
      updatedAt: new Date(),
    };

    const result = await db.collection("lessons").updateOne(query, { $set: updateDoc });

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Lesson not found" });
    }

    res.json({ success: true, message: "Lesson updated successfully" });
  } catch (err) {
    console.error("Error updating lesson:", err);
    res.status(500).json({ message: "Failed to update lesson" });
  }
});

// 8. Delete a lesson
app.delete("/lessons/:id", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { id } = req.params;

    const query = ObjectId.isValid(id)
      ? { $or: [{ _id: new ObjectId(id) }, { _id: id }] }
      : { _id: id };

    const result = await db.collection("lessons").deleteOne(query);

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Lesson not found" });
    }

    res.json({ success: true, message: "Lesson deleted successfully" });
  } catch (err) {
    console.error("Error deleting lesson:", err);
    res.status(500).json({ message: "Failed to delete lesson" });
  }
});

// 9. Quick toggle lesson visibility (Public <-> Private)
app.patch("/lessons/:id/visibility", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { id } = req.params;
    const { visibility } = req.body;

    if (!visibility || !["Public", "Private"].includes(visibility)) {
      return res.status(400).json({ message: "Invalid visibility value" });
    }

    const query = ObjectId.isValid(id)
      ? { $or: [{ _id: new ObjectId(id) }, { _id: id }] }
      : { _id: id };

    const result = await db
      .collection("lessons")
      .updateOne(query, { $set: { visibility, updatedAt: new Date() } });

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Lesson not found" });
    }

    res.json({ success: true, message: `Visibility updated to ${visibility}` });
  } catch (err) {
    console.error("Error updating visibility:", err);
    res.status(500).json({ message: "Failed to update visibility" });
  }
});

// ==========================================
// 10. LIKES SYSTEM
// ==========================================

// Toggle like for a lesson
app.post("/lessons/:id/like", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { id } = req.params;
    const { userEmail } = req.body;

    if (!userEmail) {
      return res.status(400).json({ message: "User email is required" });
    }

    const lessonQuery = ObjectId.isValid(id)
      ? { $or: [{ _id: new ObjectId(id) }, { _id: id }] }
      : { _id: id };

    const lesson = await db.collection("lessons").findOne(lessonQuery);
    if (!lesson) {
      return res.status(404).json({ message: "Lesson not found" });
    }

    const likesArray = Array.isArray(lesson.likes) ? lesson.likes : [];
    const isAlreadyLiked = likesArray.includes(userEmail);

    let updatedLesson;
    if (isAlreadyLiked) {
      // Unlike
      await db.collection("lessons").updateOne(lessonQuery, {
        $pull: { likes: userEmail },
        $inc: { likesCount: -1 },
      });
      // Also delete from likes collection for tracking
      await db.collection("likes").deleteOne({ lessonId: id, userEmail });

      // Fetch fresh count
      updatedLesson = await db.collection("lessons").findOne(lessonQuery);
      const newCount = Math.max(0, updatedLesson?.likesCount ?? (likesArray.length - 1));
      if (updatedLesson?.likesCount < 0) {
        await db.collection("lessons").updateOne(lessonQuery, { $set: { likesCount: 0 } });
      }

      return res.json({
        success: true,
        isLiked: false,
        likesCount: newCount,
        message: "Lesson unliked",
      });
    } else {
      // Like
      await db.collection("lessons").updateOne(lessonQuery, {
        $addToSet: { likes: userEmail },
        $inc: { likesCount: 1 },
      });
      // Store in likes collection
      await db.collection("likes").insertOne({
        lessonId: id,
        userEmail,
        createdAt: new Date(),
      });

      updatedLesson = await db.collection("lessons").findOne(lessonQuery);
      return res.json({
        success: true,
        isLiked: true,
        likesCount: updatedLesson?.likesCount ?? (likesArray.length + 1),
        message: "Lesson liked",
      });
    }
  } catch (err) {
    console.error("Error toggling like:", err);
    res.status(500).json({ message: "Failed to toggle like" });
  }
});

// Check if a user has liked a lesson
app.get("/lessons/:id/like-status", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { id } = req.params;
    const { email } = req.query;

    const lessonQuery = ObjectId.isValid(id)
      ? { $or: [{ _id: new ObjectId(id) }, { _id: id }] }
      : { _id: id };

    const lesson = await db.collection("lessons").findOne(lessonQuery);
    if (!lesson) {
      return res.status(404).json({ message: "Lesson not found" });
    }

    const likesArray = Array.isArray(lesson.likes) ? lesson.likes : [];
    const isLiked = email ? likesArray.includes(email) : false;

    res.json({
      isLiked,
      likesCount: lesson.likesCount ?? likesArray.length,
    });
  } catch (err) {
    console.error("Error fetching like status:", err);
    res.status(500).json({ message: "Failed to fetch like status" });
  }
});

// ==========================================
// 11. FAVORITES / SAVES SYSTEM
// ==========================================

// Toggle save/favorite for a lesson
app.post("/favorites/toggle", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { userEmail, lessonId } = req.body;

    if (!userEmail || !lessonId) {
      return res.status(400).json({ message: "userEmail and lessonId are required" });
    }

    const lessonQuery = ObjectId.isValid(lessonId)
      ? { $or: [{ _id: new ObjectId(lessonId) }, { _id: lessonId }] }
      : { _id: lessonId };

    const existing = await db.collection("favorites").findOne({
      userEmail,
      lessonId: String(lessonId),
    });

    if (existing) {
      // Remove from favorites
      await db.collection("favorites").deleteOne({ _id: existing._id });
      await db.collection("lessons").updateOne(lessonQuery, {
        $inc: { savesCount: -1 },
      });

      const updated = await db.collection("lessons").findOne(lessonQuery);
      const savesCount = Math.max(0, updated?.savesCount ?? 0);
      if (updated?.savesCount < 0) {
        await db.collection("lessons").updateOne(lessonQuery, { $set: { savesCount: 0 } });
      }

      return res.json({
        success: true,
        saved: false,
        savesCount,
        message: "Removed from favorites",
      });
    } else {
      // Add to favorites
      await db.collection("favorites").insertOne({
        userEmail,
        lessonId: String(lessonId),
        savedAt: new Date(),
      });
      await db.collection("lessons").updateOne(lessonQuery, {
        $inc: { savesCount: 1 },
      });

      const updated = await db.collection("lessons").findOne(lessonQuery);
      return res.json({
        success: true,
        saved: true,
        savesCount: updated?.savesCount ?? 1,
        message: "Saved to favorites",
      });
    }
  } catch (err) {
    console.error("Error toggling favorite:", err);
    res.status(500).json({ message: "Failed to toggle favorite" });
  }
});

// Check if a specific lesson is saved by user
app.get("/favorites/status", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { email, lessonId } = req.query;

    if (!email || !lessonId) {
      return res.status(400).json({ message: "email and lessonId query parameters required" });
    }

    const existing = await db.collection("favorites").findOne({
      userEmail: email,
      lessonId: String(lessonId),
    });

    res.json({ isSaved: !!existing });
  } catch (err) {
    console.error("Error fetching favorite status:", err);
    res.status(500).json({ message: "Failed to fetch favorite status" });
  }
});

// Get all saved lessons for a user
app.get("/favorites/user", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ message: "User email query parameter is required" });
    }

    const favs = await db
      .collection("favorites")
      .find({ userEmail: email })
      .sort({ savedAt: -1 })
      .toArray();

    if (!favs || favs.length === 0) {
      return res.json([]);
    }

    // Look up full lesson details for each favorite
    const lessonIds = favs.map((f) => f.lessonId);
    const objectIds = lessonIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));

    const lessons = await db
      .collection("lessons")
      .find({
        $or: [{ _id: { $in: objectIds } }, { _id: { $in: lessonIds } }],
      })
      .toArray();

    // Map savedAt into lesson records
    const lessonMap = new Map();
    lessons.forEach((l) => {
      lessonMap.set(String(l._id), l);
    });

    const enriched = favs
      .map((f) => {
        const lesson = lessonMap.get(String(f.lessonId));
        if (!lesson) return null;
        return {
          ...lesson,
          favoriteId: f._id,
          savedAt: f.savedAt,
        };
      })
      .filter(Boolean);

    res.json(enriched);
  } catch (err) {
    console.error("Error fetching user favorites:", err);
    res.status(500).json({ message: "Failed to fetch favorites" });
  }
});

// ==========================================
// 12. COMMENTS SYSTEM
// ==========================================

// Get comments for a lesson
app.get("/comments", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { lessonId } = req.query;

    if (!lessonId) {
      return res.status(400).json({ message: "lessonId query parameter is required" });
    }

    const comments = await db
      .collection("comments")
      .find({ lessonId: String(lessonId) })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(comments);
  } catch (err) {
    console.error("Error fetching comments:", err);
    res.status(500).json({ message: "Failed to fetch comments" });
  }
});

// Post a new comment
app.post("/comments", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { lessonId, userEmail, userName, userPhoto, commentText } = req.body;

    if (!lessonId || !userEmail || !commentText || !commentText.trim()) {
      return res.status(400).json({ message: "lessonId, userEmail, and commentText are required" });
    }

    const newComment = {
      lessonId: String(lessonId),
      userEmail,
      userName: userName || "Anonymous Learner",
      userPhoto: userPhoto || "",
      commentText: commentText.trim(),
      createdAt: new Date(),
    };

    const result = await db.collection("comments").insertOne(newComment);

    res.status(201).json({
      success: true,
      comment: {
        ...newComment,
        _id: result.insertedId,
      },
      message: "Comment added successfully",
    });
  } catch (err) {
    console.error("Error adding comment:", err);
    res.status(500).json({ message: "Failed to add comment" });
  }
});

// Delete a comment (by author or admin)
app.delete("/comments/:id", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { id } = req.params;
    const { userEmail } = req.query;

    const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
    const comment = await db.collection("comments").findOne(query);

    if (!comment) {
      return res.status(404).json({ message: "Comment not found" });
    }

    // Check ownership or admin
    if (userEmail && comment.userEmail !== userEmail) {
      const user = await db.collection("user").findOne({ email: userEmail });
      if (user?.role !== "admin") {
        return res.status(403).json({ message: "Unauthorized to delete this comment" });
      }
    }

    await db.collection("comments").deleteOne(query);
    res.json({ success: true, message: "Comment deleted successfully" });
  } catch (err) {
    console.error("Error deleting comment:", err);
    res.status(500).json({ message: "Failed to delete comment" });
  }
});

// ==========================================
// 13. LESSON REPORTS SYSTEM
// ==========================================

// Submit a report
app.post("/reports", async (req, res) => {
  try {
    if (!db) db = client.db(DB_NAME);
    const { lessonId, lessonTitle, reporterEmail, reason } = req.body;

    if (!lessonId || !reporterEmail || !reason) {
      return res.status(400).json({ message: "Missing required report fields" });
    }

    const newReport = {
      lessonId: String(lessonId),
      lessonTitle: lessonTitle || "Untitled Lesson",
      reporterEmail,
      reason,
      status: "pending",
      timestamp: new Date(),
    };

    const result = await db.collection("lessonsReports").insertOne(newReport);

    res.status(201).json({
      success: true,
      reportId: result.insertedId,
      message: "Report submitted successfully for review",
    });
  } catch (err) {
    console.error("Error submitting report:", err);
    res.status(500).json({ message: "Failed to submit report" });
  }
});

connectToMongoDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
});
