import { Component } from '@theme/component';
import { scrollIntoView } from '@theme/scrolling';
import { prefersReducedMotion } from '@theme/utilities';

/**
 * Opens and scrolls to the Size Chart accordion row from a link beside the size selector.
 *
 * The chart otherwise lives in a closed accordion below the buy buttons, which is the wrong place
 * for it: the size decision happens at the variant picker, and an acknowledgement that asks a
 * shopper to confirm they checked the chart is hollow if they cannot find it from the buy button.
 *
 * The link is a real `<a href="#SizeChart">`, so it survives with JS off, can be copied, and reads
 * as a link to assistive tech. This component only upgrades it:
 *
 *   - Opens the target's <details> before scrolling, so the scroll measures the row at its final
 *     height rather than its collapsed one. Order is load-bearing: open, scroll, then focus.
 *   - Latches the row open. Without `data-latched-open`, AccordionCustom#setDefaultOpenState would
 *     reassert `open_by_default: false` on the next crossing of the 750px breakpoint and shut the
 *     row the shopper just opened. See assets/accordion-custom.js.
 *   - Moves focus to the <summary>, which is the anchor target, is natively focusable, and is
 *     announced with its expanded state. Keyboard users land on the control rather than being
 *     scrolled somewhere their focus is not.
 *
 * @extends Component<{}>
 */
class SizeGuideLink extends Component {
  connectedCallback() {
    super.connectedCallback();

    // A product can have a size option but no generated size chart, in which case the anchor does
    // not exist on this page. Leaving the link visible would give the shopper a control that looks
    // real and does nothing, because handleClick deliberately declines to hijack a missing target.
    // Remove it instead. Server-rendered rather than hidden-by-default so the no-JS case still
    // shows the link wherever the chart genuinely exists.
    if (!this.#target()) this.remove();
  }

  /**
   * @param {MouseEvent} event
   */
  handleClick(event) {
    // Let the browser do its normal thing for modified clicks: new tab, new window, download.
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.button !== 0) return;

    const target = this.#target();

    // No target: do not preventDefault. Falling through to native behaviour on a broken anchor is
    // a no-op, which is strictly better than swallowing the click and pretending to act.
    if (!target) return;

    const accordion = target.closest('accordion-custom');
    if (!accordion) return;

    event.preventDefault();

    accordion.setAttribute('data-latched-open', '');
    const details = accordion.querySelector('details');
    if (details) details.open = true;

    scrollIntoView(details ?? target, {
      behavior: prefersReducedMotion() ? 'instant' : 'smooth',
      block: 'start',
    });

    // preventScroll so focus does not fight the smooth scroll it was just handed.
    /** @type {HTMLElement} */ (target).focus({ preventScroll: true });
  }

  /**
   * Resolves the anchor named by the link's own href, so the markup stays the single source of
   * the target's name.
   *
   * @returns {HTMLElement | null}
   */
  #target() {
    const link = this.querySelector('a[href^="#"]');
    if (!(link instanceof HTMLAnchorElement)) return null;

    const id = decodeURIComponent(link.hash.slice(1));
    if (!id) return null;

    return /** @type {HTMLElement | null} */ (document.getElementById(id));
  }
}

if (!customElements.get('size-guide-link')) {
  customElements.define('size-guide-link', SizeGuideLink);
}
