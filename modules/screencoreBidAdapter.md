# Overview

<<<<<<<< HEAD:modules/programmaticXBidAdapter.md
**Module Name:** ProgrammaticX Bidder Adapter

**Module Type:** Bidder Adapter

**Maintainer:** pxteam@programmaticx.ai

# Description

Module that connects to ProgrammaticX's Open RTB demand sources.
========
**Module Name:** Screencore Bidder Adapter

**Module Type:** Bidder Adapter

**Maintainer:** connect@screencore.io

# Description

Module that connects to Screencore's Open RTB demand sources.
>>>>>>>> 10.12.0:modules/screencoreBidAdapter.md

# Test Parameters
```js
var adUnits = [
  {
    code: 'test-ad',
    sizes: [[300, 250]],
    bids: [
      {
<<<<<<<< HEAD:modules/programmaticXBidAdapter.md
        bidder: 'programmaticX',
========
        bidder: 'Screencore',
>>>>>>>> 10.12.0:modules/screencoreBidAdapter.md
        params: {
          cId: '562524b21b1c1f08117fc7f9',
          pId: '59ac17c192832d0011283fe3',
          bidFloor: 0.0001,
          ext: {
            param1: 'loremipsum',
            param2: 'dolorsitamet'
          },
          placementId: 'testBanner',
          endpointId: 'testEndpoint'
        }
      }
    ]
  }
];
```
