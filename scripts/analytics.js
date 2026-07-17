/* GA4 reservation funnel analytics (Phase 5).
   Sends only categorical event data — never names, emails, phone numbers,
   dates/times, or free-text input. Fails silently if gtag is unavailable
   so tracking never blocks reservation functionality. */
(function () {
  'use strict';

  var EVENTS = {
    CALENDAR_VIEW: 'reservation_calendar_view',
    FORM_VIEW: 'reservation_form_view',
    FORM_START: 'reservation_form_start',
    FORM_ERROR: 'reservation_form_error',
    SUBMIT: 'reservation_submit',
    REQUEST_COMPLETE: 'reservation_request_complete',
    REQUEST_FAILED: 'reservation_request_failed',
    CTA_CLICK: 'reservation_cta_click',
    EMAIL_CLICK: 'reservation_email_click',
    CONSULT_EMAIL_CLICK: 'consultation_email_click',
    CONSULT_X_CLICK: 'consultation_x_click',
    PAYMENT_LINK_CLICK: 'payment_link_click',
    TERMS_LINK_CLICK: 'terms_link_click',
    FAQ_VIEW: 'faq_view',
    FAQ_OPEN: 'faq_open'
  };

  var pageType = (document.body && document.body.getAttribute('data-page-type')) || 'bondage_studio';
  var isDebug = /(?:^|[?&])debug_mode=true(?:&|$)/.test(window.location.search);
  var sentOnce = {};

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

    var payload = { page_type: pageType };
    if (params) {
      for (var key in params) {
        if (Object.prototype.hasOwnProperty.call(params, key)) payload[key] = params[key];
      }
    }
    if (isDebug) payload.debug_mode = true;

    if (isDebug) console.debug('[Analytics]', eventName, payload);

    if (typeof window.gtag !== 'function') return;

    try {
      window.gtag('event', eventName, payload);
    } catch (e) {
      /* GA4送信失敗でも予約機能は継続する */
    }
  }

  function trackOnce(key, eventName, params) {
    if (sentOnce[key]) return;
    sentOnce[key] = true;
    trackEvent(eventName, params);
  }

  function observeSectionOnce(selector, eventName, params) {
    var target = document.querySelector(selector);
    if (!target || typeof window.IntersectionObserver !== 'function') return;

    var observer = new window.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          trackOnce(eventName, eventName, params);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });

    observer.observe(target);
  }

  function handleDelegatedClick(event) {
    var el = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-analytics-event]')
      : null;
    if (!el) return;

    var eventName = el.getAttribute('data-analytics-event');
    var location = el.getAttribute('data-analytics-location') || 'other';
    var params;

    switch (eventName) {
      case EVENTS.CTA_CLICK:
        params = {
          cta_location: location,
          cta_type: el.getAttribute('data-analytics-type') || 'unknown',
          destination: el.getAttribute('data-analytics-destination') || 'unknown'
        };
        break;
      case EVENTS.EMAIL_CLICK:
        params = { cta_location: location, reservation_type: 'email' };
        break;
      case EVENTS.CONSULT_EMAIL_CLICK:
        params = { cta_location: location, consultation_type: 'email' };
        break;
      case EVENTS.CONSULT_X_CLICK:
        params = { cta_location: location, consultation_type: 'x_dm' };
        break;
      case EVENTS.PAYMENT_LINK_CLICK:
        params = {
          payment_provider: 'stripe',
          payment_stage: 'after_reservation_confirmation',
          cta_location: location
        };
        break;
      case EVENTS.TERMS_LINK_CLICK:
        params = { cta_location: location, destination: 'terms' };
        break;
      default:
        return;
    }

    trackEvent(eventName, params);
  }

  function initFaqOpenTracking() {
    var items = document.querySelectorAll('.faq-item[data-analytics-faq-id]');
    items.forEach(function (item) {
      item.addEventListener('toggle', function () {
        if (item.open) {
          trackEvent(EVENTS.FAQ_OPEN, { faq_id: item.getAttribute('data-analytics-faq-id') });
        }
      });
    });
  }

  document.addEventListener('click', handleDelegatedClick);

  observeSectionOnce('#calendar', EVENTS.CALENDAR_VIEW, { section_id: 'calendar' });
  observeSectionOnce('#reservation-form', EVENTS.FORM_VIEW, { form_id: 'reservation_form' });
  observeSectionOnce('#faq', EVENTS.FAQ_VIEW, { section_id: 'faq' });
  initFaqOpenTracking();

  window.StudioAnalytics = {
    trackFormStart: function () {
      trackOnce(EVENTS.FORM_START, EVENTS.FORM_START, { form_id: 'reservation_form' });
    },
    trackFormError: function (errorType, errorCount) {
      trackEvent(EVENTS.FORM_ERROR, {
        form_id: 'reservation_form',
        error_type: errorType || 'unknown',
        error_count: errorCount || 0
      });
    },
    trackSubmit: function () {
      trackEvent(EVENTS.SUBMIT, { form_id: 'reservation_form' });
    },
    trackRequestComplete: function (params) {
      var payload = { form_id: 'reservation_form', reservation_type: 'form' };
      if (params) {
        for (var key in params) {
          if (Object.prototype.hasOwnProperty.call(params, key)) payload[key] = params[key];
        }
      }
      trackEvent(EVENTS.REQUEST_COMPLETE, payload);
    },
    trackRequestFailed: function (failureType) {
      trackEvent(EVENTS.REQUEST_FAILED, {
        form_id: 'reservation_form',
        failure_type: failureType || 'unknown'
      });
    }
  };
})();
