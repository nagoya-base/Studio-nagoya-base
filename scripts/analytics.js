/* GA4 reservation funnel analytics.
   Sends only categorical event data — never names, emails, phone numbers,
   dates/times, or free-text input. Fails silently if gtag is unavailable
   so tracking never blocks reservation functionality.

   成果イベント（GA4管理画面でキーイベント化する対象）は generate_lead のみ。
   予約申込のPOSTが成功した時だけ送信し、送信ボタンのクリックやバリデーション
   エラーでは送信しない。

   reservation_complete は実装しない。当サイトには予約完了ページが存在せず、
   フォーム送信は「予約申込」であって予約成立ではないため（当方からの予約確定
   連絡をもって成立）、サイト側で完了を判定できない。架空の完了イベントは作らない。
   以前は POST 成功時に reservation_submit と reservation_request_complete の
   両方を発火しており、1件の申込を二重に計上していた。generate_lead 1本に統一し
   二重計上を解消する。 */
(function () {
  'use strict';

  var EVENTS = {
    SECTION_VIEW: 'section_view',
    FORM_START: 'form_start',
    FORM_ERROR: 'form_error',
    GENERATE_LEAD: 'generate_lead',
    CTA_CLICK: 'cta_click',
    OUTBOUND_CONTACT_CLICK: 'outbound_contact_click',
    BOOKING_PLATFORM_CLICK: 'booking_platform_click',
    FAQ_OPEN: 'faq_open'
  };

  var pageType = (document.body && document.body.getAttribute('data-page-type')) || 'bondage_studio';
  var siteSection = (document.body && document.body.getAttribute('data-site-section')) || 'studio_main';
  var isDebug = /(?:^|[?&])debug_mode=true(?:&|$)/.test(window.location.search);
  var sentOnce = {};
  /* 成果イベント（generate_lead）の二重送信防止用。送信成功1回につき1件だけ記録する。 */
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

    var payload = {
      site_brand: 'studio',
      page_type: pageType,
      site_section: siteSection
    };
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

  function observeSectionOnce(selector, sectionId) {
    var target = document.querySelector(selector);
    if (!target || typeof window.IntersectionObserver !== 'function') return;

    var observer = new window.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          trackOnce('section_view:' + sectionId, EVENTS.SECTION_VIEW, { section_id: sectionId });
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0 });

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
          cta_name: el.getAttribute('data-analytics-type') || 'unknown',
          cta_location: location,
          link_destination: el.getAttribute('data-analytics-destination') || undefined
        };
        break;
      case EVENTS.OUTBOUND_CONTACT_CLICK:
        params = {
          channel: el.getAttribute('data-analytics-channel') || 'unknown',
          cta_location: location
        };
        break;
      case EVENTS.BOOKING_PLATFORM_CLICK:
        params = {
          provider: el.getAttribute('data-analytics-provider') || 'unknown',
          cta_location: location
        };
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

  observeSectionOnce('#calendar', 'calendar');
  observeSectionOnce('#reservation-form', 'reservation_form');
  observeSectionOnce('#faq', 'faq');
  initFaqOpenTracking();

  window.StudioAnalytics = {
    trackFormStart: function (formName) {
      trackOnce(EVENTS.FORM_START, EVENTS.FORM_START, {
        form_name: formName || 'studio_reservation'
      });
    },
    trackFormError: function (errorType, errorCount, formName) {
      trackEvent(EVENTS.FORM_ERROR, {
        form_name: formName || 'studio_reservation',
        error_type: errorType || 'unknown',
        error_count: errorCount || 0
      });
    },
    /* キーイベント。予約申込のPOSTが成功した時だけ呼ぶこと。
       送信ボタンのクリックやバリデーションエラーでは呼ばない。
       submissionToken は1回の送信操作ごとに一意な値。同じトークンでは二度送信しない。 */
    trackGenerateLead: function (submissionToken, params) {
      var token = String(submissionToken);
      if (submittedTokens[token]) return;
      submittedTokens[token] = true;

      var payload = {
        lead_type: 'studio_reservation',
        form_name: 'studio_reservation'
      };
      if (params) {
        for (var key in params) {
          if (Object.prototype.hasOwnProperty.call(params, key)) payload[key] = params[key];
        }
      }
      trackEvent(EVENTS.GENERATE_LEAD, payload);
    }
  };
})();
