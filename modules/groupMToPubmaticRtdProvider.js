/**
 * This module adds the groupMToPubmatic provider to the Real Time Data module (rtdModule).
 * The {@link module:modules/realTimeData} module is required.
 * @module modules/groupMToPubmaticRtdProvider
 * @requires module:modules/realTimeData
 */
import { submodule } from '../src/hook.js';

/**
 * @typedef {import('../modules/rtdModule/index.js').RtdSubmodule} RtdSubmodule
 */
const SUBMODULE_NAME = 'groupMToPubmatic';
const GROUP_M_BIDDER_CODE = 'groupm';
const PUBMATIC_BIDDER_CODE = 'pubmatic';
const GROUP_M_DEAL_ID = 'GM';

/**
 * Initialize the groupMToPubmatic RTD Module.
 * @returns {boolean}
 */
function init() {
  return true; // required to return true for modules to not be skipped
}

/**
 * Set bidderCode to 'pubmatic' for 'groupm' bids that does not have dealId = 'GM'
 * @param {Object} bidResponse
 */
function onBidResponseEvent(bidResponse) {
  if (bidResponse.bidderCode === GROUP_M_BIDDER_CODE && bidResponse.dealId !== GROUP_M_DEAL_ID) {
    bidResponse.bidderCode = PUBMATIC_BIDDER_CODE;
  }
}

export const groupMToPubmaticRtdSubmodule = {
  name: SUBMODULE_NAME,
  init: init,
  onBidResponseEvent,
};

submodule('realTimeData', groupMToPubmaticRtdSubmodule);
