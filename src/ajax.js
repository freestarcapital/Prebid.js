import { config } from './config.js';
import { logMessage, logError, parseUrl, buildUrl, _each } from './utils.js';

const XHR_DONE = 4;

const IS_WEBWORKER_AVAILABLE = (!!window.Worker);

if (IS_WEBWORKER_AVAILABLE) {
  $$PREBID_GLOBAL$$.worker = new Worker(URL.createObjectURL(new Blob([`
    function respond(id, response) {
      postMessage({
        action: 'RESPOND',
        params: {
          id,
          response
        }
      });
    }

    onmessage = async function(msg) {
      const { data } = msg;
      const { action, params } = data;
      switch (action) {
        case 'REQUEST':
          const { id, url, body, options } = params;
          options.method = options.method || (data) ? 'POST' : 'GET';
          options.body = body;
          let response = await fetch(url, options);
          try {
            response = await response.json()
          } catch(e) {
            response = null
          }
          respond(id, response);
        break;
      }
    }
  `])));
  $$PREBID_GLOBAL$$.worker.onmessage = (msg) => {
    const { data } = msg;
    const { action, params } = data;
    switch (action) {
      case 'RESPOND':
        const { id, response = {} } = params;
        if (typeof $$PREBID_GLOBAL$$.requests[id].callback === 'function') {
          $$PREBID_GLOBAL$$.requests[id].callback(JSON.stringify(response), new XMLHttpRequest());
        } else if ($$PREBID_GLOBAL$$.requests[id].callback.success) {
          $$PREBID_GLOBAL$$.requests[id].callback.success(JSON.stringify(response), new XMLHttpRequest());
        }
      break;
    }
  }
}

export const ajax = (IS_WEBWORKER_AVAILABLE) ? _webworkerBuilder() : _ajaxBuilder();

export function ajaxBuilder(timeout = 3000, {request, done} = {}) {
  return (IS_WEBWORKER_AVAILABLE) ? _webworkerBuilder() : _ajaxBuilder();
}

export function _webworkerBuilder(timeout = 3000, {request, done} = {}) {
  return function(url, callback, body, options = {}) {
    const id = (Math.random() + 1).toString(36).substring(7);
    if (!$$PREBID_GLOBAL$$.requests) {
      $$PREBID_GLOBAL$$.requests = {};
    }
    $$PREBID_GLOBAL$$.requests[id] = {
      done,
      callback
    }
    $$PREBID_GLOBAL$$.worker.postMessage({
      action: 'REQUEST',
      params: {
        id,
        url,
        body,
        options
      }
    })
  }
}

/**
 * Simple IE9+ and cross-browser ajax request function
 * Note: x-domain requests in IE9 do not support the use of cookies
 *
 * @param url string url
 * @param callback {object | function} callback
 * @param data mixed data
 * @param options object
 */
export function _ajaxBuilder(timeout = 3000, {request, done} = {}) {
  return function(url, callback, data, options = {}) {
    try {
      let x;
      let method = options.method || (data ? 'POST' : 'GET');
      let parser = document.createElement('a');
      parser.href = url;

      let callbacks = typeof callback === 'object' && callback !== null ? callback : {
        success: function() {
          logMessage('xhr success');
        },
        error: function(e) {
          logError('xhr error', null, e);
        }
      };

      if (typeof callback === 'function') {
        callbacks.success = callback;
      }

      x = new window.XMLHttpRequest();

      x.onreadystatechange = function () {
        if (x.readyState === XHR_DONE) {
          if (typeof done === 'function') {
            done(parser.origin);
          }
          let status = x.status;
          if ((status >= 200 && status < 300) || status === 304) {
            callbacks.success(x.responseText, x);
          } else {
            callbacks.error(x.statusText, x);
          }
        }
      };

      // Disabled timeout temporarily to avoid xhr failed requests. https://github.com/prebid/Prebid.js/issues/2648
      if (!config.getConfig('disableAjaxTimeout')) {
        x.ontimeout = function () {
          logError('  xhr timeout after ', x.timeout, 'ms');
        };
      }

      if (method === 'GET' && data) {
        let urlInfo = parseUrl(url, options);
        Object.assign(urlInfo.search, data);
        url = buildUrl(urlInfo);
      }

      x.open(method, url, true);
      // IE needs timeout to be set after open - see #1410
      // Disabled timeout temporarily to avoid xhr failed requests. https://github.com/prebid/Prebid.js/issues/2648
      if (!config.getConfig('disableAjaxTimeout')) {
        x.timeout = timeout;
      }

      if (options.withCredentials) {
        x.withCredentials = true;
      }
      _each(options.customHeaders, (value, header) => {
        x.setRequestHeader(header, value);
      });
      if (options.preflight) {
        x.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      }
      x.setRequestHeader('Content-Type', options.contentType || 'text/plain');

      if (typeof request === 'function') {
        request(parser.origin);
      }
      
      if (method === 'POST' && data) {
        x.send(data);
      } else {
        x.send();
      }
    } catch (error) {
      logError('xhr construction', error);
      typeof callback === 'object' && callback !== null && callback.error(error);
    }
  }
}
