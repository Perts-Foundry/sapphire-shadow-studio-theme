import { DialogComponent } from '@theme/dialog';

/**
 * sessionStorage key marking the vacation popup as already shown this
 * browsing session. Namespaced per the repo convention (feature:thing).
 */
const SEEN_KEY = 'vacation-popup:seen';

/**
 * Auto-opens the vacation-mode dialog once per browsing session.
 *
 * Extends DialogComponent, so open/close mechanics (native showModal focus
 * trap, Esc, outside click, scroll lock, close-button `on:click="/closeDialog"`)
 * are inherited; this class only decides whether to auto-open on connect.
 *
 * Marked seen at open time, not close time, so navigating away mid-dialog
 * still counts as having seen it.
 *
 * @extends DialogComponent
 */
class VacationPopupComponent extends DialogComponent {
  connectedCallback() {
    super.connectedCallback();

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
