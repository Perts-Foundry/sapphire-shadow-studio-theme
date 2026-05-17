import { Component } from '@theme/component';

/**
 * @typedef {object} ReturnPolicyAcknowledgmentRefs
 * @property {HTMLInputElement} checkbox
 * @property {HTMLElement} error
 */

/**
 * Gates the product form on a required "final sale" acknowledgement checkbox.
 *
 * The standard Add to Cart submit is gated by the checkbox's HTML5 `required`
 * attribute (wired via the snippet). This component layers on top by:
 *   1. Setting `data-return-policy-pending` on its own custom-element root.
 *      A `:has()` CSS rule in the block stylesheet uses that attribute to
 *      hide the sibling accelerated-checkout container (Shop Pay / Apple Pay
 *      / Google Pay) within the same section. The CSS rule is fail-closed:
 *      anything other than `'false'` (including absent) keeps the gate up.
 *   2. Surfacing the validation message inline via the `error` ref instead of
 *      relying solely on the browser's invalid bubble.
 *
 * The `invalid` event does not bubble, so the framework's auto event delegation
 * cannot catch it; we attach the listener manually in connectedCallback.
 *
 * @extends Component<ReturnPolicyAcknowledgmentRefs>
 */
class ReturnPolicyAcknowledgmentComponent extends Component {
  requiredRefs = ['checkbox', 'error'];

  /** @type {string} */
  #invalidMessage = '';

  /** @type {HTMLInputElement | null} */
  #checkbox = null;

  /** @type {((event: Event) => void) | null} */
  #boundHandleInvalid = null;

  connectedCallback() {
    super.connectedCallback();

    this.#checkbox = this.refs.checkbox;
    this.#invalidMessage = this.refs.error.textContent?.trim() ?? '';
    this.#boundHandleInvalid = (event) => this.#handleInvalid(event);
    this.#checkbox.addEventListener('invalid', this.#boundHandleInvalid);

    this.#checkbox.setCustomValidity('');
    this.refs.error.hidden = true;
    this.#syncGate();

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
  }

  handleChange() {
    this.refs.checkbox.setCustomValidity('');
    this.refs.error.hidden = true;
    this.#syncGate();
  }

  /** @param {Event} event */
  #handleInvalid(event) {
    event.preventDefault();
    this.refs.checkbox.setCustomValidity(this.#invalidMessage);
    this.refs.error.hidden = false;
  }

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
