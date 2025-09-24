require('dotenv').config();
const express = require("express");
const router = express.Router();
const axios = require('axios');
const Segmentation = require('../models/segmentation');
const CreatedList = require('../models/list');

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

const updateRecentDate = async (contactIds, dateValue) => {
  const epochMidnight = new Date(dateValue);
  epochMidnight.setUTCHours(0, 0, 0, 0);
  const epochTime = epochMidnight.getTime().toString();

  const chunks = chunkArray(contactIds, 100);
  console.log(`🕓 Updating recent_marketing_email_sent_date for ${contactIds.length} contacts`);

  for (const chunk of chunks) {
    const payload = {
      inputs: chunk.map(contactId => ({
        id: contactId.toString(),
        properties: {
          recent_marketing_email_sent_date: epochTime
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
  const { brand, campaign, primaryListId, secondaryListId, count, domain, date, sendContactListId } = config;

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
    await updateRecentDate(selectedContacts, date);
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

router.get('/list-cleaner', async (req, res) => {
  const showAll = req.query.show === 'all';
  const filter = showAll ? {} : { deleted: { $ne: true } };
  const lists = await CreatedList.find(filter).lean();
  res.render('deletedLists', {
    lists,
    showAll,
    pageTitle: "List Cleaning",
    activePage: "list cleaning"
  });
});

router.post('/delete-lists', async (req, res) => {
  const selectedIds = Array.isArray(req.body.selectedIds) ? req.body.selectedIds : [req.body.selectedIds];

  for (const _id of selectedIds) {
    try {
      const list = await CreatedList.findById(_id);
      if (!list || list.deleted) continue;

      await axios.delete(`https://api.hubapi.com/contacts/v1/lists/${list.listId}`, {
        headers: hubspotHeaders
      });

      list.deleted = true;
      await list.save();
      console.log(`🗑️ Deleted list: ${list.name} | ID: ${list.listId}`);
    } catch (err) {
      console.error(`❌ Error deleting list ${_id}:`, err.message);
      await CreatedList.findByIdAndUpdate(_id, { deleted: false });
    }
    await new Promise(r => setTimeout(r, 500));
  }

  res.redirect('/api/list-cleaner?show=all');
});

module.exports = router;