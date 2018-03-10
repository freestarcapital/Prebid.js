import {config} from 'src/config';
import {registerBidder} from 'src/adapters/bidderFactory';
import {BANNER, NATIVE, VIDEO} from "../src/mediaTypes";
const BIDDER_CODE = 'freestar';
const ENDPOINT_URL = 'http://35.226.213.130:8080/open-ssp/HeaderBiddingService';
export const spec = {
  code: BIDDER_CODE,

  /**
   * Determines whether or not the given bid request is valid.
   *
   * @param {object} bid The bid to validate.
   * @return boolean True if this is a valid bid, and false otherwise.
   */
  isBidRequestValid: function(bid) {
    return true;
    // return !!(bid.params.placementId || (bid.params.member && bid.params.invCode));
  },


  /**
   * Make a server request from the list of BidRequests.
   *
   * @param {BidRequest[]} bidRequests A non-empty list of bid requests which should be sent to the Server.
   * @return ServerRequest Info describing the request to the server.
   */
  buildRequests: function(validBidRequests) {
    const adUnitsToBidUpon = validBidRequests.map(formatBid),
      payload = {},
      cookie = window.document.cookie.split(';'),
      cookieObj = {};
    for (var i = 0; i < cookie.length; i++) {
      var tmp;
      // see if _fs* is within the string
      if (cookie[i].indexOf('_fs') != -1) {
        // if so, split it
        tmp = cookie[i].split('=');
        // check if _fsloc, whose values has = within it
        if(tmp[0].trim() == '_fsloc') {
          // and if so, manipulate differently
          tmp.shift();
          cookieObj['_fsloc'] = tmp.join('=');
        } else {
          // if not, add to obj
          cookieObj[tmp[0].trim()] = tmp[1].trim();
        }
      }
    }
    // throw it all into an object and pass it along
    payload['id'] = uid();
    payload['adUnitsToBidUpon'] = adUnitsToBidUpon;
    payload['site'] = location.hostname;
    payload['page'] = location.pathname;
    for (var key in cookieObj) {
      payload[key] = cookieObj[key];
    }
    return {
      method: 'POST',
      url: ENDPOINT_URL,
      data: JSON.stringify(payload),
    };
  },

  /**
   * Unpack the response from the server into a list of bids.
   *
   * @param {*} serverResponse A successful response from the server.
   * @return {Bid[]} An array of bids which were nested inside the server.
   */
  interpretResponse: function(serverResponse) {
    serverResponse = serverResponse.body;
    const bids = [];
    // @TODO: add error handling
    if(serverResponse.winningProvider) {
      bids.push(parseBid(Object.assign(
        {},
        {
          requestId:serverResponse.bidRequest.imp[0].id,
          currency: serverResponse.winningProvider.currency
        },
        serverResponse.winningProvider.winningSeat.bid[0],
      )));
    }
    return bids;
  },
  // @TODO: How are we doing user sync?
  getUserSyncs: function(syncOptions) {
    // if (syncOptions.iframeEnabled) {
    //   return [{
    //     type: 'iframe',
    //     url: '//acdn.adnxs.com/ib/static/usersync/v3/async_usersync.html'
    //   }];
    // }
  }
}

function parseBid(bid) {
  const bidResponse = {
    requestId: bid.requestId,
    cpm: bid.price,
    width: bid.w,
    height: bid.h,
    creativeId: bid.cid, //@TODO: verify
    // // dealId: DEAL_ID,
    currency: bid.currency,
    netRevenue: true,
    ttl: 60,
    ad: bid.adm
  };
  return bidResponse;
}

function formatBid(bid) {
  var str = {}, res = [];
  str.id = bid.bidId; //@TODO: This id needs to be reflected in the response
  str.adUnitCode = bid.adUnitCode;
  str.size = bid.sizes[0].join('x');
  str.promo_sizes = bid.sizes.slice(1).map(function(size) {
    return size.join('x');
  });
  str.promo_sizes = str.promo_sizes.join(',');
  if(typeof bid.params != 'undefined') {
    for(var key in bid.params) {
      str[key] = bid.params[key];
    }
  }
  return str;
}

function uid() {
  const src = '1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var uid = '';
  for(var i = 0; i < 16; i++) {
    uid += src.substr((Math.floor(Math.random() * src.length) + 1 ),1)
  }
  return uid;
}

registerBidder(spec);
