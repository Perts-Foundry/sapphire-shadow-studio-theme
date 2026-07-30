import { DialogComponent } from '@theme/dialog';
import { isClickedOutside } from '@theme/utilities';

/**
 * sessionStorage key marking the vacation popup as already shown this
 * browsing session. Namespaced per the repo convention (feature:thing).
 */
const SEEN_KEY = 'vacation-popup:seen';

/**
 * Auto-opens the vacation-mode dialog once per browsing session.
 *
 * Extends DialogComponent, so open/close mechanics (native showModal focus
 * trap, Esc, scroll lock, close-button `on:click="/closeDialog"`) are
 * inherited; this class decides whether to auto-open on connect and disables
 * the inherited light dismiss: a backdrop click must not close the popup, so
 * the only ways out are the dismiss button, the X, and Esc (Esc stays per the
 * modal pattern in docs/accessibility-patterns.md).
 *
 * Marked seen at open time, not close time, so navigating away mid-dialog
 * still counts as having seen it.
 *
 * @extends DialogComponent
 */
class VacationPopupComponent extends DialogComponent {
  connectedCallback() {
    super.connectedCallback();

    // DialogComponent closes on any click outside the dialog box via a
    // bubble-phase listener it attaches while open. Its handler is private,
    // so it cannot be unregistered here; instead this capture-phase guard
    // sees the backdrop click first (the backdrop's event target is the
    // <dialog> itself, a descendant) and stops it from ever reaching that
    // listener. Clicks inside the dialog are untouched.
    this.addEventListener(
      'click',
      (event) => {
        if (this.refs.dialog?.open && isClickedOutside(event, this.refs.dialog)) {
          event.stopPropagation();
        }
      },
      { capture: true }
    );

    // Never auto-open inside the theme editor: every section re-render
    // reconnects the element, which would pop the dialog on each edit.
    if (window.Shopify?.designMode) return;
    if (this.#hasBeenSeen()) return;

    requestAnimationFrame(() => {
      this.showDialog();
      this.#markSeen();
    });
  }

  /**
   * Whether the popup has already shown this session. Fails closed: if
   * sessionStorage is unavailable (privacy mode), report "seen" so the
   * shopper gets no popup rather than a popup on every page.
   *
   * @returns {boolean}
   */
  #hasBeenSeen() {
    try {
      return sessionStorage.getItem(SEEN_KEY) === 'true';
    } catch {
      return true;
    }
  }

  #markSeen() {
    try {
      sessionStorage.setItem(SEEN_KEY, 'true');
    } catch {
      // sessionStorage unavailable; #hasBeenSeen already fails closed.
    }
  }
}

if (!customElements.get('vacation-popup-component')) {
  customElements.define('vacation-popup-component', VacationPopupComponent);
}
