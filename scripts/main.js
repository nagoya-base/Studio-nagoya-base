/* scroll-padding-top sync: keeps anchor targets below sticky nav + fixed booking banner */
(function () {
  var siteNav       = document.querySelector('nav.site-nav');
  var bookingBanner = document.querySelector('.booking-fixed-banner');
  if (!siteNav) return;
  function syncScrollPadding() {
    var navHeight    = siteNav.offsetHeight;
    var bannerHeight = bookingBanner ? bookingBanner.offsetHeight : 0;
    document.documentElement.style.scrollPaddingTop = (navHeight + bannerHeight) + 'px';
  }
  syncScrollPadding();
  var scrollPaddingResizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(scrollPaddingResizeTimer);
    scrollPaddingResizeTimer = setTimeout(syncScrollPadding, 100);
  });
})();

/* Hero padding adjustment for fixed booking banner */
(function () {
  var banner = document.querySelector('.booking-fixed-banner');
  var hero   = document.querySelector('.hero');
  if (!banner || !hero) return;
  function syncHeroPadding() {
    hero.style.paddingTop = '';
    var cssPadding = parseInt(window.getComputedStyle(hero).paddingTop, 10);
    var bannerH    = banner.offsetHeight;
    if (bannerH > cssPadding) {
      hero.style.paddingTop = bannerH + 'px';
    }
  }
  syncHeroPadding();
  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(syncHeroPadding, 100);
  });
})();

/* Hamburger menu */
(function () {
  var btn  = document.querySelector('.nav-hamburger');
  var menu = document.getElementById('navMobile');
  if (!btn || !menu) return;
  var links = menu.querySelectorAll('a, button');

  function open() {
    btn.classList.add('is-open');
    menu.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    btn.classList.remove('is-open');
    menu.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  btn.addEventListener('click', function () {
    menu.classList.contains('is-open') ? close() : open();
  });

  links.forEach(function (a) {
    a.addEventListener('click', close);
  });
})();

/* Floating booking button */
(function () {
  var btn             = document.getElementById('floatingBookingBtn');
  var calendarSection = document.getElementById('calendar');
  if (!btn || !calendarSection) return;

  btn.addEventListener('click', function () {
    calendarSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  function syncVisibility() {
    var calendarTop  = calendarSection.getBoundingClientRect().top;
    var windowHeight = window.innerHeight;
    if (calendarTop < windowHeight * 0.3) {
      btn.classList.add('hidden');
    } else {
      btn.classList.remove('hidden');
    }
  }

  var scrollTicking = false;
  window.addEventListener('scroll', function () {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(function () {
      syncVisibility();
      scrollTicking = false;
    });
  }, { passive: true });

  syncVisibility();
})();

/* Image modal */
(function () {
  var modal    = document.getElementById('imageModal');
  var modalImg = document.getElementById('modalImage');
  var closeBtn = document.querySelector('.modal-close');
  var overlay  = document.querySelector('.modal-overlay');
  if (!modal || !modalImg || !closeBtn || !overlay) return;

  var clickableImages = document.querySelectorAll('.gallery-image');

  clickableImages.forEach(function (img) {
    img.addEventListener('click', function () {
      modalImg.setAttribute('src', this.currentSrc || this.getAttribute('src'));
      modalImg.setAttribute('alt', this.getAttribute('alt'));
      modal.classList.add('show');
      document.body.style.overflow = 'hidden';
    });

    img.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.click();
      }
    });
  });

  function closeModal() {
    modal.classList.remove('show');
    document.body.style.overflow = '';
  }

  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', closeModal);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal.classList.contains('show')) {
      closeModal();
    }
  });
})();

/* Legal modal */
(function () {
  var modal = document.getElementById('legalModal');
  if (!modal) return;
  var overlay  = modal.querySelector('.legal-modal-overlay');
  var closeBtn = modal.querySelector('.legal-modal-close');
  var content  = modal.querySelector('.legal-modal-content');
  var openBtns = document.querySelectorAll('.nav-legal-btn');

  /* ページ内 #legal セクション（legal_ja.html の内容）を初回オープン時に複製。
     id はページ本体と重複しないよう接頭辞を付け、モーダル内アンカーも追従させる */
  function fillContent() {
    if (content.childElementCount > 0) return;
    var source = document.querySelector('#legal .container');
    if (!source) return;
    var clone = source.cloneNode(true);
    clone.querySelectorAll('[id]').forEach(function (el) {
      el.id = 'legal-modal-' + el.id;
    });
    clone.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.setAttribute('href', '#legal-modal-' + a.getAttribute('href').slice(1));
    });
    while (clone.firstChild) content.appendChild(clone.firstChild);
  }

  function openModal() {
    fillContent();
    modal.removeAttribute('hidden');
    document.body.style.overflow = 'hidden';
    closeBtn && closeBtn.focus();
  }

  function closeModal() {
    modal.setAttribute('hidden', '');
    document.body.style.overflow = '';
  }

  openBtns.forEach(function (btn) {
    btn.addEventListener('click', openModal);
  });

  closeBtn && closeBtn.addEventListener('click', closeModal);
  overlay  && overlay.addEventListener('click', closeModal);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hasAttribute('hidden')) closeModal();
  });
})();

/* Theme switcher */
(function () {
  var buttons = document.querySelectorAll('.theme-btn');
  if (!buttons.length) return;

  function syncButtons(theme) {
    buttons.forEach(function (btn) {
      var isActive = btn.dataset.theme === theme;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });
  }

  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var theme = btn.dataset.theme;
      document.documentElement.setAttribute('data-theme', theme);
      syncButtons(theme);
    });
  });

  syncButtons(
    document.documentElement.getAttribute('data-theme') || 'kinari'
  );
})();
