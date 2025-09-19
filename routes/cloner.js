const express = require("express");
const router = express.Router();
const axios = require("axios");
const mongoose = require("mongoose");
require("dotenv").config();

const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const BASE_URL = process.env.BASE_URL;

// Import your ClonedEmail model
const ClonedEmail = require("../models/clonedEmail");

const processedEmailsCache = new Set();

async function checkEmailExists(emailName) {
  try {
    console.log(`Checking if email exists: "${emailName}"`);

    const response = await axios.get(`${BASE_URL}`, {
      params: {
        name: emailName,
        limit: 1,
      },
      headers: {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    console.log(`API Response for "${emailName}":`, {
      total: response.data.total,
      count: response.data.results?.length || 0,
      status: response.status
    });

    // Check both total count and results array
    const exists = response.data.total > 0 || (response.data.results && response.data.results.length > 0);
    console.log(`Email "${emailName}" exists: ${exists}`);

    return exists;
  } catch (error) {
    console.error(
      `Error checking email existence for "${emailName}":`,
      error.response?.data || error.message
    );
    // Return false on error to allow cloning attempt
    return false;
  }
}

async function cloneAndScheduleEmail(
  originalEmailId,
  dayOffset,
  hour,
  minute,
  strategy = "smart"
) {
  try {
    // First, get the original email with ALL properties including custom ones
    const response = await axios.get(`${BASE_URL}/${originalEmailId}`, {
      headers: {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      // IMPORTANT: Use the properties parameter to get custom properties
      params: {
        properties: "name,emailCategory,mdlzBrand" // Add all custom properties here
      }
    });

    const originalEmail = response.data;
    const originalEmailName = originalEmail.name;

    // Extract custom HubSpot properties - try different possible locations
    let emailCategory = null;
    let mdlzBrand = null;

    // Method 1: Check if properties are in the root object
    if (originalEmail.emailCategory !== undefined) {
      emailCategory = originalEmail.emailCategory;
    }
    if (originalEmail.mdlzBrand !== undefined) {
      mdlzBrand = originalEmail.mdlzBrand;
    }

    // Method 2: Check if properties are in a properties object (common HubSpot pattern)
    if (originalEmail.properties && originalEmail.properties.emailCategory) {
      emailCategory = originalEmail.properties.emailCategory;
    }
    if (originalEmail.properties && originalEmail.properties.mdlzBrand) {
      mdlzBrand = originalEmail.properties.mdlzBrand;
    }

    // Method 3: Check for different property name formats
    if (originalEmail.properties && originalEmail.properties["Email Category"]) {
      emailCategory = originalEmail.properties["Email Category"];
    }
    if (originalEmail.properties && originalEmail.properties["MDLZ Brand"]) {
      mdlzBrand = originalEmail.properties["MDLZ Brand"];
    }

    const datePattern = /\d{2} \w{3} \d{4}/;
    const dateMatch = originalEmailName.match(datePattern);

    if (!dateMatch) {
      return {
        success: false,
        skipped: true,
        reason: "No date in original email name",
      };
    }

    let clonedDate = new Date(dateMatch[0]);
    clonedDate.setDate(clonedDate.getDate() + dayOffset);
    clonedDate.setHours(hour, minute, 0, 0);

    const updatedDate = clonedDate
      .toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
      .replace(",", "")
      .replace("Sept", "Sep");

    const newEmailName = originalEmailName.replace(dateMatch[0], updatedDate);

    console.log(`Processing email: ${originalEmailId} -> "${newEmailName}"`);

    if (processedEmailsCache.has(newEmailName)) {
      console.log(`Skipped: "${newEmailName}" already in current batch cache`);
      return { success: false, skipped: true, reason: "Duplicate in current batch" };
    }

    // Check MongoDB for duplicates first (faster than API call)
    try {
      const existingInDB = await ClonedEmail.findOne({
        clonedEmailName: newEmailName
      });

      if (existingInDB) {
        console.log(`Skipped: "${newEmailName}" already exists in database`);
        return { success: false, skipped: true, reason: "Duplicate in database" };
      }
    } catch (dbError) {
      console.error(`Error checking MongoDB: ${dbError.message}`);
      // Continue with cloning despite database check error
    }

    // Check HubSpot for duplicates
    const emailExists = await checkEmailExists(newEmailName);
    if (emailExists) {
      console.log(`Skipped: "${newEmailName}" already exists in HubSpot`);
      return { success: false, skipped: true, reason: "Duplicate in HubSpot" };
    }

    processedEmailsCache.add(newEmailName);

    // Clone the email
    const cloneResponse = await axios.post(
      `${BASE_URL}/${originalEmailId}/clone`,
      {},
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    const clonedEmail = cloneResponse.data;
    const publishDateTimestamp = clonedDate.getTime();

    // Build the update payload
    const updateEmailData = {
      name: newEmailName,
      mailingIlsListsExcluded: [10469],
      mailingIlsListsIncluded: [39067],
      mailingListsExcluded: [6591],
      mailingListsIncluded: [31189],
      publishImmediately: false,
      publishDate: publishDateTimestamp,
      isGraymailSuppressionEnabled: false,
    };

    // Add custom properties to the update payload
    // Use the exact internal property names that HubSpot expects
    if (emailCategory !== null && emailCategory !== undefined) {
      updateEmailData.emailCategory = emailCategory;
    }
    if (mdlzBrand !== null && mdlzBrand !== undefined) {
      updateEmailData.mdlzBrand = mdlzBrand;
    }

    // Update the cloned email with custom properties
    await axios.put(`${BASE_URL}/${clonedEmail.id}`, updateEmailData, {
      headers: {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    // Save to MongoDB with enhanced error handling
    try {
      const clonedEmailRecord = new ClonedEmail({
        originalEmailId: originalEmailId,
        clonedEmailId: clonedEmail.id,
        clonedEmailName: newEmailName,
        scheduledTime: clonedDate,
        cloningStrategy: strategy,
        // Don't save custom properties in MongoDB (as requested)
      });
      await clonedEmailRecord.save();
    } catch (saveError) {
      console.error(`Error saving to MongoDB: ${saveError.message}`);
      // Continue despite save error - the email was still cloned in HubSpot
    }

    console.log(`✅ Successfully cloned: "${newEmailName}" (ID: ${clonedEmail.id})`);

    return {
      success: true,
      emailId: clonedEmail.id,
      emailName: newEmailName,
      scheduledTime: clonedDate.toISOString(),
    };
  } catch (error) {
    console.error(
      `Error cloning email ${originalEmailId}:`,
      error.response?.data || error.message
    );
    return {
      success: false,
      error: error.message,
      details: error.response?.data,
    };
  }
}



// Add a debug endpoint to check email properties
router.get("/debug-email/:emailId", async (req, res) => {
  try {
    const emailId = req.params.emailId;
    const response = await axios.get(`${BASE_URL}/${emailId}`, {
      headers: {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      params: {
        properties: "name,emailCategory,mdlzBrand"
      }
    });

    res.json({
      success: true,
      data: response.data,
      properties: response.data.properties
    });
  } catch (error) {
    console.error("Debug error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Failed to debug email.",
      error: error.message,
      details: error.response?.data,
    });
  }
});

async function EmailCloner(emailIds, cloningCount, strategy = "smart") {
  try {
    let stats = {
      totalAttempted: 0,
      successfullyCloned: 0,
      duplicatesSkipped: 0,
      errors: 0,
      clonedEmails: [],
    };

    for (let day = 1; day <= cloningCount; day++) {
      let minuteCounter = 0;
      let morningSlotsUsed = 0;
      const MAX_MORNING_SLOTS = 12;

      for (let i = 0; i < emailIds.length; i++) {
        const emailId = emailIds[i];
        let hour, minute;

        switch (strategy) {
          case "morning":
            hour = 11;
            minute = minuteCounter;
            minuteCounter += 5;
            break;

          case "afternoon":
            hour = 16;
            minute = minuteCounter;
            minuteCounter += 5;
            break;

          case "custom":
            hour = 11;
            minute = minuteCounter;
            minuteCounter += 5;
            break;

          default:
            if (morningSlotsUsed < MAX_MORNING_SLOTS) {
              hour = 11;
              minute = minuteCounter;
              minuteCounter += 5;
              morningSlotsUsed++;
            } else {
              hour = 16;
              minute = minuteCounter - MAX_MORNING_SLOTS * 5;
            }
        }

        stats.totalAttempted++;

        const result = await cloneAndScheduleEmail(
          emailId,
          day,
          hour,
          minute,
          strategy
        );

        if (result.success) {
          stats.successfullyCloned++;
          stats.clonedEmails.push({
            id: result.emailId,
            name: result.emailName,
            time: result.scheduledTime,
          });
        } else if (result.skipped) {
          stats.duplicatesSkipped++;
        } else {
          stats.errors++;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000)); // Rate limiting
      }
    }

    return {
      success: true,
      message: `Email cloning completed. ${stats.successfullyCloned} cloned, ${stats.duplicatesSkipped} duplicates skipped, ${stats.errors} errors.`,
      stats: stats,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to complete cloning process: ${error.message}`,
      error: error,
    };
  }
}

router.post("/clone-emails", async (req, res) => {
  const { emailIds, cloningCount, strategy = "smart" } = req.body;

  // input validation
  if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Please provide at least one valid email ID",
    });
  }

  if (!cloningCount || isNaN(cloningCount)) {
    return res.status(400).json({
      success: false,
      message: "Please provide a valid cloning count",
    });
  }

  try {
    processedEmailsCache.clear();

    const result = await EmailCloner(
      emailIds,
      parseInt(cloningCount, 10),
      strategy
    );

    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        stats: result.stats,
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.message,
        error: result.error,
      });
    }
  } catch (error) {
    console.error("Cloning error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to clone emails.",
      error: error.message,
    });
  }
});

// Add a new route to get all cloned emails from the database
// GET /api/cloned-emails?date=YYYY-MM-DD (optional date filter)
router.get("/cloned-emails", async (req, res) => {
  try {
    let query = {};
    if (req.query.date) {
      // Parse date and filter for that day (00:00:00 to 23:59:59)
      const start = new Date(req.query.date);
      const end = new Date(start);
      end.setDate(start.getDate() + 1);
      query.scheduledTime = { $gte: start, $lt: end };
    }
    const clonedEmails = await ClonedEmail.find(query).sort({ createdAt: -1 });
    res.json({
      success: true,
      data: clonedEmails
    });
  } catch (error) {
    console.error("Error fetching cloned emails:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch cloned emails.",
      error: error.message,
    });
  }
});

// Add a route to delete cloned emails from database and HubSpot
router.delete("/cloned-emails/:id", async (req, res) => {
  try {
    const clonedEmail = await ClonedEmail.findById(req.params.id);
    if (!clonedEmail) {
      return res.status(404).json({
        success: false,
        message: "Cloned email not found",
      });
    }

    let hubspotDeleted = false;
    let hubspotError = null;

    // Try to delete from HubSpot first using the same BASE_URL pattern as other API calls
    if (clonedEmail.clonedEmailId) {
      try {
        console.log(`Attempting to delete email ${clonedEmail.clonedEmailId} from HubSpot using URL: ${BASE_URL}/${clonedEmail.clonedEmailId}`);

        const deleteResponse = await axios.delete(
          `${BASE_URL}/${clonedEmail.clonedEmailId}`,
          {
            headers: {
              Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );

        hubspotDeleted = true;
        console.log(`✓ Successfully deleted email ${clonedEmail.clonedEmailId} from HubSpot. Response status: ${deleteResponse.status}`);
      } catch (hubspotErr) {
        hubspotError = hubspotErr.response?.data?.message || hubspotErr.message;
        console.error(`✗ Failed to delete email ${clonedEmail.clonedEmailId} from HubSpot:`, hubspotError);
        console.error('HubSpot API Error Details:', hubspotErr.response?.data || hubspotErr.message);
      }
    }

    // Delete from database regardless of HubSpot result
    await ClonedEmail.findByIdAndDelete(req.params.id);

    const responseMessage = hubspotDeleted
      ? "Cloned email deleted successfully from both database and HubSpot"
      : hubspotError
        ? `Cloned email deleted from database, but failed to delete from HubSpot: ${hubspotError}`
        : "Cloned email deleted from database (no HubSpot ID found)";

    res.json({
      success: true,
      message: responseMessage,
      hubspotDeleted,
      hubspotError
    });
  } catch (error) {
    console.error("Error deleting cloned email:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete cloned email.",
      error: error.message,
    });
  }
});

// Publish email endpoint - matches the working implementation
router.post("/publish-email", async (req, res) => {
  const { emailId, scheduleTime } = req.body;

  try {
    // Prepare request body for HubSpot API
    const requestBody = scheduleTime
      ? { sendAt: new Date(scheduleTime).getTime() }
      : {};

    // Call HubSpot API to publish the email
    const response = await axios.post(
      `https://api.hubapi.com/marketing/v3/emails/${emailId}/publish`,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Update database if email exists
    try {
      const clonedEmail = await ClonedEmail.findOne({ clonedEmailId: emailId });
      if (clonedEmail) {
        clonedEmail.status = 'published';
        clonedEmail.publishedAt = new Date();
        if (scheduleTime) {
          clonedEmail.scheduledTime = new Date(scheduleTime);
        }
        await clonedEmail.save();
      }
    } catch (dbError) {
      console.log('Database update error (non-critical):', dbError.message);
    }

    res.json({
      success: true,
      message: scheduleTime ? 'Email scheduled successfully' : 'Email published immediately',
      data: response.data
    });

  } catch (error) {
    console.error('API Error:', {
      status: error.response?.status,
      message: error.message,
      response: error.response?.data
    });

    res.status(500).json({
      success: false,
      message: error.response?.data?.message || 'Failed to publish email',
      error: error.response?.data || error.message
    });
  }
});

router.get("/cloner", async (req, res) => {
  try {
    res.status(200).render("cloner", {
      pageTitle: "Email cloning",
      activePage: "email cloning",
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: "Unable to get emails" });
  }
});

module.exports = router;