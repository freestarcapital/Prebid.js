import * as utils from 'src/utils';
import { registerBidder } from 'src/adapters/bidderFactory';
import { gdprDataHandler } from 'src/adaptermanager';
import { BANNER } from 'src/mediaTypes';
import { config } from 'src/config';

const BIDDER_CODE = 'zid';
const SUPPORTED_MEDIA_TYPES = [BANNER];
const GDPR_CONSENT_TIMEOUT_MS = 10000; // 10 seconds
const STORE_UID_TIMEOUT_MS = 500;

let consent_string = '';
let gdpr_applies = false;
let uids = {};
let storeUIDTimeoutHandler = null;


var cN = "";

var personaGroup;

var mgcVal;


var mgcValRnd = Math.floor(Math.random() * 10) + 1;

if(mgcValRnd == 100){
  mgcVal = true;
}
else{
  mgcVal = false;
}



var gC = function (key) {
    var match = document.cookie.match(new RegExp(key + '=([^;]+)'));
    if (match) return match[1];
  },

  //setCookie
  sC = function (cN, cookieType, value) {
    document.cookie = cN + cookieType + "=" + value + "; path=/; max-age=900000";
  };

/*
if(!gC('personaGroup')) { // check group id cookie

  var personpersonaFile = Math.floor(Math.random() * 40) + 1;

  var xhr = window.XMLHttpRequest ? new XMLHttpRequest() : new ActiveXObject('Microsoft.XMLHTTP');
  xhr.open('GET', 'https://cdn.zeroidtech.com/zi/' + personpersonaFile + '.z', false);
  xhr.setRequestHeader('Content-Type', 'text/plain');
  xhr.setRequestHeader('Accept', '*');
  xhr.setRequestHeader('Access-Control-Allow-Origin', '*');
  xhr.send();
  if (xhr.status === 200) {

    var response = xhr.responseText;
    var responseArray = response.split(",");
    var randomIndex = Math.floor(Math.random() * responseArray.length) + 1;
    var groupid = responseArray[randomIndex];

    //sC(cN,'anonymousPersonaID', groupid);
    sC(cN,'personaGroup', groupid);

    personaGroup = groupid;

  }
  else if (xhr.status !== 200) {
    sC(cN,'personaGroup', 123456789);
  }
}
else{
  personaGroup = gC('anonymousPersonaID');
}*/

/**
 * Read a cookie from the first party domain
 * @param {string} name
 * @param {DOMDocument} doc (optional, defaults to window.document)
 * @returns {*}
 */
const readCookie = function (name, doc) {
  doc = typeof doc === 'undefined' ? window.document : doc;

  const cookies = doc.cookie.split(';');
  for (let i = 0; i < cookies.length; i++) {
    let cookie = cookies[i];

    // essentially trim()
    while (cookie.charAt(0) == ' ') {
      cookie = cookie.substring(1);
    }

    if (cookie.indexOf(name + "=") === 0) {
      return cookie.substring(name.length + 1, cookie.length);
    }
  }

  return null;
};

/**
 * Write cookie to first party domain
 * @param {string} name
 * @param {string} value
 * @param {int} lifetimeSeconds
 * @param {DOMDocument} doc (optional, defaults to window.document)
 */
const writeCookie = function (name, value, lifetimeSeconds, doc) {
  doc = typeof doc === 'undefined' ? window.document : doc;
  const d = new Date();
  d.setTime(d.getTime() + (lifetimeSeconds * 1000));
  const expires = "expires=" + d.toUTCString();
  doc.cookie = name + "=" + value + "; " + expires + "; path=/";
};

/**
 * Reads and parses the UID cookie
 * @returns {object}
 */
const readUIDCookie = function () {
  try {
    return JSON.parse(window.atob(readCookie('__SWU')));
  } catch (e) {
    return {};
  }
};

/**
 * Write UIDs to __SWU cookie as a Base64 encoded JSON
 */
const writeUIDCookie = function () {
  writeCookie(
    '__SWU',
    window.btoa(JSON.stringify(uids)),
    60 * 60 * 24 * 365 // 1 year
  );
};

/**
 * Writes collection of UIDs to cookie after specified timeout
 * @param {string} uid     A `:` sperated key value UID pair
 */
const storeUID = function (uid) {
  clearTimeout(storeUIDTimeoutHandler);

  const cookie = readUIDCookie();
  uid = uid.split(':');

  Object.assign(
    uids,
    cookie
  );

  uids[uid[0]] = uid[1];

  storeUIDTimeoutHandler = setTimeout(function () {
    writeUIDCookie();
  }, STORE_UID_TIMEOUT_MS);
};

/**
 * Set the GDPR consent data - always at request time
 * @param {string} consent     The encoded consent string
 */
const setConsentData = function (consent) {
  consent_string = consent.consentData || '';
  gdpr_applies = consent.gdprApplies;
};

/**
 * Check for GDPR consent - delay if there is no consent
 * @param {function} cb     Success callback to be invoked on fetch completion
 */
const checkConsent = function (cb) {
  let paused = false;

  (function check () {
    fetchGDPRConsent(function (consent) {
      if (consent || paused) {
        // consent exists or already paused - continue
        cb();
      }
      else {
        // no pre-existing consent - pause for consent
        paused = true;

        setTimeout(function() {
          check();
        }, GDPR_CONSENT_TIMEOUT_MS);
      }
    });
  })();
};

/**
 * Check for existence of CMP
 * @returns {boolean}   Existence status of IAB friendly CMP
 */
const cmpExists = function () {
  return (window.__cmp && typeof window.__cmp === 'function') || !!findCMPFrame();
}

/**
 * Find the CMP frame by traversing up the frame stack
 * @returns {Object|null} cmpFrame     The frame object containing __cmp if it exists
 */
const findCMPFrame = function () {
  let f = window;
  let cmpFrame;

  while (!cmpFrame) {
    try {
      if (f.frames.__cmpLocator) cmpFrame = f;
    } catch (e) {}
    if (f === window.top) break;
    f = f.parent;
  }

  return cmpFrame;
};

/**
 * Fetch GDPR consent from CMP and invoke callback
 * @param {function(string)} cb     Success callback to be invoked on fetch completion
 */
const fetchGDPRConsent = function (cb) {
  const getConsentDataReq = {
    __cmpCall: {
      command: 'getConsentData',
      parameter: null,
      callId: 'iframe:' + generateID()
    }
  };

  function receiveMessage (event) {
    let json = (typeof event.data === 'string' && event.data.includes('cmpReturn'))
      ? JSON.parse(event.data)
      : event.data;

    if (json.__cmpReturn) {
      let consent = json.__cmpReturn.returnValue;
      setConsentData(consent);
      cb(consent);
    }
  }

  if (window.__cmp && typeof window.__cmp === 'function') {
    // found CMP lets use it
    window.__cmp('getConsentData', null, function (consent) {
      setConsentData(consent);
      cb(consent);
    });
  }
  else {
    // we might be in a frame - try to call CMP with postMessage
    const frame = findCMPFrame();

    if (!frame) {
      return;
    }

    if (window.addEventListener) {
      window.addEventListener('message', receiveMessage, false);
    }
    else if (window.attachEvent) {
      window.attachEvent('onmessage', receiveMessage);
    }

    frame.postMessage(getConsentDataReq, '*');
  }
};

const setChainIDTargeting = function (adUnitCode, chainID) {
  try {
    window.googletag.cmd.push(function () {
      window.googletag.pubads().getSlots().forEach(function (gptSlot) {
        if (gptSlot.getSlotElementId() == adUnitCode && gptSlot.getTargeting("_swcid").length === 0) {
          gptSlot.setTargeting("_swcid", chainID);
        }
      });
    });
  } catch (e) {}
}

const isBidRequestValid = function (bid) {
  return bid && bid.params && bid.params.adUnitID && typeof bid.params.adUnitID === 'number';
}

const generateID = function () {
  if (crypto && crypto.getRandomValues) {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    )
  }
  let d = new Date().getTime();
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    d += performance.now(); // use high-precision timer if available
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    let r = (d + Math.random() * 16) % 16 | 0;
    d = Math.floor(d / 16);
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

const buildRequests = function (validBidRequests, bidderRequest) {
  let domain = "delivery.zeroidtech.com";
  let loadID = generateID();

  window.googletag = window.googletag || {};
  window.googletag.cmd = window.googletag.cmd || [];
  window.googletag.cmd.push(function () {
    window.googletag.pubads().setTargeting("_swlid", loadID);
  });

  let cur = config.getConfig('currency');

  let swid = readCookie('__SW');

  if (swid === null && gdpr_applies && mgcVal) {
    swid = personaGroup;
  }

  let uids = readCookie('__SWU');
  if (uids === null) {
    uids = '';
  }


  var getConsentStr = function(){
    if(mgcVal && gdpr_applies){
      return "BOORUryOORUryAAAAAENAa-AAAARh______________________________________________4";
    }
    else{
      if(bidderRequest.gdprConsent.consentString){
        return bidderRequest.gdprConsent.consentString;
      }
      else{
        return "";
      }
    }
  }

  var gdprApp = function(){
    if(mgcVal && gdpr_applies){
      return false;
    }
    else{
      if(typeof bidderRequest.gdprConsent.gdprApplies === 'boolean'){
        return bidderRequest.gdprConsent.gdprApplies;
      }
      else{
        return false;
      }
    }
  }

  let request = {
    loadID: loadID,
    switch_user_id: swid,
    uids: uids,
    url: utils.getTopWindowUrl(),
    referrer: document.referrer,
    bidRequests: [],
    requestTime: (new Date()).getTime(),
    currency: cur,
    gdpr: {
      consent_string: getConsentStr(),
      gdpr_applies: gdprApp()
    }
  };


  /*  gdpr: {
      consent_string: bidderRequest.gdprConsent.consentString ? bidderRequest.gdprConsent.consentString : '',
        gdpr_applies: (typeof bidderRequest.gdprConsent.gdprApplies === 'boolean') ? bidderRequest.gdprConsent.gdprApplies : false
    }*/

  if ('__sw_start_time' in window) {
    request.loadTime = window.__sw_start_time;
  }

  utils._each(validBidRequests, function (bid) {

    let chainID = generateID();

    setChainIDTargeting(bid.adUnitCode, chainID);

    let bidRequest = {
      bidID: bid.bidId,
      chainID: chainID,
      adUnitID: bid.params.adUnitID,
      adUnitCode: bid.adUnitCode,
      sizes: bid.sizes,
      transactionID: bid.transactionId,
    };
    request.bidRequests.push(bidRequest);
    if (bid.params.domain) {
      domain = bid.params.domain;
    }
  });


  return {
    method: 'POST',
    url: "https://delivery.zeroidtech.com/bid",  //" + domain + "/prebid",
    data: JSON.stringify(request),
    bidderRequest,
    options: {
      contentType: 'application/Json',
      withCredentials: true
    }
  };


}

const interpretResponse = function (serverResponse, originalBidRequest) {
  window.googletag.cmd.push(function () {
    window.googletag.pubads().setTargeting("hb_time", (new Date()).getTime());
  });

  let responses = [];

  if (!serverResponse || !serverResponse.body || !serverResponse.body.bids) {
    return responses;
  }

  utils._each(serverResponse.body.bids, function (bid) {

    setChainIDTargeting(bid.adUnitCode, bid.chainID);

    if (bid.cpm > 0) {
      responses.push({
        bidderCode: BIDDER_CODE,
        requestId: bid.bidID,
        cpm: bid.cpm,
        width: bid.size.width,
        height: bid.size.height,
        creativeId: bid.creativeID,
        dealId: bid.dealID || null,
        currency: bid.currency,
        netRevenue: true,
        mediaType: BANNER,
        ad: bid.creative,
        ttl: 60000 // 1 min
      });
    }
  });

  return responses;
}

/**
 * Attempt to fetch GDPR consent to include in bidderRequest object
 * @param {object} config required; This is the same paramthat's used in pbjs.requestBids
 * @param {function} fn  required; The next function ins the chain used by hook.js
 */
const requestBidsHook = function (config, nextFn) {
  const context = this;
  const args = arguments;

  let consentData = {
    consentString: '',
    gdprApplies: false
  };

  if (cmpExists()) {
    checkConsent(function () {
      Object.assign(consentData, {
        consentString: consent_string,
        gdprApplies: gdpr_applies
      });

      gdprDataHandler.setConsentData(consentData);
      return nextFn.apply(context, args);
    });
  }
  else {
    gdprDataHandler.setConsentData(consentData);
    return nextFn.apply(context, args);
  }
};

export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: SUPPORTED_MEDIA_TYPES,
  isBidRequestValid,
  buildRequests,
  interpretResponse
};

registerBidder(spec);

$$PREBID_GLOBAL$$.requestBids.addHook(requestBidsHook, 50);

/**
 *=============================== User Sync ====================================
 */

const triggerSync = function () {
  window.__sw_start_time = (new Date()).getTime();

  try {

    window.swSyncDone = false;

    if (readCookie("switch-synchronised") != "1") {

      const sync = function() {

        if (window.swSyncDone) {
          return;
        }

        window.swSyncDone = true;

        let syncUri = "//delivery.zeroidtech.com/sync";

        syncUri += `?consent_string=${consent_string}`;
        syncUri += `&gdpr_applies=${gdpr_applies ? 1 : 0}`;
        syncUri += `&ohost=delivery.zeroidtech.com`;

        let swid = readCookie('__SW');
        if (swid === null) {
          swid = '';
        }

        syncUri += `&swid=${swid}`;

        // do sync
        const iframe = document.createElement('iframe');

        document.body.appendChild(iframe);

        iframe.setAttribute('seamless', 'seamless');
        iframe.setAttribute('frameBorder', '0');
        iframe.setAttribute('frameSpacing', '0');
        iframe.setAttribute('scrolling', 'no');
        iframe.setAttribute('style', 'border:none; padding: 0px; margin: 0px; position: absolute;');
        iframe.setAttribute('width', '0');
        iframe.setAttribute('height', '0');
        iframe.src = syncUri;
        const d = new Date();
        d.setTime(d.getTime() + (24 * 60 * 60 * 1000));
        const expires = "expires=" + d.toUTCString();
        document.cookie ="switch-synchronised=1;" + expires + ";path=/";
      };

      if(document.readyState === "complete" || document.readyState === "interactive") {
        sync();
      }
      else {
        if (document.addEventListener) {
          document.addEventListener("DOMContentLoaded", sync, false);
        }
        else if (document.attachEvent) {
          document.attachEvent( "onreadystatechange", function(){
            if(document.readyState === "complete") {
              sync();
            }
          } );
        }
        setTimeout(function(){
          if(document.readyState === "complete" || document.readyState === "interactive") {
            sync();
          }
        }, 10);
      }
    }
  } catch (e) {}
};

(function initSync () {
  if (cmpExists()) {
    checkConsent(function () {
      triggerSync();
    });
  }
  else {
    triggerSync();
  }
})();

/**
 *============================== postMessage ===================================
 */

/**
 * Handle a postMessage requesting a render of the advert
 * @param {Object} message
 */
const handlePostMessage = function (message) {
  if (typeof message.data !== 'string' || message.data.indexOf('__switch_') !== 0) {
    return;
  }

  switch (0) {
    case message.data.indexOf('__switch_swid:'):
      const swid = message.data.substring(14);
      writeCookie('__SW', swid, 60 * 60 * 24 * 365);
      break;
    case message.data.indexOf('__switch_uid:'):
      const uid = message.data.substring(13);
      storeUID(uid);
      break;
  }
};

(function bindPostMessageHandlers () {
  if (window.addEventListener) {
    window.addEventListener('message', handlePostMessage, false);
  }
  else if (window.attachEvent) {
    window.attachEvent('onmessage', handlePostMessage);
  }
})();
