// JM: Prebid 1-1.37 compatible 02/26/2019
// added per story ENG-2599 
var bidfactory = require('../src/bidfactory.js');
var adloader = require('../src/adloader.js');
var utils = require('../src/utils.js');
var adapterManager = require('../src/adaptermanager');
var _addBidResponse;
var _done;
var responsesProcessed = {};
var UDM_ADAPTER_VERSION = '1-1.37C';
var UDM_VENDOR_ID = '159';

var UnderdogMediaAdapter = function UnderdogMediaAdapter() {
  utils.logMessage(`Initializing UDM Adapter. PBJS Version: ${$$PREBID_GLOBAL$$.version} with adapter version: ${UDM_ADAPTER_VERSION}  Updated/tested 20190226`);
  var getJsStaticUrl = window.location.protocol + '//bid.underdog.media/udm_header_lib.js';
  $$PREBID_GLOBAL$$.handleUnderdogMediaCB = function () { };
  function _callBids(bidderRequest, addBidResponse, done) {
    _addBidResponse = addBidResponse;
    _done = done;
    var gdpr = {
      gdprApplies: false,
      consentGiven: true,
      consentData: ''
    }
    if (bidderRequest && bidderRequest.gdprConsent) {
      if (typeof bidderRequest.gdprConsent.gdprApplies !== 'undefined') {
        gdpr.gdprApplies = !!(bidderRequest.gdprConsent.gdprApplies);
      }
      if (bidderRequest.gdprConsent.vendorData && bidderRequest.gdprConsent.vendorData.vendorConsents &&
        typeof bidderRequest.gdprConsent.vendorData.vendorConsents[UDM_VENDOR_ID] !== 'undefined') {
        gdpr.consentGiven = !!(bidderRequest.gdprConsent.vendorData.vendorConsents[UDM_VENDOR_ID]);
      }
      if (typeof bidderRequest.gdprConsent.consentString !== 'undefined') {
        gdpr.consentData = bidderRequest.gdprConsent.consentString;
      }
    }

    if (!gdpr.gdprApplies || gdpr.consentGiven) {
      if (typeof window.udm_header_lib === 'undefined') {
        adloader.loadScript(getJsStaticUrl, function () {
          bid(bidderRequest);
        });
      } else {
        bid(bidderRequest);
      }
    } else {
      let sid = bidderRequest.bids[0].params.siteId;
      adloader.loadScript(`${window.location.protocol}//udmserve.net/udm/img.fetch?tid=1;dt=9;sid=${sid};gdprApplies=${gdpr.gdprApplies};consentGiven=${gdpr.consentGiven};`, function () {
        utils.logWarn('UDM Request Cancelled - No GDPR Consent');
        _done();
      })
    }
  }

  function bid(bidderRequest) {
    responsesProcessed[bidderRequest.auctionId] = 0;
    var bids = bidderRequest.bids;
    var mappedBids = [];
    for (var i = 0; i < bids.length; i++) {
      var bidRequest = bids[i];
      var callback = bidResponseCallback(bidRequest, bids.length);
      mappedBids.push({
        auctionId: bidRequest.auctionId,
        auctionStart: bidderRequest.auctionStart,
        auctionTimeout: bidderRequest.timeout,
        bidder: bidRequest.bidder,
        sizes: bidRequest.sizes,
        siteId: bidRequest.params.siteId,
        bidfloor: bidRequest.params.bidfloor,
        adunitcode: bidRequest.adUnitCode,
        placementCode: bidRequest.adUnitCode,
        divId: bidRequest.params.divId,
        subId: bidRequest.params.subId,
        callback: callback
      });
    }
    var udmBidRequest = new window.udm_header_lib.BidRequestArray(mappedBids);
    udmBidRequest.send();
  }

  function bidResponseCallback(bid, bids) {
    return function (bidResponse) {
      bidResponseAvailable(bid, bidResponse, bids);
    };
  }

  function bidResponseAvailable(bidRequest, bidResponse, bids) {
    if (bidResponse.bids.length > 0) {
      for (var i = 0; i < bidResponse.bids.length; i++) {
        var udmBid = bidResponse.bids[i];
        var bid = bidfactory.createBid(1, bidRequest);
        if (udmBid.udmDebug) {
          bid.udmDebug = udmBid.udmDebug;
        }
        bid.requestId = bidRequest.bidId;
        bid.cpm = udmBid.cpm;
        bid.width = udmBid.width;
        bid.height = udmBid.height;
        bid.ttl = 60;
        bid.netRevenue = false;
        bid.currency = 'USD';
        bid.bidderCode = bidRequest.bidder;
        bid.auctionId = bidRequest.auctionId;
        bid.adUnitCode = bidRequest.adUnitCode;
        bid.trueBidder = udmBid.bidderCode;
        bid.creativeId = udmBid.creativeId;

        if (udmBid.ad_url !== undefined) {
          bid.adUrl = udmBid.ad_url;
        } else if (udmBid.ad_html !== undefined) {
          bid.ad = udmBid.ad_html.replace('UDM_ADAPTER_VERSION', UDM_ADAPTER_VERSION);
        } else {
          utils.logMessage('Underdogmedia bid is lacking both ad_url and ad_html, skipping bid');
          continue;
        }
        _addBidResponse(bidRequest.adUnitCode, bid);
      }
    } else {
      var nobid = bidfactory.createBid(2, bidRequest);
      nobid.bidderCode = bidRequest.bidder;
      _addBidResponse(bidRequest.adUnitCode, nobid);
    }
    responsesProcessed[bidRequest.auctionId]++;
    if (responsesProcessed[bidRequest.auctionId] >= bids) {
      delete responsesProcessed[bidRequest.auctionId];
      _done();
    }
  }

  function getSpec() {
    return {
      onBidWon: (bid) => {
        utils.logMessage('Underdog Media onBidWon Event', bid);
      },
      onSetTargeting: (bid) => {
        utils.logMessage('Underdog Media onSetTargeting Event', bid);
      }
    }
  }

  return {
    callBids: _callBids,
    getSpec: getSpec
  };
};
var registerBidAdapter = adapterManager.registerBidAdapter;
registerBidAdapter(new UnderdogMediaAdapter(), 'underdogmedia');
module.exports = UnderdogMediaAdapter;
