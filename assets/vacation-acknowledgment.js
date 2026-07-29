import { Component } from '@theme/component';

/**
 * @typedef {object} VacationAcknowledgmentRefs
 * @property {HTMLInputElement} checkbox
 * @property {HTMLElement} invalidMessage
 * @property {HTMLElement} errorMessage
 */

/**
 * Gates the product form on a required vacation-delay acknowledgment checkbox.
 *
 * A trimmed clone of assets/return-policy-acknowledgment.js (see that file for
 * the full rationale on native-bubble limitations and the sticky-bar puppet
 * click). Differences: no variant-change untick (the delay is variant-agnostic)
 * and the gate attribute is `data-vacation-pending`, so the CSS rule in
 * blocks/vacation-acknowledgment.liquid composes independently with the
 * return-policy gate on the same accelerated-checkout container.
 *
 * The standard Add to Cart submit is gated by the checkbox's HTML5 `required`
 * attribute. On submit attempts with the box unticked the browser fires
 * `invalid` on the checkbox; we render our own visible, translated message and
 * mark the field `aria-invalid`, then let the browser also draw its native
 * bubble (WCAG 3.3.1: the bubble alone is not sufficient).
 *
 * The sticky add-to-cart bar puppet-clicks the main form's submit button, a
 * path that fires the silent `invalid` event without an interactive bubble.
 * We intercept that click in capture phase, scroll the first invalid field
 * into view, and call form.reportValidity(). This interceptor must exist here
 * even though return-policy-acknowledgment provides an identical one: some
 * templates (shift-fuel) carry only this block. When both blocks are present
 * the double interception is benign; both call whole-form reportValidity().
 *
 * The `invalid` event does not bubble, so the framework's auto event
 * delegation cannot catch it; we attach the listener manually.
 *
 * @extends Component<VacationAcknowledgmentRefs>
 */
class VacationAcknowledgmentComponent extends Component {
  requiredRefs = ['checkbox', 'invalidMessage', 'errorMessage'];

  /** @type {string} */
  #invalidMessage = '';

  /** @type {HTMLInputElement | null} */
  #checkbox = null;

  /** @type {((event: Event) => void) | null} */
  #boundHandleInvalid = null;

  /** @type {string} */
  #baseDescribedBy = '';

  /** @type {AbortController} */
  #abortController = new AbortController();

  connectedCallback() {
    super.connectedCallback();

    // Re-initialise the abort controller in case this element is being
    // re-connected after a previous disconnect aborted the prior one
    // (theme editor section reload, framework re-mount, etc.). Without
    // this, a stale aborted signal would silently make the new sticky-bar
    // interceptor a no-op.
    if (this.#abortController.signal.aborted) {
      this.#abortController = new AbortController();
    }

    this.#checkbox = this.refs.checkbox;
    this.#invalidMessage = this.refs.invalidMessage.textContent?.trim() ?? '';
    this.#baseDescribedBy = this.#checkbox.getAttribute('aria-describedby') ?? '';
    this.#boundHandleInvalid = (event) => this.#handleInvalid(event);
    this.#checkbox.addEventListener('invalid', this.#boundHandleInvalid);

    this.#checkbox.setCustomValidity('');
    this.#clearError();
    this.#syncGate();
    this.#wireStickyBarInterceptor();

    if (!this.#findProductForm()) {
      // The gate has no effect on non-product contexts. Surface to anyone
      // with devtools open so a misplaced block is not a silent no-op.
      console.warn(
        '[vacation-acknowledgment] No <product-form-component> in the same section. The accelerated-checkout gate will not apply.'
      );
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    if (this.#boundHandleInvalid && this.#checkbox) {
      this.#checkbox.removeEventListener('invalid', this.#boundHandleInvalid);
    }
    this.#boundHandleInvalid = null;
    this.#checkbox = null;
    this.#abortController.abort();
  }

  handleChange() {
    this.refs.checkbox.setCustomValidity('');
    this.#clearError();
    this.#syncGate();
  }

  /** @param {Event} _event */
  #handleInvalid(_event) {
    // Do not preventDefault: the browser also renders its native validation
    // bubble with the message set via setCustomValidity. The bubble is the
    // bonus; #showError is the mechanism a screen reader and a magnifier
    // user actually get.
    this.refs.checkbox.setCustomValidity(this.#invalidMessage);
    this.#showError(this.#invalidMessage);
  }

  /**
   * Renders the validation message as persistent visible text and wires it to
   * the checkbox. The error id joins `aria-describedby` rather than using
   * `aria-errormessage` alone (thinner support); `aria-invalid` is what tells
   * AT the field is in an error state.
   *
   * @param {string} message
   */
  #showError(message) {
    const { checkbox, errorMessage } = this.refs;
    errorMessage.textContent = message;
    errorMessage.hidden = false;
    checkbox.setAttribute('aria-invalid', 'true');

    // #baseDescribedBy is captured once from the server-rendered attribute and
    // never mutated, so it holds the terms id and nothing else. setAttribute
    // is idempotent, so a repeat call is harmless.
    const errorId = errorMessage.id;
    if (errorId) {
      checkbox.setAttribute(
        'aria-describedby',
        this.#baseDescribedBy ? `${this.#baseDescribedBy} ${errorId}` : errorId
      );
    }
  }

  #clearError() {
    const { checkbox, errorMessage } = this.refs;
    errorMessage.textContent = '';
    errorMessage.hidden = true;
    checkbox.removeAttribute('aria-invalid');

    if (this.#baseDescribedBy) {
      checkbox.setAttribute('aria-describedby', this.#baseDescribedBy);
    } else {
      checkbox.removeAttribute('aria-describedby');
    }
  }

  /**
   * Wires a window-level capture-phase click listener that intercepts the
   * sticky bar's add-to-cart button. Window is above document in the capture
   * chain, so this runs BEFORE the framework's document-level delegation for
   * `on:click="/handleAddToCartClick"`. When the form is invalid,
   * stopImmediatePropagation prevents the sticky bar's "added" burst
   * animation from running on a blocked add.
   */
  #wireStickyBarInterceptor() {
    window.addEventListener('click', this.#handleAnyClick, {
      capture: true,
      signal: this.#abortController.signal,
    });
  }

  /** @param {MouseEvent} event */
  #handleAnyClick = (event) => {
    const eventTarget = /** @type {Element | null} */ (event.composedPath()[0] ?? null);
    if (!(eventTarget instanceof Element)) return;

    // Match the sticky bar's add-to-cart button. Walk up to ensure the click
    // originated inside it (the button has child SVGs / spans that catch the
    // click target).
    const stickyAtcButton = eventTarget.closest('sticky-add-to-cart [ref="addToCartButton"]');
    if (!stickyAtcButton) return;

    // Only act on the sticky bar within MY section; ignore other product
    // forms (recommendations, quick-add modal, etc.).
    if (stickyAtcButton.closest('.shopify-section') !== this.closest('.shopify-section')) return;

    const form = this.#findProductForm()?.querySelector('form');
    // checkValidity fires `invalid` on each invalid field, which lets each
    // field's own handler set its custom validity message before we report.
    if (!form || form.checkValidity()) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const firstInvalid = /** @type {HTMLElement | null} */ (form.querySelector(':invalid'));
    const target = firstInvalid ?? this.refs.checkbox;
    const rect = target.getBoundingClientRect();
    const offscreen = rect.bottom < 0 || rect.top > window.innerHeight;
    if (offscreen) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Defer reportValidity until the smooth scroll settles so the bubble
      // anchors to the field at its final viewport position.
      setTimeout(() => form.reportValidity(), 400);
    } else {
      form.reportValidity();
    }
  };

  #syncGate() {
    this.dataset.vacationPending = this.refs.checkbox.checked ? 'false' : 'true';
  }

  /**
   * Locate the product-form-component within the same section. Two consumers:
   * the diagnostic warning in connectedCallback, and the sticky-bar
   * interceptor, which needs the form element for checkValidity() /
   * reportValidity(). The accelerated-checkout CSS gate itself does not
   * depend on this lookup.
   *
   * @returns {HTMLElement | null}
   */
  #findProductForm() {
    const root = this.closest('.shopify-section') ?? document;
    return /** @type {HTMLElement | null} */ (root.querySelector('product-form-component'));
  }
}

if (!customElements.get('vacation-acknowledgment-component')) {
  customElements.define('vacation-acknowledgment-component', VacationAcknowledgmentComponent);
}
