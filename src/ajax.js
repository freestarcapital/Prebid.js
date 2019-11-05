import { parse as parseURL, format as formatURL } from './url';
import { config } from './config';

const utils = require('./utils');

export const ajax = ajaxBuilder();

export function ajaxBuilder(timeout = 3000, {request, done} = {}) {
  return function(url, callback, data, options = {}) {
    try {
      const timeoutPromise = (promise, callbacks, timeout, done = null) => {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            const timeoutErrorMessage = `fetch timeout after ${timeout}ms`;
            if (!config.getConfig('disableAjaxTimeout')) {
              utils.logError(timeoutErrorMessage);
            }
            reject(new Error(timeoutErrorMessage));
          }, timeout);
          promise.then(response => {
            if (typeof done === 'function') {
              done(parser.origin);
            }
            const { status } = response;
            if ((status >= 200 && status < 300) || status === 304) {
              return response.json();
            } else {
              const errorMessage = new Error(response);
              utils.logMessage('fetch error', errorMessage);
              throw errorMessage;
            }
          }).then(data => {
            callbacks.success(data, data);
          }).catch(error => {
            callbacks.error(error);
          });
        });
      };
      let method = options.method || (data ? 'POST' : 'GET');
      let parser = document.createElement('a');
      parser.href = url;

      let callbacks = typeof callback === 'object' && callback !== null ? callback : {
        success: function() {
          utils.logMessage('xhr success');
        },
        error: function(e) {
          utils.logError('xhr error', null, e);
        }
      };

      if (typeof callback === 'function') {
        callbacks.success = callback;
      }

      const fetchParams = {
        method: 'GET',
        headers: []
      };

      if (method === 'GET' && data) {
        let urlInfo = parseURL(url, options);
        Object.assign(urlInfo.search, data);
        url = formatURL(urlInfo);
      }

      if (options.withCredentials) {
        fetchParams.credentials = 'include';
      }

      utils._each(options.customHeaders, (value, header) => {
        fetchParams.headers[header] = value;
      });

      if (options.preflight) {
        fetchParams.headers['X-Requested-With'] = 'XMLHttpRequest';
      }

      fetchParams.headers['Content-Type'] = options.contentType || 'text/plain';

      if (typeof request === 'function') {
        request(parser.origin);
      }

      if (method === 'POST' && data) {
        fetchParams.method = 'POST';
        fetchParams.body = data;
      }

      timeoutPromise(fetch(url, fetchParams), callbacks, parser, timeout, done);
    } catch (error) {
      utils.logError('fetch construction', error);
    }
  }
};
