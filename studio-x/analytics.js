/* Studio X GA4 tracking.
   Sends only categorical event data — never names, emails, dates/times,
   or free-text input. Fails silently if gtag is unavailable so booking
   links and the mood switcher keep working regardless. */
(function () {
  'use strict';

  var EVENTS = {
    BOOKING_PLATFORM_CLICK: 'booking_platform_click',
    OUTBOUND_CONTACT_CLICK: 'outbound_contact_click',
    CTA_CLICK: 'cta_click',
    SECTION_VIEW: 'section_view'
  };

  var isDebug = /(?:^|[?&])debug_mode=true(?:&|$)/.test(window.location.search);
  var sectionFired = {};

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
    payload.site_brand = 'studio';
    payload.site_section = 'studio_x';
    payload.page_type = 'top';
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

    switch (eventName) {
      case EVENTS.BOOKING_PLATFORM_CLICK:
        trackEvent(eventName, {
          provider: el.getAttribute('data-analytics-provider') || 'spacemarket',
          cta_location: location
        });
        break;
      case EVENTS.OUTBOUND_CONTACT_CLICK:
        trackEvent(eventName, {
          channel: el.getAttribute('data-analytics-channel') || 'unknown',
          cta_location: location
        });
        break;
      case EVENTS.CTA_CLICK:
        trackEvent(eventName, {
          cta_name: el.getAttribute('data-analytics-type') || 'unknown',
          cta_location: location,
          mood_color: el.getAttribute('data-analytics-mood-color') || undefined
        });
        break;
      default:
        break;
    }
  }

  document.addEventListener('click', handleDelegatedClick);

  if ('IntersectionObserver' in window) {
    var sectionObserver = new window.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var sectionId = entry.target.getAttribute('data-analytics-section-view');
        if (sectionFired[sectionId]) return;
        sectionFired[sectionId] = true;
        trackEvent(EVENTS.SECTION_VIEW, { section_id: sectionId });
        sectionObserver.unobserve(entry.target);
      });
    }, { threshold: 0 });
    document.querySelectorAll('[data-analytics-section-view]').forEach(function (el) {
      sectionObserver.observe(el);
    });
  }

  window.StudioXAnalytics = {
    /* cta_click（cta_name: mood_switch）。キーイベントにはしない。 */
    trackMoodSwitch: function (mood) {
      trackEvent(EVENTS.CTA_CLICK, { cta_name: 'mood_switch', cta_location: 'mood_switcher', mood_color: mood || 'unknown' });
    }
  };
})();
