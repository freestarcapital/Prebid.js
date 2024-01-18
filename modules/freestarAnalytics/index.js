import {ajax} from '../../src/ajax.js';
import adapter from '../../libraries/analyticsAdapter/AnalyticsAdapter.js';
import CONSTANTS from '../../src/constants.json';
import {default as adapterManager} from '../../src/adapterManager.js';
import {generateUUID, logError} from '../../src/utils.js';

const analyticsType = 'endpoint';
const url = 'https://us-central1-freestar-157323.cloudfunctions.net/';

const pageviewId = generateUUID();
const siteId = window.freestar.fsdata.siteId || 0;

const URLS = {
  PAGEVIEW: 'https://us-central1-freestar-157323.cloudfunctions.net/f6r_d7y_pageview',
  BIDWON: 'https://us-central1-freestar-157323.cloudfunctions.net/f6r_d7y_prebid-bidswon_raw_v1'
}

const handlePageview = () => {
  sendEvent({
    'domain': location.host,
  }, URLS.PAGEVIEW);
}

const handlerBidWon = (args) => {
  args = JSON.stringify(JSON.parse(args));
  const keys = Object.keys(args);
  for(let i = 0; i < keys.length; i++) {
    if (allowedParams.indexOf(keys[i]) === -1) {
      delete args[keys[i]];
    }
  }
  sendEvent(args, URLS.BIDWON);
}

const disallowedParams = ['ad'];
const allowedParams = ['pageviewId','bidder','width','height','adId','requestId','transactionId','auctionId','mediaType','source','cpm','creativeId','originalCpm','responseTime','requestTime','adUnitCode','timeToRespond','size']

const sendEvent = (args, url) => {
  args = Object.assign(args, {
    pageviewId,
    siteId
  });
  console.log('sendEvent', args, url);
  ajax(url, undefined, JSON.stringify(args), {method: 'POST'});
}

let freestarAnalytics = Object.assign(adapter({url, analyticsType}), {
  track: function(event) {
    const { eventType, args } = event;
    try {
      switch (eventType) {
        case CONSTANTS.EVENTS.BID_WON:
          handlerBidWon(args);
          break;
      }
    } catch (error) {
      logError('Error on FS Analytics Adapter', error);
    }
  }
});

freestarAnalytics.originEnableAnalytics = freestarAnalytics.enableAnalytics;

freestarAnalytics.enableAnalytics = function (config) {
  initOptions = config.options;
  freestarAnalytics.originEnableAnalytics(config);
  handlePageview();
};

adapterManager.registerAnalyticsAdapter({
  adapter: freestarAnalytics,
  code: 'freestarAnalytics',
  gvlid: 1
});

export default freestarAnalytics;