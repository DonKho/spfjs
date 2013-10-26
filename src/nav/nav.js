/**
 * @fileoverview Functions to handle pushstate-based navigation.
 *
 * @author nicksay@google.com (Alex Nicksay)
 */


goog.provide('spf.nav');

goog.require('spf');
goog.require('spf.config');
goog.require('spf.debug');
goog.require('spf.dom');
goog.require('spf.dom.classlist');
goog.require('spf.history');
goog.require('spf.nav.request');
goog.require('spf.nav.response');
goog.require('spf.nav.url');
goog.require('spf.state');
goog.require('spf.tasks');


/**
 * Initializes (enables) pushState navigation.
 */
spf.nav.init = function() {
  spf.history.init(spf.nav.handleHistory_);
  if (!spf.state.get('nav-init') && document.addEventListener) {
    document.addEventListener('click', spf.nav.handleClick_, false);
    spf.state.set('nav-init', true);
    spf.state.set('nav-counter', 0);
    spf.state.set('nav-time', spf.now());
    spf.state.set('nav-listener', spf.nav.handleClick_);
  }
};


/**
 * Disposes (disables) pushState navigation.
 */
spf.nav.dispose = function() {
  spf.nav.cancel();
  if (spf.state.get('nav-init')) {
    if (document.removeEventListener) {
      document.removeEventListener('click', /** @type {function(Event)} */ (
          spf.state.get('nav-listener')), false);
    }
    spf.state.set('nav-init', false);
    spf.state.set('nav-counter', null);
    spf.state.set('nav-time', null);
    spf.state.set('nav-listener', null);
  }
  spf.history.dispose();
};


/**
 * Handles page clicks on SPF links and adds pushState history entries for them.
 *
 * @param {Event} evt The click event.
 * @private
 */
spf.nav.handleClick_ = function(evt) {
  spf.debug.debug('nav.handleClick ', 'evt=', evt);
  // Ignore clicks with modifier keys.
  if (evt.metaKey || evt.altKey || evt.ctrlKey || evt.shiftKey) {
    spf.debug.debug('    ignoring click with modifier key');
    return;
  }
  // Ignore clicks with alternate buttons (left = 0, middle = 1, right = 2).
  if (evt.button > 0) {
    spf.debug.debug('    ignoring click with alternate button');
    return;
  }
  // Ignore clicks on targets without the link class or not within
  // a container with the link class.
  var linkEl = spf.dom.getAncestor(evt.target, function(node) {
    return spf.dom.classlist.contains(node, /** @type {string} */ (
        spf.config.get('link-class')));
  });
  if (!linkEl) {
    spf.debug.debug('    ignoring click without link class');
    return;
  }
  // Ignore clicks on targets with the nolink class or within
  // a container with the nolink class.
  if (spf.config.get('nolink-class')) {
    var nolinkEl = spf.dom.getAncestor(evt.target, function(node) {
      return spf.dom.classlist.contains(node, /** @type {string} */ (
          spf.config.get('nolink-class')));
    });
    if (nolinkEl) {
      spf.debug.debug('    ignoring click with nolink class');
      return;
    }
  }
  // Adjust the target element to be the one with an href.
  var target = spf.dom.getAncestor(evt.target, function(node) {
    // Images in IE10 can have an href.
    return node.href && node.tagName.toLowerCase() != 'img';
  }, linkEl);
  // Ignore clicks on targets without an href.
  if (!target) {
    spf.debug.debug('    ignoring click without href');
    return;
  }
  // Ignore clicks to the same page or to empty URLs.
  var url = target.href;
  if (!url || url == window.location.href) {
    spf.debug.debug('    ignoring click to same page');
    // Prevent the default browser navigation to avoid hard refreshes.
    evt.preventDefault();
    return;
  }
  // Navigate to the URL.
  spf.nav.navigate_(url);
  // Prevent the default browser navigation to avoid hard refreshes.
  evt.preventDefault();
};


/**
 * Handles when the active history entry changes.
 *
 * @param {string} url The URL the user is browsing to.
 * @param {Object=} opt_state An optional state object associated with the URL.
 * @private
 */
spf.nav.handleHistory_ = function(url, opt_state) {
  var reverse = !!(opt_state && opt_state['spf-back']);
  var referer = opt_state && opt_state['spf-referer'];
  spf.debug.debug('nav.handleHistory ', '(url=', url, 'state=', opt_state, ')');
  // Navigate to the URL.
  spf.nav.navigate_(url, null, referer, true, reverse);
};


/**
 * Navigates to a URL.
 *
 * A pushState history entry is added for the URL, and if successful, the
 * navigation is performed.  If not, the browser is redirected to the URL.
 * During the navigation, first the content is requested.  If the reponse is
 * sucessfully parsed, it is processed.  If not, the browser is redirected to
 * the URL.  Only a single navigation request can be in flight at once.  If a
 * second URL is navigated to while a first is still pending, the first will be
 * cancelled.
 *
 * @param {string} url The URL to navigate to, without the SPF identifier.
 * @param {spf.RequestOptions=} opt_options Optional request options object.
 */
spf.nav.navigate = function(url, opt_options) {
  // Ignore navigation to the same page or to an empty URL.
  if (!url || url == window.location.href) {
    return;
  }
  // Navigate to the URL.
  spf.nav.navigate_(url, opt_options);
};


/**
 * Performs navigation to a URL.
 * See {@link #navigate}, {@link #handleClick}, and {@link #handleHistory}.
 *
 * @param {string} url The URL to navigate to, without the SPF identifier.
 * @param {?spf.RequestOptions=} opt_options Optional request options object.
 * @param {string=} opt_referer The Referrer URL, without the SPF identifier.
 *     Defaults to the current URL.
 * @param {boolean=} opt_history Whether this navigation is part of a history
 *     change. True when navigation is in response to a popState event.
 * @param {boolean=} opt_reverse Whether this is "backwards" navigation. True
 *     when the "back" button is clicked and navigation is in response to a
 *     popState event.
 * @private.
 */
spf.nav.navigate_ = function(url, opt_options, opt_referer, opt_history,
                             opt_reverse) {
  spf.debug.info('nav.navigate ', url, opt_options, opt_referer, opt_history,
                 opt_reverse);
  var options = opt_options || /** @type {spf.RequestOptions} */ ({});
  // Execute the "navigation requested" callback.  If the callback explicitly
  // cancels (by returning false), cancel this navigation and redirect.
  if (!spf.nav.callback('navigate-requested-callback', url)) {
    spf.nav.redirect(url);
    return;
  }
  // If navigation is requested but SPF is not initialized, redirect.
  if (!spf.state.get('nav-init')) {
    spf.debug.warn('navigation not initialized');
    spf.nav.redirect(url);
    return;
  }
  // If a session limit has been set and reached, redirect.
  var count = (parseInt(spf.state.get('nav-counter'), 10) || 0) + 1;
  var limit = parseInt(spf.config.get('navigate-limit'), 10);
  limit = isNaN(limit) ? Infinity : limit;
  if (count > limit) {
    spf.debug.warn('navigation limit reached');
    spf.nav.redirect(url);
    return;
  }
  spf.state.set('nav-counter', count);
  // If a session lifetime has been set and reached, redirect.
  var timestamp = parseInt(spf.state.get('nav-time'), 10);
  var age = spf.now() - timestamp;
  var lifetime = parseInt(spf.config.get('navigate-lifetime'), 10);
  lifetime = isNaN(lifetime) ? Infinity : lifetime;
  if (age > lifetime) {
    spf.debug.warn('navigation lifetime reached');
    spf.nav.redirect(url);
    return;
  }
  spf.state.set('nav-time', spf.now());
  // Set the navigation referer, stored in the history entry state object
  // to allow the correct value to be sent to the server during back/forward.
  // Only different than the current URL when navigation is in response to
  // a popState event.
  var referer = opt_referer || window.location.href;

  // Abort previous navigation, if needed.
  spf.nav.cancel();
  // Abort all ongoing prefetch requests, except for the navigation one if it
  // exists.  This will reduce network contention for the navigation request
  // by eliminating concurrent reqeuests that will not be used.
  spf.nav.cancelAllPrefetchesExcept(url);
  // Cancel all preprocessing being done for completed single or ongoing
  // multipart prefetch response, except for the navigation one if it exists.
  // If the navigation one is a completed single response, the task will be
  // canceled in spf.nav.navigatePromotePrefetch_.  If it is an ongoing
  // multipart response, allow it to continue processing until the completed.
  var key = 'preprocess ' + spf.nav.url.absolute(url);
  spf.tasks.cancelAllExcept('preprocess', key);


  // Set the current nav request to be the prefetch, if it exists.
  var prefetches = spf.nav.prefetches_();
  var prefetchXhr = prefetches[url];
  spf.state.set('nav-request', prefetchXhr);
  // Make sure there is no current nav intention set.
  spf.state.set('nav-intention', null);

  // Check the prefetch XHR.  If it is not done, state an intention to navigate.
  // Otherwise, navigate immediately.
  if (prefetchXhr && prefetchXhr.readyState != 4) {
    // Wait for completion by stating our intention to navigate and
    // let the onSuccess handler take care of the navigation.
    var promotePrefetch = spf.bind(spf.nav.navigatePromotePrefetch_, null,
                                   url, options, referer, !!opt_history,
                                   !!opt_reverse);
    spf.state.set('nav-intention', promotePrefetch);
    return;
  }
  spf.nav.navigateSendRequest_(url, options, referer, !!opt_history,
                               !!opt_reverse);
};


/**
 * Promotes a prefetch request to a navigation after it completes.
 * See {@link navigate}.
 *
 * @param {string} url The URL to navigate to, without the SPF identifier.
 * @param {spf.RequestOptions} options Request options object.
 * @param {string} referer The Referrer URL, without the SPF identifier.
 * @param {boolean} history Whether this navigation is part of a history
 *     change. True when navigation is in response to a popState event.
 * @param {boolean} reverse Whether this is "backwards" navigation. True
 *     when the "back" button is clicked and navigation is in response to a
 *     popState event.
 * @param {string} prefetchUrl The URL of the prefetch, passed to ensure
 *     the wrong prefetch request is not promoted.
 * @return {boolean} Whether the promotion was successful.
 * @private
 */
spf.nav.navigatePromotePrefetch_ = function(url, options, referer, history,
                                            reverse, prefetchUrl) {
  // Verify that the navigate url and the prefetch url are the
  // same. Once all of the prefetches are killed and nav-intention
  // has been set, other prefetches can still start. If prefetch B
  // starts after navigate request A, and prefetch B finishes before
  // the prefetch A, the completion of prefetch B will start the
  // navigateRequest before prefetch A has finished, resulting in
  // a cache miss.
  if (prefetchUrl != url) {
    return false;
  }
  spf.state.set('nav-intention', null);
  var key = 'preprocess ' + spf.nav.url.absolute(url);
  spf.tasks.cancel(key);
  spf.nav.navigateSendRequest_(url, options, referer, history, reverse);
  return true;
};


/**
 * Send the navigation request.
 * See {@link navigate}.
 *
 * @param {string} url The URL to navigate to, without the SPF identifier.
 * @param {spf.RequestOptions} options Request options object.
 * @param {string} referer The Referrer URL, without the SPF identifier.
 * @param {boolean} history Whether this navigation is part of a history
 *     change. True when navigation is in response to a popState event.
 * @param {boolean} reverse Whether this is "backwards" navigation. True
 *     when the "back" button is clicked and navigation is in response to a
 *     popState event.
 * @private
 */
spf.nav.navigateSendRequest_ = function(url, options, referer, history,
                                        reverse) {
  var handleError = spf.bind(spf.nav.handleNavigateError_, null,
                             options);
  var handlePart = spf.bind(spf.nav.handleNavigatePart_, null,
                            options, reverse);
  var handleSuccess = spf.bind(spf.nav.handleNavigateSuccess_, null,
                               options, referer, reverse);

  var startTime = /** @type {number} */ (spf.state.get('nav-time'));
  var xhr = spf.nav.request.send(url, {
    method: options['method'],
    onPart: handlePart,
    onError: handleError,
    onSuccess: handleSuccess,
    postData: options['postData'],
    type: 'navigate',
    referer: referer,
    startTime: startTime
  });
  spf.state.set('nav-request', xhr);

  // After the request has been sent, check for new navigation that needs
  // a history entry added.  Do this after sending the XHR to have the
  // correct referer for regular navigation (but not history navigation).
  if (!history) {
    try {
      // Add the URL to the history stack.
      var state = {'spf-referer': referer};
      spf.history.add(url, state);
    } catch (err) {
      // Abort the navigation.
      spf.nav.cancel();
      // An error is thrown if the state object is too large or if the
      // URL is not in the same domain.
      spf.debug.error('error caught, redirecting ',
                      '(url=', url, 'err=', err, ')');
      handleError(url, err);
    }
  }
};


/**
 * Handles a navigation error.
 * See {@link navigate}.
 *
 * @param {spf.RequestOptions} options Request options object.
 * @param {string} url The requested URL, without the SPF identifier.
 * @param {Error} err The Error object.
 * @private
 */
spf.nav.handleNavigateError_ = function(options, url, err) {
  spf.debug.warn('navigate error', '(url=', url, ')');
  spf.state.set('nav-request', null);
  // Execute the "onError" and "navigation error" callbacks.  If either
  // explicitly cancels (by returning false), ignore the error.
  // Otherwise, redirect.
  if (!spf.nav.callback(options['onError'], url, err)) {
    return;
  }
  if (!spf.nav.callback('navigate-error-callback', url, err)) {
    return;
  }
  spf.nav.redirect(url);
};


/**
 * Handles a navigation partial response.
 * See {@link navigate}.
 *
 * @param {spf.RequestOptions} options Request options object.
 * @param {boolean} reverse Whether this is "backwards" navigation. True
 *     when the "back" button is clicked and navigation is in response to a
 *     popState event.
 * @param {string} url The requested URL, without the SPF identifier.
 * @param {spf.SingleResponse} partial The partial response object.
 * @private
 */
spf.nav.handleNavigatePart_ = function(options, reverse, url, partial) {
  // Execute the "navigation part received" callback.  If the callback
  // explicitly cancels (by returning false), cancel this navigation and
  // redirect.
  if (!spf.nav.callback('navigate-part-received-callback', url, partial)) {
    spf.nav.redirect(url);
    return;
  }
  spf.nav.response.process(url, partial, function() {
    // Execute the "onPart" and "navigation part processed" callbacks.  If
    // either explicitly cancels (by returning false), cancel this navigation
    // and redirect.
    if (!spf.nav.callback(options['onPart'], url, partial)) {
      spf.nav.redirect(url);
      return;
    }
    if (!spf.nav.callback('navigate-part-processed-callback', url, partial)) {
      spf.nav.redirect(url);
      return;
    }
  }, reverse);
};


/**
 * Handles a navigation complete response.
 * See {@link navigate}.
 *
 * @param {spf.RequestOptions} options Request options object.
 * @param {string} referer The Referrer URL, without the SPF identifier.
 * @param {boolean} reverse Whether this is "backwards" navigation. True
 *     when the "back" button is clicked and navigation is in response to a
 *     popState event.
 * @param {string} url The requested URL, without the SPF identifier.
 * @param {spf.SingleResponse|spf.MultipartResponse} response The response
 *     object, either a complete single or multipart response object.
 * @private
 */
spf.nav.handleNavigateSuccess_ = function(options, referer, reverse, url,
                                          response) {
  spf.state.set('nav-request', null);
  // Execute the "navigation received" callback.  If the callback
  // explicitly cancels (by returning false), cancel this navigation and
  // redirect.
  if (!spf.nav.callback('navigate-received-callback', url, response)) {
    spf.nav.redirect(url);
    return;
  }

  // Check for redirect responses.
  if (response['redirect']) {
    var redirectUrl = response['redirect'];
    //
    // TODO(nicksay): Figure out navigate callbacks + redirects.
    //
    // Replace the current history entry with the redirect,
    // executing the callback to trigger the next navigation.
    var state = {'spf-referer': referer};
    spf.history.replace(redirectUrl, state, true);
    return;
  }

  // Process the requested response.
  // If a multipart response was received, all processing is already done,
  // so just execute the global notification.  Call process with an empty
  // object to ensure the callback is properly queued.
  var r = /** @type {spf.SingleResponse} */ (
      (response['type'] == 'multipart') ? {} : response);
  spf.nav.response.process(url, r, function() {
    // Execute the "onSuccess" and "navigation processed" callbacks.
    // NOTE: If either explicitly cancels (by returning false), nothing
    // happens, because there is no longer an opportunity to stop navigation.
    if (!spf.nav.callback(options['onSuccess'], url, response)) {
      return;
    }
    spf.nav.callback('navigate-processed-callback', url, response);
  }, reverse);
};


/**
 * Cancels the current navigation request, if any.
 */
spf.nav.cancel = function() {
  var xhr = /** @type {XMLHttpRequest} */ (spf.state.get('nav-request'));
  if (xhr) {
    spf.debug.warn('aborting previous navigate ',
                   'xhr=', xhr);
    xhr.abort();
    spf.state.set('nav-request', null);
  }
};


/**
 * Executes an external callback and checks whether the callbacks was canceled
 * with an explicit return value of {@code false}.
 *
 * @param {Function|string} fn Callback function to be executed.
 * @param {...*} var_args Arguments to apply to the function.
 * @return {boolean} False if the callback explicitly returned false to cancel
 *     the operation; true otherwise.
 */
spf.nav.callback = function(fn, var_args) {
  if (typeof fn == 'string') {
    fn = /** @type {Function} */ (spf.config.get(fn));
  }
  var args = Array.prototype.slice.call(arguments, 0);
  args[0] = fn;
  var val = spf.execute.apply(null, args);
  if (val instanceof Error) {
    spf.debug.error('error in callback (url=', window.location.href,
                    'err=', val, ')');
  }
  return (val !== false);
};


/**
 * Redirect to a URL, to be used when navigation fails or is disabled.
 *
 * @param {string} url The requested URL, without the SPF identifier.
 */
spf.nav.redirect = function(url) {
  spf.debug.warn('redirecting (', 'url=', url, ')');
  spf.nav.cancel();
  spf.nav.cancelAllPrefetchesExcept();
  window.location.href = url;
};


/**
 * Loads a URL.
 *
 * Similar to {@link spf.navigate}, but intended for traditional content
 * updates, not page navigation.  Not subject to restrictions on the number of
 * simultaneous requests.  The content is first requested.  If the response is
 * successfully parsed, it is processed and the URL and response object are
 * passed to the optional {@code onSuccess} callback.  If not, the URL is passed
 * to the optional {@code onError} callback.
 *
 * @param {string} url The URL to load, without the SPF identifier.
 * @param {spf.RequestOptions=} opt_options Optional request options object.
 */
spf.nav.load = function(url, opt_options) {
  spf.debug.info('nav.load ', url, opt_options);
  var options = opt_options || /** @type {spf.RequestOptions} */ ({});

  var handleError = spf.bind(spf.nav.handleLoadError_, null,
                             false, options);
  var handlePart = spf.bind(spf.nav.handleLoadPart_, null,
                            false, options);
  var handleSucces = spf.bind(spf.nav.handleLoadSuccess_, null,
                              false, options);

  spf.nav.request.send(url, {
    method: options['method'],
    onPart: handlePart,
    onError: handleError,
    onSuccess: handleSucces,
    postData: options['postData'],
    type: 'load'
  });
};


/**
 * Prefetches a URL.
 *
 * Use to prime the SPF request cache with the content and the browser cache
 * with script and stylesheet URLs.
 *
 * The content is first requested.  If the response is successfully parsed, it
 * is preprocessed to prefetch scripts and stylesheets, and the URL and
 * response object are then passed to the optional {@code onSuccess}
 * callback. If not, the URL is passed to the optional {@code onError}
 * callback.
 *
 * @param {string} url The URL to prefetch, without the SPF identifier.
 * @param {spf.RequestOptions=} opt_options Optional request options object.
 */
spf.nav.prefetch = function(url, opt_options) {
  spf.debug.info('nav.prefetch ', url, opt_options);
  var options = opt_options || /** @type {spf.RequestOptions} */ ({});

  var handleError = spf.bind(spf.nav.handleLoadError_, null,
                             true, options);
  var handlePart = spf.bind(spf.nav.handleLoadPart_, null,
                            true, options);
  var handleSucces = spf.bind(spf.nav.handleLoadSuccess_, null,
                              true, options);

  var xhr = spf.nav.request.send(url, {
    method: options['method'],
    onPart: handlePart,
    onError: handleError,
    onSuccess: handleSucces,
    postData: options['postData'],
    type: 'prefetch'
  });
  spf.nav.addPrefetch(url, xhr);
};


/**
 * Handles a load or prefetch error.
 * See {@link load} and {@link prefetch}.
 *
 * @param {boolean} isPrefetch True for prefetch; false for load.
 * @param {spf.RequestOptions} options Request options object.
 * @param {string} url The requested URL, without the SPF identifier.
 * @param {Error} err The Error object.
 * @private
 */
spf.nav.handleLoadError_ = function(isPrefetch, options, url, err) {
  spf.debug.warn(isPrefetch ? 'prefetch' : 'load', 'error', '(url=', url, ')');
  spf.nav.callback(options['onError'], url, err);
  if (isPrefetch) {
    spf.nav.cancelPrefetch(url);
  }
};


/**
 * Handles a load or prefetch partial response.
 * See {@link load} and {@link prefetch}.
 *
 * @param {boolean} isPrefetch True for prefetch; false for load.
 * @param {spf.RequestOptions} options Request options object.
 * @param {string} url The requested URL, without the SPF identifier.
 * @param {spf.SingleResponse} partial The partial response object.
 * @private
 */
spf.nav.handleLoadPart_ = function(isPrefetch, options, url, partial) {
  var processFn = isPrefetch ?
      spf.nav.response.preprocess :
      spf.nav.response.process;
  processFn(url, partial, function() {
    spf.nav.callback(options['onPart'], url, partial);
  });
};


/**
 * Handles a load or prefetch complete response.
 * See {@link load} and {@link prefetch}.
 *
 * @param {boolean} isPrefetch True for prefetch; false for load.
 * @param {spf.RequestOptions} options Request options object.
 * @param {string} url The requested URL, without the SPF identifier.
 * @param {spf.SingleResponse|spf.MultipartResponse} response The response
 *     object, either a complete single or multipart response object.
 * @private
 */
spf.nav.handleLoadSuccess_ = function(isPrefetch, options, url, response) {
  var redirectFn = isPrefetch ? spf.nav.prefetch : spf.nav.load;
  // Check for redirects.
  if (response['redirect']) {
    // Note that POST is not propagated with redirects.
    var redirectOpts = /** @type {spf.RequestOptions} */ ({
      'onSuccess': options['onSuccess'],
      'onPart': options['onPart'],
      'onError': options['onError']
    });
    redirectFn(response['redirect'], redirectOpts);
    return;
  }
  if (isPrefetch) {
    // Check if there is a navigation intention.  If there is, call it to
    // to promote the prefetch to a navigation request.
    spf.nav.cancelPrefetch(url);
    var navIntent = /** @type {Function} */ (spf.state.get('nav-intention'));
    if (navIntent && navIntent(url)) {
      return;
    }
  }
  // Process the requested response.
  // If a multipart response was received, all processing is already done,
  // so just execute the callback.  Call process with an empty
  // object to ensure the callback is properly queued.
  var processFn = isPrefetch ?
      spf.nav.response.preprocess :
      spf.nav.response.process;
  var r = (response['type'] == 'multipart') ? {} : response;
  processFn(url, r, function() {
    spf.nav.callback(options['onSuccess'], url, response);
  });
};


/**
 * Add a prefetch request to the set of ongoing prefetches.
 *
 * @param {string} url The url of the prefetch request.
 * @param {XMLHttpRequest} xhr The prefetch request object.
 */
spf.nav.addPrefetch = function(url, xhr) {
  spf.debug.debug('nav.addPrefetch ', url, xhr);
  var absoluteUrl = spf.nav.url.absolute(url);
  var prefetches = spf.nav.prefetches_();
  prefetches[absoluteUrl] = xhr;
};

/**
 * Cancels a single prefetch request and removes it from the set.
 *
 * @param {string} url The url of the prefetch to be aborted.
 */
spf.nav.cancelPrefetch = function(url) {
  spf.debug.debug('nav.cancelPrefetch ', url);
  var absoluteUrl = spf.nav.url.absolute(url);
  var prefetches = spf.nav.prefetches_();
  var prefetchXhr = prefetches[absoluteUrl];
  if (prefetchXhr) {
    prefetchXhr.abort();
  }
  delete prefetches[absoluteUrl];
};


/**
 * Cancels all ongoing prefetch requests, optionally skipping the given url.
 *
 * @param {string=} opt_skipUrl A url of the request that should not
 *     be canceled.
 */
spf.nav.cancelAllPrefetchesExcept = function(opt_skipUrl) {
  spf.debug.debug('nav.cancelAllPrefetchesExcept');
  var prefetches = spf.nav.prefetches_();
  for (var key in prefetches) {
    if (opt_skipUrl != key) {
      spf.nav.cancelPrefetch(key);
    }
  }
};


/**
 * @param {!Object.<string, XMLHttpRequest>=} opt_reqs
 *     Optional set of requests to overwrite the current value.
 * @return {!Object.<string, XMLHttpRequest>} Current map
 *     of requests.
 * @private
 */
spf.nav.prefetches_ = function(opt_reqs) {
  if (opt_reqs || !spf.state.has('nav-prefetches')) {
    return /** @type {!Object.<string, XMLHttpRequest>} */ (
        spf.state.set('nav-prefetches', (opt_reqs || {})));
  }
  return /** @type {!Object.<string, XMLHttpRequest>} */ (
      spf.state.get('nav-prefetches'));
};
