/* Studio X GA4 tracking.
   Sends only categorical event data — never names, emails, dates/times,
   or free-text input. Fails silently if gtag is unavailable so booking
   links and the mood switcher keep working regardless. */
(function () {
  'use strict';

  var EVENTS = {
    BOOKING_CLICK: 'studio_x_booking_click',
    CONSULTATION_CLICK: 'studio_x_consultation_click',
    MOOD_SWITCH: 'studio_x_mood_switch',
    FORM_VIEW: 'studio_x_form_view',
    FORM_START: 'studio_x_form_start',
    FORM_SUBMIT_BOOKING: 'studio_x_form_submit_booking',
    FORM_SUBMIT_CONSULT: 'studio_x_form_submit_consult',
    FORM_SUCCESS: 'studio_x_form_success',
    FORM_ERROR: 'studio_x_form_error'
  };

  var isDebug = /(?:^|[?&])debug_mode=true(?:&|$)/.test(window.location.search);
  var sentOnce = {};
  /* studio_x_form_submit_* の二重送信防止用。送信成功1回につき1件だけ記録する。 */
  var submittedTokens = {};

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
    payload.site_section = 'studio_x';
    payload.page_path = window.location.pathname;
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
      trackEvent(eventName, {
        cta_location: location,
        destination: destination,
        link_destination: el.getAttribute('data-analytics-link-destination') || destination
      });
    }
  }

  function trackOnce(key, eventName, params) {
    if (sentOnce[key]) return;
    sentOnce[key] = true;
    trackEvent(eventName, params);
  }

  document.addEventListener('click', handleDelegatedClick);

  window.StudioXAnalytics = {
    trackMoodSwitch: function (mood) {
      trackEvent(EVENTS.MOOD_SWITCH, { mood: mood || 'unknown' });
    },
    trackFormView: function () {
      trackOnce(EVENTS.FORM_VIEW, EVENTS.FORM_VIEW, { form_id: 'studio_x_reservation_form' });
    },
    trackFormStart: function () {
      trackOnce(EVENTS.FORM_START, EVENTS.FORM_START, { form_id: 'studio_x_reservation_form' });
    },
    /* キーイベント。POST成功時のみ、1送信につき1回呼ぶこと。 */
    trackFormSubmit: function (submissionToken, intent, params) {
      var token = String(submissionToken);
      if (submittedTokens[token]) return;
      submittedTokens[token] = true;

      var eventName = intent === 'booking' ? EVENTS.FORM_SUBMIT_BOOKING : EVENTS.FORM_SUBMIT_CONSULT;
      var payload = { form_id: 'studio_x_reservation_form' };
      if (params) {
        for (var key in params) {
          if (Object.prototype.hasOwnProperty.call(params, key)) payload[key] = params[key];
        }
      }
      trackEvent(eventName, payload);
    },
    trackFormSuccess: function (intent) {
      trackEvent(EVENTS.FORM_SUCCESS, { form_id: 'studio_x_reservation_form', contact_intent: intent || 'unknown' });
    },
    trackFormError: function (errorType) {
      trackEvent(EVENTS.FORM_ERROR, { form_id: 'studio_x_reservation_form', error_type: errorType || 'unknown' });
    }
  };
})();
