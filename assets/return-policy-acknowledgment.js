import { Component } from '@theme/component';
import { ThemeEvents } from '@theme/events';

/**
 * @typedef {object} ReturnPolicyAcknowledgmentRefs
 * @property {HTMLInputElement} checkbox
 * @property {HTMLElement} invalidMessage
 * @property {HTMLElement} clearedMessage
 * @property {HTMLElement} valueTemplate
 * @property {HTMLElement} valueTemplateNoSize
 * @property {HTMLElement} errorMessage
 * @property {HTMLElement} statusMessage
 */

/**
 * Gates the product form on a required "final sale" acknowledgement checkbox.
 *
 * The standard Add to Cart submit is gated by the checkbox's HTML5 `required` attribute (wired
 * via the snippet). On submit attempts with the box unticked the browser fires `invalid` on the
 * checkbox; we render our own visible, translated message and mark the field `aria-invalid`,
 * then let the browser also draw its native bubble. The bubble is deliberately not the only
 * mechanism: native bubbles auto-dismiss, vanish on scroll or blur, cannot be restyled or
 * magnified, and expose no programmatic association, so on their own they do not satisfy
 * WCAG 3.3.1.
 *
 * Separately, this component sets `data-return-policy-pending` on its own custom-element root.
 * A `:has()` CSS rule in the block stylesheet uses that attribute to hide the sibling
 * accelerated-checkout container (Shop Pay / Apple Pay / Google Pay) within the same section.
 * The CSS rule is fail-closed: anything other than `'false'` (including absent) keeps the gate
 * up.
 *
 * The sticky add-to-cart bar (assets/sticky-add-to-cart.js) puppet-clicks the main form's submit
 * button via .click() on a non-submit button. That path fires the silent `invalid` event but the
 * browser does not interactively show the native bubble (it treats the bubble as a
 * user-gesture-gated UI). We intercept the sticky bar's click in capture phase: if any field in
 * the main form is invalid (the ack checkbox, the applique pattern selector, or any future
 * required field), cancel the puppet, scroll the first invalid field into view, and call
 * form.reportValidity() to force the bubble. The scope deliberately reaches across blocks: any
 * product page that uses the sticky bar should give the same feedback for any required field.
 *
 * The `invalid` event does not bubble, so the framework's auto event delegation cannot catch it;
 * we attach the listener manually in connectedCallback.
 *
 * @extends Component<ReturnPolicyAcknowledgmentRefs>
 */
class ReturnPolicyAcknowledgmentComponent extends Component {
  requiredRefs = ['checkbox', 'invalidMessage', 'clearedMessage', 'errorMessage', 'statusMessage'];

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
    this.#wireVariantListener();

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
    this.#clearError();
    this.#syncGate();
  }

  /** @param {Event} _event */
  #handleInvalid(_event) {
    // Do not preventDefault: the browser also renders its native validation bubble with the
    // message we set via setCustomValidity. That bubble is the bonus; #showError is the
    // mechanism a screen reader and a magnifier user actually get.
    this.refs.checkbox.setCustomValidity(this.#invalidMessage);
    this.#showError(this.#invalidMessage);
  }

  /**
   * Renders the validation message as persistent visible text and wires it to the checkbox.
   *
   * The error id joins `aria-describedby` rather than using `aria-errormessage` alone:
   * describedby is universally supported, and appending is why the snippet's `describedBy`
   * param takes a token list. `aria-invalid` is what tells AT the field is in an error state.
   *
   * @param {string} message
   */
  #showError(message) {
    const { checkbox, errorMessage } = this.refs;
    errorMessage.textContent = message;
    errorMessage.hidden = false;
    checkbox.setAttribute('aria-invalid', 'true');

    const errorId = errorMessage.id;
    if (errorId && !this.#baseDescribedBy.split(/\s+/).includes(errorId)) {
      const described = this.#baseDescribedBy ? `${this.#baseDescribedBy} ${errorId}` : errorId;
      checkbox.setAttribute('aria-describedby', described);
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
   * Listens for variant changes on the enclosing product-information section.
   *
   * The ancestor IS the section filter: `ProductInformation-{section.id}` contains exactly one
   * <variant-picker>, so quick-add and recommendation pickers in other sections never reach us.
   * `event.detail.sourceId` is the selected option's id, not a section id, so there is nothing
   * else to filter on. The productId guard is belt-and-braces for combined listings, matching
   * assets/product-sku.js.
   */
  #wireVariantListener() {
    const scope = this.closest('[id^="ProductInformation-"]');

    if (!scope) {
      // Loud on purpose. Degrading quietly here would leave the checkbox ticked across an
      // option change and record a size the shopper never confirmed, which is precisely the
      // thing this component exists to prevent. A warning is recoverable; wrong evidence is not.
      console.error(
        '[return-policy-acknowledgment] No [id^="ProductInformation-"] ancestor. Option changes will not clear the acknowledgement, so the recorded size may not match what the shopper agreed to.'
      );
      return;
    }

    scope.addEventListener(ThemeEvents.variantUpdate, this.#handleVariantUpdate, {
      signal: this.#abortController.signal,
    });
  }

  /**
   * Clears the acknowledgement whenever the shopper changes any option, and re-points the
   * recorded value at the newly selected size.
   *
   * Unticking is what makes the line-item property honest: the box can only ever be ticked for
   * the variant currently on screen, so the value that submits is always the one the shopper
   * actually agreed to. (An unchecked checkbox submits nothing at all, so the value is only ever
   * recorded when ticked.)
   *
   * @param {Event} event
   */
  #handleVariantUpdate = (event) => {
    const detail = /** @type {any} */ (event).detail;

    // Product-scope guard, mirroring assets/product-form.js#561-562. A combined listing swaps
    // the product under us, so adopt the new id rather than ignoring its variant events;
    // otherwise ignore anything belonging to a different product.
    if (detail?.data?.newProduct) {
      this.dataset.productId = detail.data.newProduct.id;
    } else if (detail?.data?.productId !== this.dataset.productId) {
      return;
    }

    // The variant lives on `resource`. The `detail.variant` shown in the doc comment at
    // assets/events.js is stale: VariantUpdateEvent has always assigned `resource`, and every
    // other consumer in the theme (product-form, local-pickup, product-card) reads it.
    const variant = detail?.resource ?? null;

    this.#updateValue(variant);

    // Only announce when something was actually cleared. Announcing on every option change
    // would be noise, and the live region would say "cleared" when nothing was.
    const wasChecked = this.refs.checkbox.checked;
    if (!wasChecked) return;

    this.refs.checkbox.checked = false;
    this.refs.checkbox.setCustomValidity('');
    this.#clearError();
    this.#syncGate();
    this.#announce(this.refs.clearedMessage.textContent?.trim() ?? '');
  };

  /**
   * Re-points the checkbox value at the selected size. Falls back to the size-less string when
   * the size option cannot be resolved (no Size option, a renamed option, or an unavailable
   * combination, where `resource` is null).
   *
   * @param {any} variant
   */
  #updateValue(variant) {
    const position = Number(this.dataset.sizeOptionPosition);
    const size =
      variant && Number.isInteger(position) && position > 0
        ? (variant.options?.[position - 1] ?? variant[`option${position}`] ?? null)
        : null;

    if (size) {
      const template = this.refs.valueTemplate?.textContent?.trim() ?? '';
      this.refs.checkbox.value = template.replace('[size]', size);
    } else {
      this.refs.checkbox.value = this.refs.valueTemplateNoSize?.textContent?.trim() ?? '';
    }
  }

  /**
   * Pushes a message into the polite live region. Cleared first so an identical consecutive
   * message still announces (screen readers ignore a mutation that yields the same text).
   *
   * @param {string} message
   */
  #announce(message) {
    const region = this.refs.statusMessage;
    region.textContent = '';
    requestAnimationFrame(() => {
      region.textContent = message;
    });
  }

  /**
   * Wires a window-level capture-phase click listener that intercepts the
   * sticky bar's add-to-cart button. Window is above document in the
   * capture chain, so this listener runs BEFORE the framework's
   * document-level delegation listener for `on:click="/handleAddToCartClick"`
   * (assets/component.js#registerEventListeners). When the form is invalid,
   * stopImmediatePropagation prevents handleAddToCartClick from ever
   * running, which avoids the spurious "added" burst animation and the
   * fly-to-cart element that handleAddToCartClick would otherwise append
   * unconditionally on click (assets/sticky-add-to-cart.js#handleAddToCartClick).
   * Without that ordering, the animation runs even when the cart-add was
   * blocked, leading users to believe the item was added when it wasn't.
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
    this.dataset.returnPolicyPending = this.refs.checkbox.checked ? 'false' : 'true';
  }

  /**
   * Locate the product-form-component within the same section. Two consumers:
   *   1. Diagnostic warning in connectedCallback if the block was placed
   *      outside a product context.
   *   2. The sticky-bar interceptor (#handleAnyClick), which needs the form
   *      element to call form.checkValidity() / form.reportValidity().
   * The accelerated-checkout CSS gate itself does not depend on this lookup
   * (it's enforced by a `:has()` rule on the containing `.shopify-section`).
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
