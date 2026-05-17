import { Component } from '@theme/component';

/**
 * @typedef {object} ReturnPolicyAcknowledgmentRefs
 * @property {HTMLInputElement} checkbox
 * @property {HTMLElement} invalidMessage
 */

/**
 * Gates the product form on a required "final sale" acknowledgement checkbox.
 *
 * The standard Add to Cart submit is gated by the checkbox's HTML5 `required`
 * attribute (wired via the snippet). On submit attempts with the box unticked
 * the browser fires `invalid` on the checkbox; we set `setCustomValidity` to
 * the translated message and let the browser render its native bubble (same
 * UX as blocks/applique-pattern-select.liquid).
 *
 * Separately, this component sets `data-return-policy-pending` on its own
 * custom-element root. A `:has()` CSS rule in the block stylesheet uses that
 * attribute to hide the sibling accelerated-checkout container (Shop Pay /
 * Apple Pay / Google Pay) within the same section. The CSS rule is
 * fail-closed: anything other than `'false'` (including absent) keeps the
 * gate up.
 *
 * The sticky add-to-cart bar (assets/sticky-add-to-cart.js) puppet-clicks the
 * main form's submit button via .click() on a non-submit button. That path
 * fires the silent `invalid` event but the browser does not interactively
 * show the native bubble (it treats the bubble as a user-gesture-gated UI).
 * We intercept the sticky bar's click in capture phase: when the checkbox is
 * unchecked, cancel the puppet, scroll the checkbox into view, and call
 * reportValidity() to force the bubble.
 *
 * The `invalid` event does not bubble, so the framework's auto event delegation
 * cannot catch it; we attach the listener manually in connectedCallback.
 *
 * @extends Component<ReturnPolicyAcknowledgmentRefs>
 */
class ReturnPolicyAcknowledgmentComponent extends Component {
  requiredRefs = ['checkbox', 'invalidMessage'];

  /** @type {string} */
  #invalidMessage = '';

  /** @type {HTMLInputElement | null} */
  #checkbox = null;

  /** @type {((event: Event) => void) | null} */
  #boundHandleInvalid = null;

  /** @type {AbortController} */
  #abortController = new AbortController();

  connectedCallback() {
    super.connectedCallback();

    this.#checkbox = this.refs.checkbox;
    this.#invalidMessage = this.refs.invalidMessage.textContent?.trim() ?? '';
    this.#boundHandleInvalid = (event) => this.#handleInvalid(event);
    this.#checkbox.addEventListener('invalid', this.#boundHandleInvalid);

    this.#checkbox.setCustomValidity('');
    this.#syncGate();
    this.#wireStickyBarInterceptor();

    if (!this.#findProductForm()) {
      // The gate has no effect on non-product contexts (cart, custom pages,
      // etc.). Surface to anyone with devtools open so a misplaced block is
      // not a silent no-op.
      console.warn(
        '[return-policy-acknowledgment] No <product-form-component> in the same section. The accelerated-checkout gate will not apply.'
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
    this.#syncGate();
  }

  /** @param {Event} _event */
  #handleInvalid(_event) {
    // Do not preventDefault: the browser renders the native validation bubble
    // with the message we set via setCustomValidity. Matches applique-pattern-select.
    this.refs.checkbox.setCustomValidity(this.#invalidMessage);
  }

  /**
   * Wires a capture-phase click listener on the sticky bar's add-to-cart
   * button. When the gate is up, the listener prevents the puppet click,
   * scrolls the checkbox into view, and explicitly reports validity so the
   * user gets the same native bubble they'd get from the main form's submit.
   */
  #wireStickyBarInterceptor() {
    const section = this.closest('.shopify-section');
    if (!section) return;
    const stickyButton = /** @type {HTMLButtonElement | null} */ (
      section.querySelector('sticky-add-to-cart [ref="addToCartButton"]')
    );
    if (!stickyButton) return;

    stickyButton.addEventListener('click', this.#handleStickyClick, {
      capture: true,
      signal: this.#abortController.signal,
    });
  }

  /** @param {MouseEvent} event */
  #handleStickyClick = (event) => {
    if (this.refs.checkbox.checked) return;

    // Stop the sticky bar's handleAddToCartClick from puppet-clicking the
    // main form's submit button; that path can't show the validation bubble.
    event.preventDefault();
    event.stopImmediatePropagation();

    // Set the custom validity message before reportValidity so the bubble
    // shows our translated string instead of the browser default.
    this.refs.checkbox.setCustomValidity(this.#invalidMessage);

    const rect = this.refs.checkbox.getBoundingClientRect();
    const offscreen = rect.bottom < 0 || rect.top > window.innerHeight;
    if (offscreen) {
      this.refs.checkbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Defer reportValidity until the smooth scroll settles so the bubble
      // anchors to the input at its final viewport position.
      setTimeout(() => this.refs.checkbox.reportValidity(), 400);
    } else {
      this.refs.checkbox.reportValidity();
    }
  };

  #syncGate() {
    this.dataset.returnPolicyPending = this.refs.checkbox.checked ? 'false' : 'true';
  }

  /**
   * Locate the product-form-component within the same section, for diagnostic
   * use only. The gate itself is enforced by a `:has()` CSS rule scoped to the
   * containing `.shopify-section`, so the JS doesn't need to walk to the form.
   *
   * @returns {HTMLElement | null}
   */
  #findProductForm() {
    const root = this.closest('.shopify-section') ?? document;
    return /** @type {HTMLElement | null} */ (root.querySelector('product-form-component'));
  }
}

if (!customElements.get('return-policy-acknowledgment-component')) {
  customElements.define('return-policy-acknowledgment-component', ReturnPolicyAcknowledgmentComponent);
}
