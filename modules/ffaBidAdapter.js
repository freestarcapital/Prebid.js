import * as utils from 'src/utils';
import {config} from 'src/config';
import {registerBidder} from 'src/adapters/bidderFactory';
const BIDDER_CODE = 'example';
const deviceType = !freestar.deviceInfo.device.type ? "desktop" : freestar.deviceInfo.device.type;
const ENDPOINT_URL = `${freestar.msg.dispensaryURL}/floors/v2`

export const spec = {
  code: BIDDER_CODE,
  aliases: ['ffa'], // short code
  /**
   * Determines whether or not the given bid request is valid.
   *
   * @param {BidRequest} bid The bid params to validate.
   * @return boolean True if this is a valid bid, and false otherwise.
   */
  isBidRequestValid: function(bid) {
    // every bid is valid to us
    return true;
  },
  /**
   * Make a server request from the list of BidRequests.
   *
   * @param {validBidRequests[]} - an array of bids
   * @return ServerRequest Info describing the request to the server.
   */
  buildRequests: function(validBidRequests) {
    // instead of requesting a bid based on the adUnit
    // call data dispensary for the networkFloorMap
    return {
      method: 'GET',
      url: ENDPOINT_URL,
      data: {
        key: `${freestar.fsdata.siteId}${deviceType}`, // pass siteId + deviceType
        validBidRequests // adUnits will be used in interpretResponse
      },
    };
  },
  /**
   * Unpack the response from the server into a list of bids.
   *
   * @param {ServerResponse} serverResponse A successful response from the server.
   * @return {Bid[]} An array of bids which were nested inside the server.
   */
  interpretResponse: function(serverResponse, bidRequest) {
    // grab some vars
    const bidResponses = [], floors = serverResponse.body.networkFloorMap, bids = bidRequest.data.validBidRequests;
    // loop through the bids
    bids.forEach((bid) => {
      // set some vars
      let cpm = 0;
      // if there is a value for  0 (`ffa`) use that
      if(typeof floors[0] != 'undefined') {
        cpm = floors[0] / 1e6;
      } else {
        // if not...
        freestar.log({title:'FFA:', styles:'background: red; color: #fff; border-radius: 3px; padding: 3px'}, 'FLOOR VALUE NOT FOUND, PRODUCING AVERAGE');
        // recast cpm to an array
        cpm = [];
        // loop through the networkFloor keys
        Object.keys(floors).forEach((bidder) => {
          freestar.log({title:'FFA:', styles:'background: black; color: #fff; border-radius: 3px; padding: 3px'}, bidder, floors[bidder] / 1e6);
          // push each value to the cpm array
          cpm.push(floors[bidder] / 1e6)
        })
        // then, reduce the array and get the avg
        cpm = (cpm.reduce((a, b) => a + b, 0) / cpm.length);
      }
      freestar.log({title:'FFA:', styles:'background: black; color: #fff; border-radius: 3px; padding: 3px'}, 'Avg CPM is', cpm);
      // build the bid response, using whatever cpm was derived above
      // pass a custom ad creative to be rendered on the page, in which the magic happens
      bidResponses.push({
          requestId: bid.bidId,
          cpm: cpm,
          width: bid.sizes[0][0],
          height: bid.sizes[0][1],
          creativeId: bid.auctionId,
          currency: 'USD',
          netRevenue: true,
          ttl: 60,
          ad: `
            <script type="text/javascript">
                // get some vars
                // filter bids to make sure it hasn't been rendered yet
                // then sort the array by cpm
                if(typeof winner == 'undefined') {
                    let winner;
                }
                winner = ${JSON.stringify(bid)}, bids = parent.pbjs.getBidResponsesForAdUnitCode(winner.adUnitCode).bids.filter((bid) => {
                    if(bid.status != 'rendered') {
                        return bid;
                    }
                }).sort((a,b) => {
                    return (a.cpm < b.cpm) ? 1 : ((b.cpm < a.cpm) ? -1 : 0);
                });
                // if there are bids...
                if(bids.length > 1) {
                    // pass the highest bid to pbjs.renderAd
                    // and mark it as a winning bid
                    parent.freestar.log({title:'FFA:', styles:'background: black; color: gold; border-radius: 3px; padding: 3px'}, 'Floor was the winning bid...');
                    parent.freestar.log({title:'FFA:', styles:'background: black; color: gold; border-radius: 3px; padding: 3px'}, 'Rendering Next Ad...', bids[0].bidderCode, '$' + bids[0].cpm, bids[0].adId);
                    parent.pbjs.renderAd(parent.document.getElementById(winner.adUnitCode).querySelector('iframe').contentWindow.document, bids[0].adId);
                    parent.pbjs.markWinningBidAsUsed({
                        adUnitCode: bids[0].adUnitCode,
                        adId: bids[0].adId
                    });
                    parent.freestar.msg.que.push({
                        eventType: 'ffaBidWon',
                        args: {
                            winningCPM: ${cpm},
                            nextHighestBidCPM: bids[0].cpm,
                            nextHighestBidBidderCode: bids[0].bidderCode,
                            nextHighestBidMediaType: bids[0].mediaType,
                            lowestHighestBidCPM: bids[bids.length - 1].cpm,
                            lowestHighestBidBidderCode: bids[bids.length - 1].bidderCode,
                            lowestHighestBidMediaType: bids[bids.length - 1].mediaType,
                        }
                    });
                } else {
                    // if not...
                    // rebid on the slot
                    parent.freestar.log({title:'FFA:', styles:'background: red; color: #fff; border-radius: 3px; padding: 3px'}, 'NO OTHER BIDS FOUND');
                    parent.freestar.fsRequestBids([winner.adUnitCode], [parent.freestar.dfpSlotInfo[winner.adUnitCode].slot]);
                }
            </script>
          `
        });
    })
    // return the bid response
    return bidResponses;
  },

    /**
   * Register the user sync pixels which should be dropped after the auction.
   *
   * @param {SyncOptions} syncOptions Which user syncs are allowed?
   * @param {ServerResponse[]} serverResponses List of server's responses.
   * @return {UserSync[]} The user syncs which should be dropped.
   */
  getUserSyncs: function(syncOptions, serverResponses) {
    // no syncs
    return;
  },

  /**
   * Register bidder specific code, which will execute if bidder timed out after an auction
   * @param {data} Containing timeout specific data
   */
  onTimeout: function(data) {
    // Bidder specifc code
  },

  /**
   * Register bidder specific code, which will execute if a bid from this bidder won the auction
   * @param {Bid} The bid that won the auction
    */
    onBidWon: function(bid) {
      // Bidder specific code
    }
}
registerBidder(spec);
