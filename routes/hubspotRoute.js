require('dotenv').config();
const express = require("express");
const router = express.Router();
const axios = require('axios');
const Segmentation = require('../models/segmentation');
const CreatedList = require('../models/list');

// Authentication middleware
function ensureAuthenticated(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// Config
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;
const CONCURRENCY_LIMIT = 1;
const RETRIEVAL_BATCH_SIZE = parseInt(process.env.HUBSPOT_RETRIEVAL_BATCH_SIZE) || 1000;
const MAX_RETRIES = parseInt(process.env.HUBSPOT_MAX_RETRIES) || 3;
const INTER_LIST_DELAY_MS = parseInt(process.env.HUBSPOT_INTER_LIST_DELAY_MINUTES || 3) * 60 * 1000;

const hubspotHeaders = {
  Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
};

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const getFormattedDate = (dateInput) => {
  const date = new Date(dateInput);
  return `${date.getDate()} ${monthNames[date.getMonth()]} ${date.getFullYear()}`;
};

// Updated getFilteredDate function to handle all possible date filters
const getFilteredDate = (daysFilter) => {
  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  
  if (daysFilter === 'today') return today.toISOString().split('T')[0];
  
  if (daysFilter.startsWith('t+')) {
    const daysToAdd = parseInt(daysFilter.slice(2));
    if (isNaN(daysToAdd)) return null;
    
    const futureDate = new Date(today);
    futureDate.setUTCDate(today.getUTCDate() + daysToAdd);
    return futureDate.toISOString().split('T')[0];
  }
  
  return null;
};

const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
};

const progressiveChunks = (arr, sizes = [300, 100, 50, 1]) => {
  const result = [];
  let index = 0;
  for (const size of sizes) {
    while (index < arr.length) {
      const chunk = arr.slice(index, index + size);
      if (!chunk.length) break;
      result.push(chunk);
      index += size;
    }
  }
  return result;
};

const getContactsFromList = async (listId, maxCount = Infinity) => {
  let allContacts = [];
  let hasMore = true;
  let offset = 0;
  let retryCount = 0;

  while (hasMore && retryCount < MAX_RETRIES && allContacts.length < maxCount) {
    try {
      const countToFetch = Math.min(RETRIEVAL_BATCH_SIZE, maxCount - allContacts.length);
      const res = await axios.get(
        `https://api.hubapi.com/contacts/v1/lists/${listId}/contacts/all`,
        {
          headers: hubspotHeaders,
          params: { count: countToFetch, vidOffset: offset }
        }
      );

      const contacts = res.data.contacts || [];
      allContacts.push(...contacts.map(c => c.vid));
      hasMore = res.data['has-more'] && allContacts.length < maxCount;
      offset = res.data['vid-offset'];
      retryCount = 0;

      if (allContacts.length >= maxCount) {
        allContacts = allContacts.slice(0, maxCount);
        break;
      }
    } catch (error) {
      retryCount++;
      console.error(`⚠️ Error fetching contacts from list ${listId}, retry ${retryCount}:`, error.message);
      if (retryCount < MAX_RETRIES) await new Promise(r => setTimeout(r, 1000 * retryCount));
      else hasMore = false;
    }
  }

  return [...new Set(allContacts)];
};

const createHubSpotList = async (name) => {
  console.log(`📝 Creating list: ${name}`);
  try {
    const res = await axios.post(
      'https://api.hubapi.com/contacts/v1/lists',
      { name, dynamic: false },
      { headers: hubspotHeaders }
    );
    return res.data;
  } catch (error) {
    console.error(`❌ Failed to create list: ${name}`, error.message);
    throw error;
  }
};

const addContactsToList = async (listId, contacts) => {
  const chunks = progressiveChunks(contacts);
  for (const chunk of chunks) {
    try {
      await axios.post(
        `https://api.hubapi.com/contacts/v1/lists/${listId}/add`,
        { vids: chunk },
        { headers: hubspotHeaders }
      );
      console.log(`✅ Added chunk of ${chunk.length} contacts to list ${listId}`);
      await new Promise(r => setTimeout(r, 500));
    } catch (error) {
      console.error(`❌ Failed to add contacts to list ${listId}`, error.message);
      throw error;
    }
  }
};

const updateContactProperties = async (contactIds, dateValue, brandValue) => {
  const epochMidnight = new Date(dateValue);
  epochMidnight.setUTCHours(0, 0, 0, 0);
  const epochTime = epochMidnight.getTime().toString();

  const chunks = chunkArray(contactIds, 100);
  console.log(`🕓 Updating properties for ${contactIds.length} contacts`);

  for (const chunk of chunks) {
    const payload = {
      inputs: chunk.map(contactId => ({
        id: contactId.toString(),
        properties: {
          recent_marketing_email_sent_date: epochTime,
          last_marketing_email_sent_brand: brandValue
        }
      }))
    };

    try {
      await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts/batch/update',
        payload,
        { headers: hubspotHeaders }
      );
      console.log(`✅ Updated batch of ${chunk.length} contacts`);
    } catch (err) {
      console.error(`❌ Failed batch update:`, err.response?.data || err.message);
      console.error(`🧪 Failing IDs:`, chunk);
    }

    await new Promise(r => setTimeout(r, 300));
  }
};

const processSingleCampaign = async (config, daysFilter, modeFilter, usedContactsSet) => {
  const { brand, campaign, primaryListId, secondaryListId, count, domain, date, sendContactListId, lastMarketingEmailSentBrand } = config;

  console.log(`\n🚀 Starting campaign: ${campaign} | Brand: ${brand} | Domain: ${domain}`);
  
  // Get contacts with enhanced tracking
  let primaryContacts = await getContactsFromList(primaryListId, count * 2);
  const primaryBeforeFilter = primaryContacts.length;
  primaryContacts = primaryContacts.filter(vid => !usedContactsSet.has(vid));
  const primaryAfterFilter = primaryContacts.length;
  
  console.log(`📥 Primary List: ${primaryBeforeFilter} available | ${primaryBeforeFilter - primaryAfterFilter} filtered | ${primaryAfterFilter} remaining`);

  let secondaryContacts = [];
  let secondaryBeforeFilter = 0;
  let secondaryAfterFilter = 0;
  
  if (primaryAfterFilter < count && secondaryListId) {
    secondaryContacts = await getContactsFromList(secondaryListId, (count - primaryAfterFilter) * 2);
    secondaryBeforeFilter = secondaryContacts.length;
    secondaryContacts = secondaryContacts.filter(vid => !usedContactsSet.has(vid));
    secondaryAfterFilter = secondaryContacts.length;
    console.log(`📥 Secondary List: ${secondaryBeforeFilter} available | ${secondaryBeforeFilter - secondaryAfterFilter} filtered | ${secondaryAfterFilter} remaining`);
  }

  const allContacts = [...primaryContacts, ...secondaryContacts];
  const selectedContacts = allContacts.slice(0, count);
  selectedContacts.forEach(vid => usedContactsSet.add(vid));
  
  const fulfillmentPercentage = Math.round((selectedContacts.length / count) * 100);
  console.log(`✂️ Final Selection: ${selectedContacts.length} of ${count} requested (${fulfillmentPercentage}%)`);

  const listName = `${brand} - ${campaign} - ${domain} - ${getFormattedDate(date)}`;

  const [newList] = await Promise.all([
    createHubSpotList(listName),
    selectedContacts.length ? addContactsToList(sendContactListId, selectedContacts) : Promise.resolve()
  ]);

  if (selectedContacts.length) {
    await addContactsToList(newList.listId, selectedContacts);
    await updateContactProperties(selectedContacts, date, lastMarketingEmailSentBrand);
  }

  const createdList = await CreatedList.create({
    name: listName,
    listId: newList.listId,
    createdDate: new Date(),
    deleted: newList.deleted,
    filterCriteria: { days: daysFilter, mode: modeFilter },
    campaignDetails: { brand, campaign, date },
    contactCount: selectedContacts.length,
    requestedCount: count,
    availableCount: primaryBeforeFilter + secondaryBeforeFilter,
    filteredCount: (primaryBeforeFilter - primaryAfterFilter) + (secondaryBeforeFilter - secondaryAfterFilter),
    fulfillmentPercentage
  });

  console.log(`✅ List created: ${listName} | ID: ${newList.listId}`);

  return {
    success: true,
    listName,
    listId: newList.listId,
    contactCount: selectedContacts.length,
    requestedCount: count,
    availableCount: primaryBeforeFilter + secondaryBeforeFilter,
    filteredCount: (primaryBeforeFilter - primaryAfterFilter) + (secondaryBeforeFilter - secondaryAfterFilter),
    fulfillmentPercentage,
    createdList
  };
};

const processCampaignsWithDelay = async (listConfigs, daysFilter, modeFilter) => {
  const results = [];
  const usedContacts = new Set();

  console.log(`\n🚦 Starting campaign execution with ${INTER_LIST_DELAY_MS / 60000} min delay`);

  for (const [index, config] of listConfigs.entries()) {
    const startTime = Date.now();
    const currentIndex = index + 1;
    const total = listConfigs.length;

    console.log(`\n📋 [${currentIndex}/${total}] Processing: ${config.campaign}`);
    try {
      const result = await processSingleCampaign(config, daysFilter, modeFilter, usedContacts);
      results.push({ status: 'fulfilled', value: result });

      if (index < total - 1) {
        const elapsed = Date.now() - startTime;
        const delay = Math.max(0, INTER_LIST_DELAY_MS - elapsed);
        console.log(`⏳ Waiting ${Math.round(delay / 1000)} seconds before next campaign`);
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (error) {
      console.error(`❌ Campaign failed: ${config.campaign} | ${error.message}`);
      results.push({ status: 'rejected', reason: error });

      const elapsed = Date.now() - startTime;
      const delay = Math.max(0, INTER_LIST_DELAY_MS - elapsed);
      if (index < listConfigs.length - 1) {
        console.log(`⏳ Waiting ${Math.round(delay / 1000)} seconds after failure`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  const successful = results.filter(r => r.status === 'fulfilled');
  const failed = results.filter(r => r.status === 'rejected');
  
  console.log(`\n🎯 Campaign run complete`);
  console.log(`✅ Success: ${successful.length}`);
  console.log(`❌ Failed: ${failed.length}`);
  console.log(`📊 Total Requested: ${listConfigs.reduce((sum, c) => sum + c.count, 0)}`);
  console.log(`📊 Total Fulfilled: ${successful.reduce((sum, r) => sum + r.value.contactCount, 0)}`);
  console.log(`📊 Average Fulfillment: ${Math.round(successful.reduce((sum, r) => sum + r.value.fulfillmentPercentage, 0) / (successful.length || 1))}%`);

  return results;
};

// Updated route handler with better validation
router.post('/create-lists', async (req, res) => {
  try {
    const { daysFilter, modeFilter } = req.body;
    console.log(`📨 Received request to create lists | Filters → Days: ${daysFilter}, Mode: ${modeFilter}`);

    // Validate input parameters
    const validDaysFilters = ['today', 't+1', 't+2', 't+3', 'all'];
    const validModeFilters = ['BAU', 're-engagement', 're-activation'];
    
    if (!daysFilter || !validDaysFilters.includes(daysFilter)) {
      return res.status(400).json({ 
        error: 'Invalid date filter',
        message: `Valid values are: ${validDaysFilters.join(', ')}`,
        received: daysFilter
      });
    }

    if (!modeFilter || !validModeFilters.includes(modeFilter)) {
      return res.status(400).json({ 
        error: 'Invalid mode filter',
        message: `Valid values are: ${validModeFilters.join(', ')}`,
        received: modeFilter
      });
    }

    let query = {};

    if (daysFilter && daysFilter !== 'all') {
      const filterDate = getFilteredDate(daysFilter);
      if (!filterDate) {
        return res.status(400).json({ 
          error: 'Invalid date filter value',
          message: 'Could not calculate date from filter',
          received: daysFilter
        });
      }
      query.date = filterDate;
    }

    if (modeFilter && modeFilter !== 'BAU') {
      query.campaign = { $regex: modeFilter === 're-engagement' ? /re-engagement/i : /re-activation/i };
    } else if (modeFilter === 'BAU') {
      query.$and = [
        { campaign: { $not: { $regex: /re-engagement/i } } },
        { campaign: { $not: { $regex: /re-activation/i } } }
      ];
    }

    const listConfigs = await Segmentation.find(query).sort({ order: 1 }).lean();
    if (!listConfigs.length) {
      return res.status(404).json({ 
        error: 'No campaigns match the selected filters',
        filters: { daysFilter, modeFilter }
      });
    }

    res.json({
      message: `🚀 Background processing started with ${INTER_LIST_DELAY_MS / 60000}-minute delay`,
      count: listConfigs.length,
      firstCampaign: listConfigs[0]?.campaign || 'None',
      totalContactsRequested: listConfigs.reduce((sum, c) => sum + c.count, 0),
      estimatedCompletionTime: `${Math.ceil(listConfigs.length * INTER_LIST_DELAY_MS / 3600000)} hrs ${Math.ceil((listConfigs.length * INTER_LIST_DELAY_MS % 3600000) / 60000)} mins`
    });

    setImmediate(async () => {
      try {
        await processCampaignsWithDelay(listConfigs, daysFilter, modeFilter);
      } catch (error) {
        console.error('❌ Overall process failed:', error.message);
      }
    });

  } catch (error) {
    console.error('Error in /create-lists:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Rest of the routes remain unchanged
router.get('/created-lists', async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const endOfDay = new Date(startOfDay);
    endOfDay.setUTCDate(startOfDay.getUTCDate() + 1);

    const lists = await CreatedList.find({
      createdDate: {
        $gte: startOfDay,
        $lt: endOfDay
      }
    }).sort({ createdDate: -1 }).lean();

    res.json(lists);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch created lists' });
  }
});

// Updated route for List Manager
router.get('/list-manager', ensureAuthenticated, async (req, res) => {
  try {
    const showAll = req.query.show === 'all';
    const jsonFormat = req.query.json === 'true';
    const filter = showAll ? {} : { deleted: { $ne: true } };
    
    const lists = await CreatedList.find(filter)
      .sort({ createdDate: -1 })
      .lean();

    const formattedLists = lists.map(list => ({
      ...list,
      formattedDate: formatDateForDisplay(list.createdDate),
      createdDate: list.createdDate
    }));

    // Always return JSON when json=true is specified
    if (jsonFormat) {
      return res.json(formattedLists);
    }

    return res.render('listManager', {
      lists: formattedLists,
      showAll,
      pageTitle: "List Manager",
      activePage: "list manager"
    });

  } catch (error) {
    console.error('Error:', error);
    if (req.query.json === 'true') {
      return res.status(500).json({ error: 'Server error' });
    }
    res.status(500).send('Server error');
  }
});

// Keep old route for backward compatibility
router.get('/list-cleaner', ensureAuthenticated, async (req, res) => {
  try {
    const showAll = req.query.show === 'all';
    const jsonFormat = req.query.json === 'true';
    const filter = showAll ? {} : { deleted: { $ne: true } };
    
    const lists = await CreatedList.find(filter)
      .sort({ createdDate: -1 })
      .lean();

    const formattedLists = lists.map(list => ({
      ...list,
      formattedDate: formatDateForDisplay(list.createdDate),
      createdDate: list.createdDate
    }));

    // Always return JSON when json=true is specified
    if (jsonFormat) {
      return res.json(formattedLists);
    }

    return res.render('deletedLists', {
      lists: formattedLists,
      showAll,
      pageTitle: "List Cleaner",
      activePage: "list cleaning"
    });

  } catch (error) {
    console.error('Error:', error);
    if (req.query.json === 'true') {
      return res.status(500).json({ error: 'Server error' });
    }
    return res.status(500).send('Server error');
  }
});
// Date formatting helper
function formatDateForDisplay(date) {
  const d = new Date(date);
  const day = d.getDate();
  const month = d.toLocaleString('en-US', { month: 'short' });
  const year = d.getFullYear();
  let hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  
  return `${day} ${month} ${year} ${hours}:${minutes}${ampm}`;
}

// Fetch HubSpot property options for last_marketing_email_sent_brand
router.get('/hubspot-brand-options', ensureAuthenticated, async (req, res) => {
  try {
    const response = await axios.get(
      'https://api.hubapi.com/crm/v3/properties/contacts/last_marketing_email_sent_brand',
      { headers: hubspotHeaders }
    );

    const options = response.data.options || [];
    const formattedOptions = options.map(opt => ({
      label: opt.label,
      value: opt.value
    }));

    res.json({
      success: true,
      options: formattedOptions
    });
  } catch (error) {
    console.error('Error fetching HubSpot brand options:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: 'Failed to fetch brand options from HubSpot'
    });
  }
});

// Include a HubSpot list in an email
router.post('/include-list-in-email', ensureAuthenticated, async (req, res) => {
  const { emailId, listId, emailName, listName } = req.body;

  try {
    console.log(`\n📧 Including list in email:`);
    console.log(`  Email: ${emailName} (ID: ${emailId})`);
    console.log(`  List: ${listName} (ID: ${listId})`);

    // First, get the current email details using v1 API
    const emailResponse = await axios.get(
      `https://api.hubapi.com/marketing-emails/v1/emails/${emailId}`,
      { headers: hubspotHeaders }
    );

    const currentEmail = emailResponse.data;
    console.log(`  Email retrieved. Current state: ${currentEmail.state || 'DRAFT'}`);
    console.log(`  Current mailingListsIncluded: ${JSON.stringify(currentEmail.mailingListsIncluded || [])}`);
    console.log(`  Current mailingListsExcluded: ${JSON.stringify(currentEmail.mailingListsExcluded || [])}`);

    // Check if email is in DRAFT state (required for updates)
    if (currentEmail.state && currentEmail.state !== 'DRAFT') {
      console.log(`  ⚠️ Email is in ${currentEmail.state} state. Only DRAFT emails can be updated.`);
      return res.json({
        success: false,
        message: `Email is in ${currentEmail.state} state. Only DRAFT emails can have their lists updated. Please ensure the email is in DRAFT state in HubSpot.`,
        data: currentEmail,
        note: 'Email must be in DRAFT state to update recipients'
      });
    }

    // Get existing lists and ensure they're STRINGS (v1 API expects strings), removing duplicates
    const existingIncludedLists = [...new Set((currentEmail.mailingListsIncluded || []).map(id =>
      String(id)
    ))];

    const existingExcludedLists = (currentEmail.mailingListsExcluded || []).map(id =>
      String(id)
    );

    // Convert the new listId to string (v1 API expects strings)
    const listIdStr = String(listId);

    // Check if list is already included
    if (existingIncludedLists.includes(listIdStr)) {
      console.log(`  ℹ️ List ${listId} is already included in this email`);
      return res.json({
        success: true,
        message: 'List is already included in this email',
        emailId: emailId,
        listId: listId
      });
    }

    // Use the v1 API with PUT method (matching the curl exactly)
    console.log(`  Using v1 API with PUT method...`);

    // Create updated list without duplicates - all as STRINGS
    const updatedIncludeLists = [...new Set([...existingIncludedLists, listIdStr])];

    // Build payload matching curl structure - with STRING arrays
    const updatePayload = {
      mailingListsIncluded: updatedIncludeLists
    };

    // Preserve excluded lists if they exist - as STRINGS
    if (existingExcludedLists && existingExcludedLists.length > 0) {
      updatePayload.mailingListsExcluded = existingExcludedLists;
      console.log(`  Preserving excluded lists: ${existingExcludedLists}`);
    }

    console.log(`  Final payload:`, JSON.stringify(updatePayload, null, 2));

    const updateResponse = await axios.put(
      `https://api.hubapi.com/marketing-emails/v1/emails/${emailId}`,
      updatePayload,
      { headers: hubspotHeaders }
    );

    console.log(`✅ Successfully updated email using v1 API PUT`);

    // Return success immediately - no verification needed
    return res.json({
      success: true,
      message: `List successfully added to email`,
      emailId: emailId,
      listId: listId,
      updatedIncludedLists: updatedIncludeLists,
      updatedExcludedLists: existingExcludedLists
    });

  } catch (error) {
    console.error('❌ HubSpot API error:', error.response?.data || error.message);

    if (error.response?.data) {
      console.error('Full error details:', JSON.stringify(error.response.data, null, 2));
    }

    // Provide more specific error messages
    let errorMessage = 'Failed to include list in email';
    if (error.response?.status === 404) {
      errorMessage = `Email ${emailId} or list ${listId} not found in HubSpot`;
    } else if (error.response?.status === 401) {
      errorMessage = 'HubSpot authentication failed - check access token';
    } else if (error.response?.status === 400) {
      errorMessage = `Invalid request - ${error.response?.data?.message || 'check email and list IDs'}`;
    } else if (error.response?.status === 403) {
      errorMessage = 'Permission denied - this email may be locked or require manual configuration';
    } else if (error.response?.data?.message) {
      errorMessage = error.response.data.message;
    }

    res.status(error.response?.status || 500).json({
      success: false,
      message: errorMessage,
      details: error.response?.data || error.message,
      suggestion: 'If this is a cloned email, you may need to add lists manually in the HubSpot UI'
    });
  }
});



module.exports = router;