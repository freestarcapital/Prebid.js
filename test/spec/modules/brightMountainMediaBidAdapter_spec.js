import { expect } from 'chai';
import { spec } from '../../../modules/brightMountainMediaBidAdapter.js';

const BIDDER_CODE = 'bmtm';
<<<<<<< HEAD
=======
const ENDPOINT_URL = 'https://one.elitebidder.com/api/hb';
const ENDPOINT_URL_SYNC = 'https://console.brightmountainmedia.com:8443/cookieSync';
>>>>>>> main
const PLACEMENT_ID = 329;

describe('brightMountainMediaBidAdapter_spec', function () {
  let bidBanner = {
    bidId: '2dd581a2b6281d',
    bidder: BIDDER_CODE,
    bidderRequestId: '145e1d6a7837c9',
    params: {
      placement_id: PLACEMENT_ID
    },
    placementCode: 'placementid_0',
    auctionId: '74f78609-a92d-4cf1-869f-1b244bbfb5d2',
    mediaTypes: {
      banner: {
        sizes: [[300, 250]]
      }
    },
    transactionId: '3bb2f6da-87a6-4029-aeb0-bfe951372e62',
    getFloor: function () {
      return {
        currency: 'USD',
        floor: 0.5,
      }
    },
    schain: {
      ver: '1.0',
      complete: 1,
      nodes: [
        {
          asi: 'directseller.com',
          sid: '00001',
          rid: 'BidRequest1',
          hp: 1
        }
      ]
    },
    userIdAsEids: [
      {
        'source': 'id5-sync.com',
        'uids': [
          {
            'id': 'ID5-ZHMOaW5vh_TJhKVSaTWmuoTpwqjGGwx5v0WbaSV8yw',
            'atype': 1,
            'ext': {
              'linkType': 2
            }
          }
        ]
      },
      {
        'source': 'pubcid.org',
        'uids': [
          {
            'id': '00000000000000000000000000',
            'atype': 1
          }
        ]
      }
    ]
  };

  let bidVideo = {
    bidId: '2dd581a2b6281d',
    bidder: BIDDER_CODE,
    bidderRequestId: '145e1d6a7837c9',
    params: {
      placement_id: PLACEMENT_ID
    },
    placementCode: 'placementid_0',
    auctionId: '74f78609-a92d-4cf1-869f-1b244bbfb5d2',
    mediaTypes: {
      video: {
        playerSizes: [[300, 250]],
        context: 'outstream',
        skip: 0,
        playbackmethod: [1, 2],
        mimes: ['video/mp4']
      }
    },
    transactionId: '3bb2f6da-87a6-4029-aeb0-bfe951372e62',
  };

<<<<<<< HEAD
=======
  let bidVideo = {
    bidId: '2dd581a2b6281d',
    bidder: BIDDER_CODE,
    bidderRequestId: '145e1d6a7837c9',
    params: {
      placement_id: PLACEMENT_ID
    },
    placementCode: 'placementid_0',
    auctionId: '74f78609-a92d-4cf1-869f-1b244bbfb5d2',
    mediaTypes: {
      video: {
        playerSizes: [[300, 250]],
        context: 'outstream',
        skip: 0,
        playbackmethod: [1, 2],
        mimes: ['video/mp4']
      }
    },
    transactionId: '3bb2f6da-87a6-4029-aeb0-bfe951372e62',
  };

>>>>>>> main
  let bidderRequest = {
    bidderCode: BIDDER_CODE,
    auctionId: 'fffffff-ffff-ffff-ffff-ffffffffffff',
    bidderRequestId: 'ffffffffffffff',
    start: 1472239426002,
    auctionStart: 1472239426000,
    timeout: 5000,
    uspConsent: '1YN-',
    refererInfo: {
      referer: 'http://www.example.com',
      reachedTop: true,
<<<<<<< HEAD
    },
    gdprConsent: {
      consentString: 'BOJ8RZsOJ8RZsABAB8AAAAAZ+A==',
      gdprApplies: true
    },
    bids: [bidBanner],
=======
    }
>>>>>>> main
  };

  describe('isBidRequestValid', function () {
    it('Should return true when  when required params found', function () {
      expect(spec.isBidRequestValid(bidBanner)).to.be.true;
    });
    it('Should return false when required params are not passed', function () {
<<<<<<< HEAD
      bidBanner.params = {};
=======
      bidBanner.params = {}
>>>>>>> main
      expect(spec.isBidRequestValid(bidBanner)).to.be.false;
    });
  });

<<<<<<< HEAD
  describe('buildRequests', function () {
    let request = spec.buildRequests([bidBanner], bidderRequest)[0];
    let data = JSON.parse(request.data);

    it('Creates a ServerRequest object with method, URL and data', function () {
      expect(request).to.exist;
      expect(request.method).to.exist;
      expect(request.url).to.exist;
      expect(request.data).to.exist;
      expect(request.method).to.be.a('string');
      expect(request.url).to.be.a('string');
      expect(request.data).to.be.an('string');
=======
  function testServerRequestBody(serverRequest) {
    it('Creates a ServerRequest object with method, URL and data', function () {
      expect(serverRequest).to.exist;
      expect(serverRequest.method).to.exist;
      expect(serverRequest.url).to.exist;
      expect(serverRequest.data).to.exist;
    });
    it('Returns POST method', function () {
      expect(serverRequest.method).to.equal('POST');
    });
    it('Returns valid URL', function () {
      expect(serverRequest.url).to.equal(ENDPOINT_URL);
>>>>>>> main
    });

    it('Returns valid data if array of bids is valid', function () {
      expect(data).to.be.an('object');
<<<<<<< HEAD
      expect(data).to.have.all.keys('at', 'site', 'device', 'cur', 'tmax', 'regs', 'user', 'source', 'imp', 'id');
      expect(data.at).to.be.a('number');
      expect(data.site).to.be.an('object');
      expect(data.device).to.be.an('object');
      expect(data.cur).to.be.an('array');
      expect(data.tmax).to.be.a('number');
      expect(data.regs).to.be.an('object');
      expect(data.user).to.be.an('object');
      expect(data.source).to.be.an('object');
      expect(data.imp).to.be.an('array');
      expect(data.id).to.be.a('string');
    });

    it('Sends bidfloor param if present', function () {
      expect(data.imp[0].bidfloor).to.equal(0.5);
    });

    it('Sends regs info if exists', function () {
      expect(data.regs.ext.gdpr).to.exist.and.to.be.a('number');
      expect(data.regs.ext.gdprConsentString).to.exist.and.to.be.a('string');
      expect(data.regs.ext.us_privacy).to.exist.and.to.be.a('string');
    });

    it('Sends schain info if exists', function () {
      expect(data.source.ext).to.be.an('object');
    });

    it('sends userId info if exists', function () {
      expect(data.user.ext).to.have.property('eids');
      expect(data.user.ext.eids).to.not.equal(null).and.to.not.be.undefined;
      expect(data.user.ext.eids.length).to.greaterThan(0);
      for (let index in data.user.ext.eids) {
        let eid = data.user.ext.eids[index];
        expect(eid.source).to.not.equal(null).and.to.not.be.undefined;
        expect(eid.uids).to.not.equal(null).and.to.not.be.undefined;
        for (let uidsIndex in eid.uids) {
          let uid = eid.uids[uidsIndex];
          expect(uid.id).to.not.equal(null).and.to.not.be.undefined;
        }
      }
    });

    it('Returns valid data if array of bids is valid for banner', function () {
      expect(data).to.be.an('object');
      expect(data).to.have.property('imp');
      expect(data.imp.length).to.greaterThan(0);
      expect(data.imp[0]).to.have.property('banner');
      expect(data.imp[0].banner).to.be.an('object');
      expect(data.imp[0].banner.h).to.exist.and.to.be.a('number');
      expect(data.imp[0].banner.w).to.exist.and.to.be.a('number');
    });

    it('Returns valid data if array of bids is valid for video', function () {
      bidderRequest.bids = [bidVideo];
      let serverRequest = spec.buildRequests([bidVideo], bidderRequest)[0];
      let data = JSON.parse(serverRequest.data);
      expect(data).to.be.an('object');
      expect(data).to.have.property('imp');
      expect(data.imp.length).to.greaterThan(0);
      expect(data.imp[0]).to.have.property('video');
      expect(data.imp[0].video).to.be.an('object');
      expect(data.imp[0].video.h).to.exist.and.to.be.a('number');
      expect(data.imp[0].video.w).to.exist.and.to.be.a('number');
    });
  });

  describe('interpretResponse', function () {
    let resObjectBanner = {
      'id': '2763-05f22da29b3ffb6-6959',
      'bidid': 'e5b41111bec9e4a4e94b85d082f8fb08',
      'seatbid': [
        {
          'bid': [
            {
              'id': '9550c3e641761cfbf2a4dd672b50ddb9',
              'impid': '968',
              'price': 0.3,
              'w': 300,
              'h': 250,
              'nurl': 'https://example.com/?w=nr&pf=${AUCTION_PRICE}&type=b&uq=483531c101942cbb270cd088b2eec43f',
              'adomain': [
                'example.com'
              ],
              'cid': '3845_105654',
              'crid': '3845_305654',
              'adm': '<h1>Test Ad</h1>',
              'adid': '17794c46ca26',
              'iurl': 'https://example.com/?t=preview2&k=17794c46ca26'
            }
          ],
          'seat': '3845'
        }
      ],
      'cur': 'USD'
    };

    let resObjectVideo = {
      'id': '2763-05f22da29b3ffb6-6959',
      'bidid': 'e5b41111bec9e4a4e94b85d082f8fb08',
      'seatbid': [
        {
          'bid': [
            {
              'id': '9550c3e641761cfbf2a4dd672b50ddb9',
              'impid': '968',
              'price': 0.3,
              'w': 300,
              'h': 250,
              'nurl': 'https://example.com/?w=nr&pf=${AUCTION_PRICE}&type=b&uq=483531c101942cbb270cd088b2eec43f',
              'adomain': [
                'example.com'
              ],
              'cid': '3845_105654',
              'crid': '3845_305654',
              'adm': '<VAST></VAST>',
              'adid': '17794c46ca26',
              'iurl': 'https://example.com/?t=preview2&k=17794c46ca26'
            }
          ],
          'seat': '3845'
        }
      ],
      'cur': 'USD'
    };

    it('Returns an array of valid response if response object is valid for banner', function () {
      const bidResponse = spec.interpretResponse({
        body: resObjectBanner
      }, { bidRequest: bidBanner });

      expect(bidResponse).to.be.an('array').that.is.not.empty;
      for (let i = 0; i < bidResponse.length; i++) {
        let dataItem = bidResponse[i];
=======
      expect(data).to.have.all.keys('deviceWidth', 'deviceHeight', 'language', 'secure', 'host', 'page', 'placements');
      expect(data.deviceWidth).to.be.a('number');
      expect(data.deviceHeight).to.be.a('number');
      expect(data.language).to.be.a('string');
      expect(data.secure).to.be.within(0, 1);
      expect(data.host).to.be.a('string');
      expect(data.page).to.be.a('string');
      let placements = data['placements'];
      expect(placements).to.be.an('array');
    });
  }

  describe('buildRequests', function () {
    bidderRequest['bids'] = [bidBanner];
    let serverRequest = spec.buildRequests([bidBanner], bidderRequest);
    testServerRequestBody(serverRequest);

    it('sends bidfloor param if present', function () {
      bidBanner.getFloor = function () {
        return {
          currency: 'USD',
          floor: 0.5,
        }
      };
      const request = spec.buildRequests([bidBanner], bidderRequest);
      expect(request.data.placements[0].floor['300x250']).to.equal(0.5);
    });

    it('sends gdpr info if exists', function () {
      const gdprConsent = {
        consentString: 'BOJ8RZsOJ8RZsABAB8AAAAAZ+A==',
        gdprApplies: true
      };

      bidderRequest['gdprConsent'] = gdprConsent;
      const request = spec.buildRequests([bidBanner], bidderRequest);

      expect(request.data.gdpr_require).to.exist.and.to.be.a('number');
      expect(request.data.gdpr_consent).to.exist.and.to.be.a('string');
    });

    it('sends schain info if exists', function () {
      const schain = {
        ver: '1.0',
        complete: 1,
        nodes: [
          {
            asi: 'directseller.com',
            sid: '00001',
            rid: 'BidRequest1',
            hp: 1
          }
        ]
      };
      bidBanner.schain = schain;
      const request = spec.buildRequests([bidBanner], bidderRequest);
      expect(request.data.placements[0].schain).to.be.an('object');
    });

    bidderRequest['bids'] = [bidVideo];
    serverRequest = spec.buildRequests([bidVideo], bidderRequest);
    testServerRequestBody(serverRequest);

    it('Returns empty data if no valid requests are passed', function () {
      serverRequest = spec.buildRequests([]);
      let data = serverRequest.data;
      expect(data.placements).to.be.an('array').that.is.empty;
    });
  });

  function testServerResponse(serverResponses) {
    it('Returns an array of valid server responses if response object is valid', function () {
      expect(serverResponses).to.be.an('array').that.is.not.empty;
      for (let i = 0; i < serverResponses.length; i++) {
        let dataItem = serverResponses[i];
>>>>>>> main
        expect(dataItem.requestId).to.be.a('string');
        expect(dataItem.cpm).to.be.a('number');
        expect(dataItem.width).to.be.a('number');
        expect(dataItem.height).to.be.a('number');
        expect(dataItem.ad).to.be.a('string');
        expect(dataItem.ttl).to.be.a('number');
        expect(dataItem.creativeId).to.be.a('string');
        expect(dataItem.netRevenue).to.be.a('boolean');
        expect(dataItem.currency).to.be.a('string');
        expect(dataItem.mediaType).to.be.a('string');
        expect(dataItem.meta.advertiserDomains[0]).to.be.a('string');
<<<<<<< HEAD
      }
    });

    it('Returns an array of valid response if response object is valid for video', function () {
      const bidResponse = spec.interpretResponse({
        body: resObjectVideo
      }, { bidRequest: bidVideo });

      expect(bidResponse).to.be.an('array').that.is.not.empty;
      for (let i = 0; i < bidResponse.length; i++) {
        let dataItem = bidResponse[i];
        expect(dataItem.requestId).to.be.a('string');
        expect(dataItem.cpm).to.be.a('number');
        expect(dataItem.width).to.be.a('number');
        expect(dataItem.height).to.be.a('number');
        expect(dataItem.vastXml).to.be.a('string');
        expect(dataItem.ttl).to.be.a('number');
        expect(dataItem.creativeId).to.be.a('string');
        expect(dataItem.netRevenue).to.be.a('boolean');
        expect(dataItem.currency).to.be.a('string');
        expect(dataItem.mediaType).to.be.a('string');
        expect(dataItem.meta.advertiserDomains[0]).to.be.a('string');
      }
    });

    it('Returns an empty array if invalid response is passed', function () {
      const bidResponse = spec.interpretResponse({
        body: ''
      }, { bidRequest: bidBanner });
      expect(bidResponse).to.be.an('array').that.is.empty;
=======
      }
    });
  }

  describe('interpretResponse', function () {
    let resObjectBanner = {
      body: [{
        requestId: '123',
        mediaType: 'banner',
        cpm: 0.3,
        width: 320,
        height: 50,
        ad: '<h1>Hello ad</h1>',
        ttl: 1000,
        creativeId: '123asd',
        netRevenue: true,
        currency: 'USD',
        adomain: ['adomain.com'],
      }]
    };

    let resObjectVideo = {
      body: [{
        requestId: '123',
        mediaType: 'video',
        cpm: 1.5,
        width: 320,
        height: 50,
        ad: '<h1>Hello ad</h1>',
        ttl: 1000,
        creativeId: '123asd',
        netRevenue: true,
        currency: 'USD',
        adomain: ['adomain.com'],
      }]
    };
    let serverResponses = spec.interpretResponse(resObjectBanner);
    testServerResponse(serverResponses);

    serverResponses = spec.interpretResponse(resObjectVideo);
    testServerResponse(serverResponses);

    it('Returns an empty array if invalid response is passed', function () {
      serverResponses = spec.interpretResponse('invalid_response');
      expect(serverResponses).to.be.an('array').that.is.empty;
>>>>>>> main
    });
  });

  describe('getUserSyncs', function () {
    let syncoptionsIframe = {
      'iframeEnabled': 'true'
    }
    it('should return iframe sync option', function () {
      expect(spec.getUserSyncs(syncoptionsIframe)).to.be.an('array').with.lengthOf(1);
      expect(spec.getUserSyncs(syncoptionsIframe)[0].type).to.exist;
      expect(spec.getUserSyncs(syncoptionsIframe)[0].url).to.exist;
      expect(spec.getUserSyncs(syncoptionsIframe)[0].type).to.equal('iframe')
      expect(spec.getUserSyncs(syncoptionsIframe)[0].url).to.equal(ENDPOINT_URL_SYNC)
    });
  });
});
