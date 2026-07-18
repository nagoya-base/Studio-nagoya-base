/* Studio X GA4 tracking.
   Sends only categorical event data — never names, emails, dates/times,
   or free-text input. Fails silently if gtag is unavailable so booking
   links and the mood switcher keep working regardless. */
(function () {
  'use strict';

  var EVENTS = {
    BOOKING_CLICK: 'studio_x_booking_click',
    CONSULTATION_CLICK: 'studio_x_consultation_click',
    MOOD_SWITCH: 'studio_x_mood_switch'
  };

  var isDebug = /(?:^|[?&])debug_mode=true(?:&|$)/.test(window.location.search);

  function isTrackableEnvironment() {
    if (isDebug) return true;
    var protocol = window.location.protocol;
    var hostname = window.location.hostname;
    if (protocol === 'file:') return false;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return false;
    return true;
  }

  function trackEvent(eventName, params) {
    if (!isTrackableEnvironment()) return;

    var payload = params || {};
    if (isDebug) payload.debug_mode = true;

    if (isDebug) console.debug('[StudioXAnalytics]', eventName, payload);

    if (typeof window.gtag !== 'function') return;
    try {
      window.gtag('event', eventName, payload);
    } catch (e) {
      /* GA4送信失敗でも予約導線・画像切替は継続する */
    }
  }

  function handleDelegatedClick(event) {
    var el = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-analytics-event]')
      : null;
    if (!el) return;

    var eventName = el.getAttribute('data-analytics-event');
    var location = el.getAttribute('data-analytics-location') || 'other';
    var destination = el.getAttribute('data-analytics-destination') || 'unknown';

    if (eventName === EVENTS.BOOKING_CLICK || eventName === EVENTS.CONSULTATION_CLICK) {
      trackEvent(eventName, { cta_location: location, destination: destination });
    }
  }

  document.addEventListener('click', handleDelegatedClick);

  window.StudioXAnalytics = {
    trackMoodSwitch: function (mood) {
      trackEvent(EVENTS.MOOD_SWITCH, { mood: mood || 'unknown' });
    }
  };
})();
