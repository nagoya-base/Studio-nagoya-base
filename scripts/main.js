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
  var links = menu.querySelectorAll('a');

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

  window.addEventListener('scroll', function () {
    var calendarTop  = calendarSection.getBoundingClientRect().top;
    var windowHeight = window.innerHeight;
    if (calendarTop < windowHeight * 0.3) {
      btn.classList.add('hidden');
    } else {
      btn.classList.remove('hidden');
    }
  });

  var calendarTop  = calendarSection.getBoundingClientRect().top;
  var windowHeight = window.innerHeight;
  if (calendarTop < windowHeight * 0.3) {
    btn.classList.add('hidden');
  }
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
      modalImg.setAttribute('src', this.getAttribute('src'));
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
