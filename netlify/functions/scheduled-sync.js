const syncHandler = require('./sync').handler;

exports.handler = async function (event, context) {
    console.log('[Cloud Cron] Running 5-minute automatic sync with Sendit...');
    return await syncHandler(event, context);
};

// Runs every 5 minutes in Netlify Cloud
exports.config = {
    schedule: "@every 5m"
};
