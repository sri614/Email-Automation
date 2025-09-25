const express = require("express");
const router = express.Router();
const Segmentation = require("../models/segmentation");
const CreatedList = require("../models/list");

// 🔒 Middleware to protect private routes
function ensureAuthenticated(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}
 


router.get("/login", async (req, res) => {
  try {
    res.render("login", {
        pageTitle: "create list",
      activePage: "create list"
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: "Unable to get emails" });
  }
});


// ✔️ CREATE email (protected)
router.post("/add-email", ensureAuthenticated, async (req, res) => {
  try {
    const newEmail = new Segmentation(req.body);
    await newEmail
      .save()
      .then((savedEmail) => {
        console.log("saved:", savedEmail);
        res.status(200).redirect("/");
      })
      .catch((error) => {
        console.log(error);
      });
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: "unable to create new Email" });
  }
});

// ✔️ READ all emails (protected)
router.get("/", ensureAuthenticated, async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const endOfDay = new Date(startOfDay);
    endOfDay.setUTCDate(startOfDay.getUTCDate() + 1);

    const lists = await CreatedList.find({
      createdDate: { $gte: startOfDay, $lt: endOfDay }
    }).sort({ createdDate: -1 }).lean();

    await Segmentation.find().sort({ order: 1 }).lean()
      .then((emails) => {
        res.status(200).render("index", {
          emails: JSON.parse(JSON.stringify(emails)),
          hasEmails: emails.length > 0,
          lists: JSON.parse(JSON.stringify(lists)),
          hasLists: lists.length > 0,
          isEdit: false,
          pageTitle: "create list",
          activePage: "create list",
        });
      })
      .catch((error) => {
        console.log(error);
        res.status(500).json({ msg: "Unable to get emails" });
      });
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: "Unable to get emails" });
  }
});

// ✔️ UPDATE (protected)
router.put("/email/:id/edit", ensureAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    const updatedEmail = req.body;
    await Segmentation.findOneAndUpdate({ _id: id }, updatedEmail, { new: true })
      .then((updatedEmail) => {
        console.log("updated:", updatedEmail);
        res.redirect("/");
      })
      .catch((error) => {
        console.log(error);
        res.status(500).json({ msg: "Unable to update the contact" });
      });
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: "Unable to update the contact" });
  }
});

// ✔️ UPDATE DATE ONLY (protected)
router.put("/email/:id/update-date", ensureAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    const { date } = req.body;

    if (!date) {
      return res.status(400).json({ msg: "Date is required" });
    }

    await Segmentation.findByIdAndUpdate(
      id,
      { date: date }, // Store as string, not Date object
      { new: true }
    )
      .then((updatedEmail) => {
        console.log("Date updated for:", id);
        res.status(200).json({ success: true, email: updatedEmail });
      })
      .catch((error) => {
        console.log(error);
        res.status(500).json({ msg: "Unable to update the date" });
      });
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: "Unable to update the date" });
  }
});

// ✔️ DELETE (protected)
router.delete("/email/:id", ensureAuthenticated, async (req, res) => {
  try {
    const id = req.params.id;
    await Segmentation.findByIdAndDelete(id)
      .then((deletedEmail) => {
        console.log("deleted", deletedEmail);
        res.redirect("/");
      })
      .catch((error) => {
        console.log(error);
        res.status(500).json({ msg: "Unable to delete the email" });
      });
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: "Unable to delete the email" });
  }
});

// ✔️ SEGMENTATION REORDER (protected)
router.post('/api/segmentations/reorder', ensureAuthenticated, async (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ success: false, message: "Invalid input" });
  }

  try {
    const bulkOps = orderedIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { order: index } }
      }
    }));

    await Segmentation.bulkWrite(bulkOps);
    res.json({ success: true });
  } catch (err) {
    console.error("Reorder failed:", err);
    res.status(500).json({ success: false });
  }
});

// ✔️ DOCS PAGE (protected)
// Updated route for Email Publisher
router.get('/email-publisher', ensureAuthenticated, async (req, res) => {
  try {
    res.render("emailPublisher", {
      pageTitle: "Email Publisher",
      activePage: "email publisher",
    });
  } catch (err) {
    console.error("failed:", err);
    res.status(500).json({ success: false });
  }
});

// Keep old route for backward compatibility
router.get('/docs', ensureAuthenticated, async (req, res) => {
  try {
    res.render("docs", {
      pageTitle: "docs",
      activePage: "docs",
    });
  } catch (err) {
    console.error("failed:", err);
    res.status(500).json({ success: false });
  }
});

// ✔️ REPORT PAGE (protected)
router.get('/report', ensureAuthenticated, async (req, res) => {
  try {
    res.render("report", {
      pageTitle: "Report",
      activePage: "report",
    });
  } catch (err) {
    console.error("Report route failed:", err);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
