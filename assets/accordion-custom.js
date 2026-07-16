import { mediaQueryLarge, isMobileBreakpoint } from '@theme/utilities';

// Accordion
class AccordionCustom extends HTMLElement {
  /** @type {HTMLDetailsElement} */
  get details() {
    const details = this.querySelector('details');

    if (!(details instanceof HTMLDetailsElement)) throw new Error('Details element not found');

    return details;
  }

  /** @type {HTMLElement} */
  get summary() {
    const summary = this.details.querySelector('summary');

    if (!(summary instanceof HTMLElement)) throw new Error('Summary element not found');

    return summary;
  }

  get #disableOnMobile() {
    return this.dataset.disableOnMobile === 'true';
  }

  get #disableOnDesktop() {
    return this.dataset.disableOnDesktop === 'true';
  }

  get #closeWithEscape() {
    return this.dataset.closeWithEscape === 'true';
  }

  #controller = new AbortController();

  connectedCallback() {
    const { signal } = this.#controller;

    this.#latchFromFragment();
    this.#setDefaultOpenState();

    this.addEventListener('keydown', this.#handleKeyDown, { signal });
    this.summary.addEventListener('click', this.handleClick, { signal });
    // `toggle` does not bubble, so this listens on the details element itself, not on `this`.
    this.details.addEventListener('toggle', this.#handleToggle, { signal });
    mediaQueryLarge.addEventListener('change', this.#handleMediaQueryChange, { signal });
  }

  /**
   * Handles the disconnect event.
   */
  disconnectedCallback() {
    // Disconnect all the event listeners
    this.#controller.abort();
  }

  /**
   * Handles the click event.
   * @param {Event} event - The event.
   */
  handleClick = (event) => {
    const isMobile = isMobileBreakpoint();
    const isDesktop = !isMobile;

    // Stop default behaviour from the browser
    if ((isMobile && this.#disableOnMobile) || (isDesktop && this.#disableOnDesktop)) {
      event.preventDefault();
      return;
    }
  };

  /**
   * Handles the media query change event.
   */
  #handleMediaQueryChange = () => {
    this.#setDefaultOpenState();
  };

  /**
   * Sets the default open state of the accordion based on the `open-by-default-on-mobile` and `open-by-default-on-desktop` attributes.
   */
  #setDefaultOpenState() {
    // Something opened this row deliberately (the size-guide link, or a #fragment naming a row
    // inside it). This method runs on connect AND on every crossing of the 750px breakpoint, and
    // it assigns `open` unconditionally, so without this guard a deliberate open would be undone
    // by nothing more than an orientation change. The latch is released in #handleToggle the
    // moment the reader closes the row, which restores the merchant's default behaviour.
    //
    // Driven by an attribute rather than a method or a field on purpose: the attribute can be set
    // before this element upgrades, so a click that lands early still survives.
    if (this.hasAttribute('data-latched-open')) return;

    const isMobile = isMobileBreakpoint();

    this.details.open =
      (isMobile && this.hasAttribute('open-by-default-on-mobile')) ||
      (!isMobile && this.hasAttribute('open-by-default-on-desktop'));
  }

  /**
   * Releases the latch once the reader closes the row, so the merchant's open-by-default setting
   * takes over again from the next breakpoint change onwards.
   */
  #handleToggle = () => {
    if (!this.details.open) this.removeAttribute('data-latched-open');
  };

  /**
   * Honours a direct fragment load, e.g. /products/x#SizeChart shared or copied out of the
   * size-guide link's href.
   *
   * Needed because the native details-revealing algorithm cannot help here: it only opens a
   * <details> when the fragment targets something in its *content*, and our anchor sits on the
   * <summary>. Even where the target is content, the feature is Chromium-only. And whatever the
   * browser did, #setDefaultOpenState would slam the row shut a moment later on connect. So the
   * latch is set here, before that call, and the browser's own scroll to the summary still lands.
   */
  #latchFromFragment() {
    const hash = window.location.hash;
    if (hash.length < 2) return;

    let target = null;
    try {
      target = this.querySelector(`#${CSS.escape(decodeURIComponent(hash.slice(1)))}`);
    } catch {
      // A malformed percent-encoding in the fragment is not our problem to report.
      return;
    }

    if (!target) return;

    // Latch AND open. The latch only stops #setDefaultOpenState from closing the row; it does not
    // open anything, and the size-chart row ships open_by_default: false, so without this the
    // fragment would scroll to a row that is still shut.
    this.setAttribute('data-latched-open', '');
    this.details.open = true;
  }

  /**
   * Handles keydown events for the accordion
   *
   * @param {KeyboardEvent} event - The keyboard event.
   */
  #handleKeyDown(event) {
    // Close the accordion when used as a menu
    if (event.key === 'Escape' && this.#closeWithEscape) {
      event.preventDefault();

      this.details.open = false;
      this.summary.focus();
    }
  }
}

if (!customElements.get('accordion-custom')) {
  customElements.define('accordion-custom', AccordionCustom);
}
