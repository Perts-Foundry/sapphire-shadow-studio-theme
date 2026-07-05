import { DialogComponent } from '@theme/dialog';

/**
 * sessionStorage key for the submit snapshot. Namespaced per the repo
 * convention (cf. assets/theme-editor.js editor-state keys).
 */
const SNAPSHOT_KEY = 'request-combination:snapshot';

/**
 * Fixed English tokens posted in the hidden contact[Availability] field.
 * Deliberately NOT translated: the merchant's inbox data must not vary with
 * the customer's storefront locale. Only the visible status line (passed in
 * via data-status-* attributes) is translated.
 */
const AVAILABILITY_TOKENS = {
  available: 'Available',
  'sold-out': 'Sold out',
  'not-offered': 'Not offered',
  unknown: 'Not verified',
};

/**
 * @typedef {object} RequestCombinationRefs
 * @property {HTMLDialogElement} dialog - The request dialog.
 * @property {HTMLElement} statusLine - Visible availability status line.
 * @property {HTMLInputElement} availabilityField - Hidden contact[Availability] input.
 * @property {HTMLScriptElement} variantData - JSON script with the reduced variant map.
 * @property {HTMLSelectElement[]} optionSelects - One select per product option.
 * @property {HTMLElement} [closeButton] - Dialog close button.
 * @property {HTMLElement} [successSummary] - Rendered only after a successful post.
 * @property {HTMLElement} [errorSummary] - Rendered only after a failed post.
 */

/**
 * @typedef {object} RequestSnapshot
 * @property {string} productId
 * @property {string[]} values - Selected option values, in option-position order.
 */

/**
 * Modal form that lets customers request a sold-out or never-created variant
 * combination. Transport is Shopify's native contact form (full-page POST to
 * /contact guarded by Shopify's spam protection); this component only handles
 * the dialog, prefill, the live availability status, and restoring state
 * after the redirect round trip.
 *
 * The submit snapshot persisted to sessionStorage carries ONLY
 * {productId, values}. Never add the email or note to it: both round-trip
 * server-side via form.email / form.body on the error re-render, and keeping
 * PII out of client-side storage is a deliberate property of this design.
 *
 * The variant map is parsed lazily (and re-parsed when the script content
 * changes) rather than in connectedCallback: a combined-listing product swap
 * morphs this element in place without re-running connectedCallback, which
 * would otherwise leave a stale map behind.
 */
class RequestCombinationComponent extends DialogComponent {
  requiredRefs = ['dialog', 'statusLine', 'availabilityField', 'variantData', 'optionSelects'];

  /** @type {{ options: string[], available: boolean }[] | null} */
  #variantMap = null;

  /** @type {string | null} */
  #variantMapSource = null;

  connectedCallback() {
    super.connectedCallback();

    const summary = this.refs.successSummary ?? this.refs.errorSummary;
    if (!summary) return;

    // Auto-open is gated on a matching snapshot so that posted state shared
    // with any other contact form on the page cannot pop this dialog. A
    // mismatched snapshot is left in place on purpose: a matching instance
    // elsewhere on the page (e.g. a featured-product section) may still need
    // it, and an unconsumed snapshot is cosmetic at worst.
    const snapshot = this.#readSnapshot();
    if (!snapshot || snapshot.productId !== this.dataset.productId) return;

    // Restore the requested combination on both paths: on error so the
    // customer can correct and resubmit, on success so the reopened dialog
    // shows the combination that was actually requested.
    this.#setSelectValues(snapshot.values);
    this.#updateStatus();

    // Clear on both success and error paths so a later, unrelated round trip
    // cannot restore a stale combination.
    this.#clearSnapshot();

    requestAnimationFrame(() => this.showDialog());
  }

  /**
   * Opens the dialog, first syncing the selects with the page's variant
   * picker so the form reflects the customer's current selection.
   */
  handleOpen() {
    this.#syncFromPagePicker();
    this.#updateStatus();
    this.showDialog();
  }

  /**
   * Recomputes the status line when any option select changes.
   */
  handleOptionChange() {
    this.#updateStatus();
  }

  /**
   * Records the snapshot used to restore selects and gate auto-open after
   * the full-page POST round trip. Never preventDefault here: the native
   * submission to /contact must proceed.
   */
  handleSubmit() {
    try {
      /** @type {RequestSnapshot} */
      const snapshot = {
        productId: this.dataset.productId ?? '',
        values: this.#selectedValues(),
      };
      sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch {
      // sessionStorage unavailable (privacy mode); the post still works,
      // only the auto-reopen after redirect is skipped.
    }
  }

  /**
   * Reads the current selection from the page's variant picker and mirrors
   * it into the dialog selects. The query mirrors the selector that
   * assets/variant-picker.js uses internally for its own selected-option
   * reads ('select option[selected], fieldset input:checked'), but reads
   * display values rather than option-value ids; if the variant picker
   * markup changes shape, update both call sites together. Scoped to this
   * section and product so quick-add pickers for other products are never
   * read. Fails soft: on any mismatch the server-rendered selection stands.
   */
  #syncFromPagePicker() {
    const productId = this.dataset.productId ?? '';
    const picker = this.closest('.shopify-section')?.querySelector(
      `variant-picker[data-product-id="${CSS.escape(productId)}"]`
    );
    if (!picker) return;

    const selected = picker.querySelectorAll('select option[selected], fieldset input:checked');
    const values = Array.from(selected, (element) => /** @type {HTMLInputElement} */ (element).value);
    this.#setSelectValues(values);
  }

  /**
   * Applies values to the option selects in position order. Guarded: applies
   * nothing on length mismatch and skips values missing from a select's
   * options, so callers fail soft to the current selection.
   *
   * @param {unknown} values
   */
  #setSelectValues(values) {
    const selects = this.refs.optionSelects;
    if (!Array.isArray(values) || values.length !== selects.length) return;

    selects.forEach((select, index) => {
      const value = values[index];
      if (typeof value !== 'string') return;
      const match = Array.from(select.options).some((option) => option.value === value);
      if (match) select.value = value;
    });
  }

  /**
   * @returns {string[]} Selected option values in option-position order.
   */
  #selectedValues() {
    return this.refs.optionSelects.map((select) => select.value);
  }

  /**
   * Parses the embedded variant map, cached against the script content so a
   * morphed-in product swap invalidates the cache. Fails closed to null.
   *
   * @returns {{ options: string[], available: boolean }[] | null}
   */
  #getVariantMap() {
    const source = this.refs.variantData.textContent ?? '';
    if (this.#variantMapSource === source) return this.#variantMap;

    this.#variantMapSource = source;
    try {
      const parsed = JSON.parse(source);
      this.#variantMap = Array.isArray(parsed) ? parsed : null;
    } catch {
      this.#variantMap = null;
    }
    return this.#variantMap;
  }

  /**
   * Matches the current selection against the variant map and updates the
   * visible status line plus the hidden availability field. Unknown (map
   * missing or unparsable) keeps the honest "Not verified" token and hides
   * the status line rather than guessing.
   */
  #updateStatus() {
    const { statusLine, availabilityField } = this.refs;
    const map = this.#getVariantMap();

    /** @type {keyof typeof AVAILABILITY_TOKENS} */
    let status = 'unknown';

    if (map) {
      const values = this.#selectedValues();
      const match = map.find(
        (variant) =>
          Array.isArray(variant.options) &&
          variant.options.length === values.length &&
          variant.options.every((option, index) => option === values[index])
      );
      status = match ? (match.available ? 'available' : 'sold-out') : 'not-offered';
    }

    availabilityField.value = AVAILABILITY_TOKENS[status];
    statusLine.hidden = status === 'unknown';
    if (status !== 'unknown') {
      const text = {
        available: this.dataset.statusAvailable,
        'sold-out': this.dataset.statusSoldOut,
        'not-offered': this.dataset.statusNotOffered,
      }[status];
      statusLine.textContent = text ?? '';
    }
  }

  /**
   * @returns {RequestSnapshot | null}
   */
  #readSnapshot() {
    try {
      const raw = sessionStorage.getItem(SNAPSHOT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      return /** @type {RequestSnapshot} */ (parsed);
    } catch {
      return null;
    }
  }

  #clearSnapshot() {
    try {
      sessionStorage.removeItem(SNAPSHOT_KEY);
    } catch {
      // Ignore: storage unavailable means nothing was persisted either.
    }
  }
}

if (!customElements.get('request-combination-component')) {
  customElements.define('request-combination-component', RequestCombinationComponent);
}
