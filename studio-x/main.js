(function () {
  var menuButton = document.querySelector('.menu-button');
  var mobileMenu = document.getElementById('mobile-menu');

  if (menuButton && mobileMenu) {
    function closeMenu() {
      menuButton.setAttribute('aria-expanded', 'false');
      menuButton.setAttribute('aria-label', 'メニューを開く');
      mobileMenu.hidden = true;
      document.body.classList.remove('menu-open');
    }

    menuButton.addEventListener('click', function () {
      var willOpen = menuButton.getAttribute('aria-expanded') !== 'true';
      menuButton.setAttribute('aria-expanded', String(willOpen));
      menuButton.setAttribute('aria-label', willOpen ? 'メニューを閉じる' : 'メニューを開く');
      mobileMenu.hidden = !willOpen;
      document.body.classList.toggle('menu-open', willOpen);
    });

    mobileMenu.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', closeMenu);
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 1040) closeMenu();
    });
  }

  var moodButtons = document.querySelectorAll('.mood-button');
  var heroImage = document.getElementById('hero-image');
  var shotNumber = document.getElementById('shot-number');
  var shotLabel = document.querySelector('.hero-shot-label');

  moodButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (button.classList.contains('is-active') || !heroImage) return;

      moodButtons.forEach(function (item) {
        var active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
      });

      document.documentElement.setAttribute('data-mood', button.dataset.mood);
      heroImage.classList.add('is-changing');

      var preload = new Image();
      preload.src = button.dataset.src;
      preload.onload = function () {
        window.setTimeout(function () {
          heroImage.src = button.dataset.src;
          heroImage.alt = button.dataset.alt;
          if (shotNumber) shotNumber.textContent = button.dataset.number;
          if (shotLabel) {
            shotLabel.lastChild.textContent = ' / ' + button.dataset.label;
          }
          heroImage.classList.remove('is-changing');
        }, 120);
      };
    });
  });

  var revealElements = document.querySelectorAll('.reveal');

  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px' });

    revealElements.forEach(function (element) { observer.observe(element); });
  } else {
    revealElements.forEach(function (element) { element.classList.add('is-visible'); });
  }
})();
