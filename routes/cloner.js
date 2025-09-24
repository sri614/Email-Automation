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

// Batch check multiple emails at once for better performance
async function batchCheckEmailsExist(emailNames) {
  if (emailNames.length === 0) return {};

  try {
    console.log(`Batch checking ${emailNames.length} emails for existence`);

    // Create a map to store results
    const existsMap = {};

    // Initialize all as not existing
    emailNames.forEach(name => existsMap[name] = false);

    // Check each email individually but with reduced delays (still more efficient than original)
    // HubSpot's search API is complex for exact name matching, so individual checks are more reliable
    for (let i = 0; i < emailNames.length; i += 5) {
      const batch = emailNames.slice(i, i + 5);

      const batchPromises = batch.map(async (emailName) => {
        try {
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

          const exists = response.data.total > 0 || (response.data.results && response.data.results.length > 0);
          return { emailName, exists };
        } catch (error) {
          console.error(`Error checking ${emailName}:`, error.message);
          return { emailName, exists: false };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      batchResults.forEach(result => {
        existsMap[result.emailName] = result.exists;
      });

      // Small delay between batches
      if (i + 5 < emailNames.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    const existingCount = Object.values(existsMap).filter(exists => exists).length;
    console.log(`Batch check completed. Found ${existingCount} existing emails out of ${emailNames.length}`);
    return existsMap;
  } catch (error) {
    console.error('Error in batch email check:', error.response?.data || error.message);
    // Return empty map on error to allow cloning attempts
    const existsMap = {};
    emailNames.forEach(name => existsMap[name] = false);
    return existsMap;
  }
}

// Keep single check for fallback
async function checkEmailExists(emailName) {
  try {
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

    const exists = response.data.total > 0 || (response.data.results && response.data.results.length > 0);
    return exists;
  } catch (error) {
    console.error(`Error checking email existence for "${emailName}":`, error.response?.data || error.message);
    return false;
  }
}

async function cloneAndScheduleEmail(
  originalEmailId,
  dayOffset,
  hour,
  minute,
  strategy = "smart",
  customOptions = {}
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
    console.log(`Scheduled for: ${clonedDate.toISOString()} (${hour}:${minute < 10 ? '0' + minute : minute})`);

    if (strategy === 'custom' && customOptions.customStartHour !== undefined) {
      const startTime = `${customOptions.customStartHour}:${(customOptions.customStartMinute || 0).toString().padStart(2, '0')}`;
      console.log(`Custom timing - Start Time: ${startTime}, Interval: ${customOptions.customInterval} minutes`);
    }

    if (processedEmailsCache.has(newEmailName)) {
      console.log(`Skipped: "${newEmailName}" already in current batch cache`);
      return { success: false, skipped: true, reason: "Duplicate in current batch" };
    }

    // Skip individual duplicate checks here - will be handled in batch
    // This optimization is handled by the new batch processing logic

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

async function EmailCloner(emailIds, cloningCount, strategy = "smart", customOptions = {}) {
  try {
    let stats = {
      totalAttempted: 0,
      successfullyCloned: 0,
      duplicatesSkipped: 0,
      errors: 0,
      clonedEmails: [],
    };

    console.log('🚀 Starting optimized batch processing...');

    // First, get all email names in batch
    console.log('📥 Fetching email information...');
    const emailInfoMap = new Map();

    for (const emailId of emailIds) {
      try {
        const response = await axios.get(`${BASE_URL}/${emailId}`, {
          headers: {
            Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          params: {
            properties: "name"
          }
        });
        emailInfoMap.set(emailId, response.data.name);
      } catch (error) {
        console.error(`Error getting email info for ${emailId}:`, error.message);
        stats.errors++;
      }
    }

    // Generate all email names and schedules
    const emailNamesToCheck = [];
    const emailScheduleMap = new Map();

    for (let day = 1; day <= cloningCount; day++) {
      let morningMinuteCounter = 0;
      let afternoonMinuteCounter = 0;
      let customTimeCounter = 0;
      let emailIndex = 0;
      const MAX_MORNING_SLOTS = 12;

      for (let i = 0; i < emailIds.length; i++) {
        const emailId = emailIds[i];
        const originalEmailName = emailInfoMap.get(emailId);

        if (!originalEmailName) {
          stats.errors++;
          continue;
        }

        let hour, minute;

        // Calculate timing (same logic as before)
        switch (strategy) {
          case "morning":
            hour = 11;
            minute = morningMinuteCounter;
            morningMinuteCounter += 5;
            if (minute >= 60) {
              hour += Math.floor(minute / 60);
              minute = minute % 60;
            }
            break;

          case "afternoon":
            hour = 16;
            minute = afternoonMinuteCounter;
            afternoonMinuteCounter += 5;
            if (minute >= 60) {
              hour += Math.floor(minute / 60);
              minute = minute % 60;
            }
            break;

          case "custom":
            const startHour = customOptions.customStartHour || 11;
            const startMinute = customOptions.customStartMinute || 0;
            const interval = customOptions.customInterval || 5;

            const startTotalMinutes = startHour * 60 + startMinute;
            const scheduledTotalMinutes = startTotalMinutes + (customTimeCounter * interval);

            let scheduledHour = Math.floor(scheduledTotalMinutes / 60);
            let scheduledMinute = scheduledTotalMinutes % 60;

            if (scheduledHour === 11 && scheduledMinute <= 55) {
              hour = scheduledHour;
              minute = scheduledMinute;
            } else if (scheduledHour < 11 || (scheduledHour === 11 && scheduledMinute <= 55)) {
              hour = 11;
              minute = customTimeCounter * interval;
              if (minute > 55) {
                const afternoonOffset = minute - 55 - 1;
                hour = 16;
                minute = afternoonOffset;
                if (minute >= 60) {
                  hour += Math.floor(minute / 60);
                  minute = minute % 60;
                }
              }
            } else {
              const morningSlots = Math.floor(56 / interval);
              const afternoonIndex = customTimeCounter - morningSlots;
              hour = 16;
              minute = afternoonIndex * interval;
              if (minute >= 60) {
                hour += Math.floor(minute / 60);
                minute = minute % 60;
              }
            }
            customTimeCounter++;
            break;

          case "smart":
          default:
            if (emailIndex < MAX_MORNING_SLOTS) {
              hour = 11;
              minute = morningMinuteCounter;
              morningMinuteCounter += 5;
            } else {
              hour = 16;
              minute = afternoonMinuteCounter;
              afternoonMinuteCounter += 5;
            }

            if (minute >= 60) {
              hour += Math.floor(minute / 60);
              minute = minute % 60;
            }
            emailIndex++;
            break;
        }

        // Generate the expected email name
        const datePattern = /\d{2} \w{3} \d{4}/;
        const dateMatch = originalEmailName.match(datePattern);

        if (dateMatch) {
          let clonedDate = new Date(dateMatch[0]);
          clonedDate.setDate(clonedDate.getDate() + day);
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

          emailNamesToCheck.push(newEmailName);
          emailScheduleMap.set(newEmailName, {
            originalEmailId: emailId,
            day,
            hour,
            minute,
            scheduledTime: clonedDate,
            originalEmailName
          });
        } else {
          stats.errors++;
          console.log(`⚠️ No date pattern found in: ${originalEmailName}`);
        }

        stats.totalAttempted++;
      }
    }

    // Batch check for duplicates in MongoDB
    console.log('📊 Batch checking database duplicates...');
    const dbDuplicates = await ClonedEmail.find({
      clonedEmailName: { $in: emailNamesToCheck }
    }).select('clonedEmailName');

    const dbDuplicateNames = new Set(dbDuplicates.map(doc => doc.clonedEmailName));

    // Batch check for duplicates in HubSpot
    console.log('🔍 Batch checking HubSpot duplicates...');
    const hubspotDuplicates = await batchCheckEmailsExist(emailNamesToCheck);

    // Filter out duplicates before processing
    const emailsToProcess = emailNamesToCheck.filter(name => {
      if (processedEmailsCache.has(name) || dbDuplicateNames.has(name) || hubspotDuplicates[name]) {
        stats.duplicatesSkipped++;
        console.log(`⚠️ Skipping duplicate: ${name}`);
        return false;
      }
      processedEmailsCache.add(name);
      return true;
    });

    console.log(`✅ Processing ${emailsToProcess.length} emails (${stats.duplicatesSkipped} duplicates skipped)`);

    // Process remaining emails in parallel batches
    const BATCH_SIZE = 3; // Process 3 emails simultaneously
    for (let i = 0; i < emailsToProcess.length; i += BATCH_SIZE) {
      const batch = emailsToProcess.slice(i, i + BATCH_SIZE);

      const batchPromises = batch.map(async (emailName) => {
        const schedule = emailScheduleMap.get(emailName);
        const result = await cloneAndScheduleEmailOptimized(
          schedule.originalEmailId,
          schedule.day,
          schedule.hour,
          schedule.minute,
          emailName,
          schedule.scheduledTime,
          strategy
        );
        return result;
      });

      const batchResults = await Promise.all(batchPromises);

      batchResults.forEach(result => {
        if (result.success) {
          stats.successfullyCloned++;
          stats.clonedEmails.push({
            id: result.emailId,
            name: result.emailName,
            time: result.scheduledTime,
          });
        } else {
          stats.errors++;
        }
      });

      // Small delay between batches
      if (i + BATCH_SIZE < emailsToProcess.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
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

// Optimized version without redundant duplicate checking
async function cloneAndScheduleEmailOptimized(
  originalEmailId,
  dayOffset,
  hour,
  minute,
  newEmailName,
  scheduledTime,
  strategy = "smart"
) {
  try {
    console.log(`🔄 Cloning: ${originalEmailId} -> "${newEmailName}"`);
    console.log(`⏰ Scheduled for: ${scheduledTime.toISOString()} (${hour}:${minute < 10 ? '0' + minute : minute})`);

    // Get original email with custom properties
    const response = await axios.get(`${BASE_URL}/${originalEmailId}`, {
      headers: {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      params: {
        properties: "name,emailCategory,mdlzBrand"
      }
    });

    const originalEmail = response.data;

    // Extract custom properties
    let emailCategory = originalEmail.emailCategory || originalEmail.properties?.emailCategory || originalEmail.properties?.["Email Category"];
    let mdlzBrand = originalEmail.mdlzBrand || originalEmail.properties?.mdlzBrand || originalEmail.properties?.["MDLZ Brand"];

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
    const publishDateTimestamp = scheduledTime.getTime();

    // Build update payload
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

    // Add custom properties if they exist
    if (emailCategory !== null && emailCategory !== undefined) {
      updateEmailData.emailCategory = emailCategory;
    }
    if (mdlzBrand !== null && mdlzBrand !== undefined) {
      updateEmailData.mdlzBrand = mdlzBrand;
    }

    // Update the cloned email
    await axios.put(`${BASE_URL}/${clonedEmail.id}`, updateEmailData, {
      headers: {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    // Save to MongoDB
    try {
      const clonedEmailRecord = new ClonedEmail({
        originalEmailId: originalEmailId,
        clonedEmailId: clonedEmail.id,
        clonedEmailName: newEmailName,
        scheduledTime: scheduledTime,
        cloningStrategy: strategy,
      });
      await clonedEmailRecord.save();
    } catch (saveError) {
      console.error(`⚠️ MongoDB save error: ${saveError.message}`);
    }

    console.log(`✅ Successfully cloned: "${newEmailName}" (ID: ${clonedEmail.id})`);

    return {
      success: true,
      emailId: clonedEmail.id,
      emailName: newEmailName,
      scheduledTime: scheduledTime.toISOString(),
    };
  } catch (error) {
    console.error(`❌ Error cloning email ${originalEmailId}:`, error.response?.data || error.message);
    return {
      success: false,
      error: error.message,
      details: error.response?.data,
    };
  }
}

router.post("/clone-emails", async (req, res) => {
  const { emailIds, cloningCount, strategy = "smart", customStartHour, customStartMinute, customInterval } = req.body;

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

  // Custom time validation
  if (strategy === "custom") {
    if (customStartHour !== undefined && (isNaN(customStartHour) || customStartHour < 0 || customStartHour > 23)) {
      return res.status(400).json({
        success: false,
        message: "Custom start hour must be between 0 and 23",
      });
    }

    if (customStartMinute !== undefined && (isNaN(customStartMinute) || customStartMinute < 0 || customStartMinute > 59)) {
      return res.status(400).json({
        success: false,
        message: "Custom start minute must be between 0 and 59",
      });
    }

    if (customInterval !== undefined && (isNaN(customInterval) || customInterval < 1 || customInterval > 60)) {
      return res.status(400).json({
        success: false,
        message: "Custom interval must be between 1 and 60 minutes",
      });
    }
  }

  try {
    processedEmailsCache.clear();

    // Build custom options object
    const customOptions = {};
    if (strategy === "custom") {
      customOptions.customStartHour = customStartHour;
      customOptions.customStartMinute = customStartMinute;
      customOptions.customInterval = customInterval;
    }

    const result = await EmailCloner(
      emailIds,
      parseInt(cloningCount, 10),
      strategy,
      customOptions
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