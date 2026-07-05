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
  'not-applicable': 'Not applicable',
  unknown: 'Not verified',
};

/**
 * @typedef {object} RequestCombinationRefs
 * @property {HTMLDialogElement} dialog - The request dialog.
 * @property {HTMLElement} statusLine - Visible availability status line.
 * @property {HTMLInputElement} availabilityField - Hidden contact[Availability] input.
 * @property {HTMLScriptElement} variantData - JSON script with the reduced variant map.
 * @property {HTMLSelectElement[]} optionSelects - One select per product option.
 * @property {HTMLInputElement[]} pathRadios - The request-type radios (2 or 3).
 * @property {HTMLElement} requestFields - Wrapper around the on-page request form.
 * @property {HTMLInputElement} emailField - Email input.
 * @property {HTMLElement} stockFields - Wrapper around the option selects + status line.
 * @property {HTMLTextAreaElement} noteField - Shared note/description textarea.
 * @property {HTMLElement} noteLabelText - Text span of the note/description label.
 * @property {HTMLElement} noteRequiredMark - Required marker, shown on the different path.
 * @property {HTMLElement} [customFields] - Custom-order handoff block; rendered only when the custom-orders page exists.
 * @property {HTMLElement} [closeButton] - Dialog close button.
 * @property {HTMLElement} [successSummary] - Rendered only after a successful post.
 * @property {HTMLElement} [errorSummary] - Rendered only after a failed post.
 */

/**
 * @typedef {'stock' | 'different' | 'custom'} RequestPath
 */

/**
 * @typedef {object} RequestSnapshot
 * @property {string} productId
 * @property {RequestPath} path - Which request path was selected at submit time.
 * @property {string[]} values - Selected option values, in option-position order.
 */

/**
 * Modal form that lets customers request either a sold-out / never-created
 * variant combination (the "stock" path, with a live availability status) or
 * something outside the option matrix (the "different" path, a required
 * free-text description). A radio group switches paths; this component shows
 * only the active path's fields and posts the selection as contact[Request
 * type]. Transport is Shopify's native contact form (full-page POST to
 * /contact guarded by Shopify's spam protection); this component only handles
 * the dialog, prefill, path switching, the live availability status, and
 * restoring state after the redirect round trip.
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
  requiredRefs = [
    'dialog',
    'statusLine',
    'availabilityField',
    'variantData',
    'optionSelects',
    'pathRadios',
    'requestFields',
    'emailField',
    'stockFields',
    'noteField',
    'noteLabelText',
    'noteRequiredMark',
  ];

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

    // Restore the requested combination on both round-trip outcomes: on error
    // so the customer can correct and resubmit, on success so the reopened
    // dialog shows what was actually requested. The selected path is not
    // server-rendered, so it is restored from the snapshot; #applyPath then
    // reconciles field visibility and (for the stock path) the status line.
    const path = snapshot.path === 'different' || snapshot.path === 'custom' ? snapshot.path : 'stock';
    this.#setPath(path);
    if (path === 'stock') this.#setSelectValues(snapshot.values);
    this.#applyPath(path);

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
    this.#applyPath(this.#currentPath());
    this.showDialog();
  }

  /**
   * Recomputes the status line when any option select changes.
   */
  handleOptionChange() {
    this.#updateStatus();
  }

  /**
   * Switches visible fields when the request-type radio changes.
   */
  handlePathChange() {
    this.#applyPath(this.#currentPath());
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
        path: this.#currentPath(),
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
   * @returns {RequestPath} The checked request-type radio, defaulting to
   * 'stock' if none is checked (server renders 'stock' checked).
   */
  #currentPath() {
    const path = this.refs.pathRadios.find((radio) => radio.checked)?.dataset.path;
    return path === 'different' || path === 'custom' ? path : 'stock';
  }

  /**
   * Checks the radio matching the given path (used on snapshot restore).
   *
   * @param {RequestPath} path
   */
  #setPath(path) {
    this.refs.pathRadios.forEach((radio) => {
      radio.checked = radio.dataset.path === path;
    });
  }

  /**
   * Shows only the active path's fields.
   * - stock: reveals the option selects (enabled, so they post) and refreshes
   *   the live status; the note is an optional note.
   * - different: hides and disables the selects (so no "Requested <option>"
   *   keys post), marks availability "Not applicable", and makes the note a
   *   required description.
   * - custom: hides the whole on-page form and shows the custom-order link;
   *   nothing posts from this path, so email is disabled.
   * Email is required on the stock and different paths.
   *
   * @param {RequestPath} path
   */
  #applyPath(path) {
    const isStock = path === 'stock';
    const isDifferent = path === 'different';
    const isCustom = path === 'custom';
    const {
      requestFields,
      customFields,
      stockFields,
      optionSelects,
      emailField,
      noteField,
      noteLabelText,
      noteRequiredMark,
      availabilityField,
      statusLine,
    } = this.refs;

    // Custom hands off to the custom-orders page: swap the whole request form
    // for the link. customFields is only rendered when that page exists.
    requestFields.hidden = isCustom;
    if (customFields) customFields.hidden = !isCustom;

    // Email is required on the two on-page paths; disabled on custom so it
    // neither validates nor posts.
    emailField.disabled = isCustom;
    emailField.required = !isCustom;
    emailField.setAttribute('aria-required', isCustom ? 'false' : 'true');

    // Option selects apply only to the stock path; disabled elsewhere so they
    // never post.
    stockFields.hidden = !isStock;
    optionSelects.forEach((select) => {
      select.disabled = !isStock;
    });

    // The note is an optional note on stock and a required description on
    // different.
    noteField.toggleAttribute('required', isDifferent);
    noteField.setAttribute('aria-required', isDifferent ? 'true' : 'false');
    noteRequiredMark.hidden = !isDifferent;
    noteLabelText.textContent = isDifferent
      ? this.dataset.descriptionLabel ?? ''
      : this.dataset.noteLabel ?? '';

    if (isStock) {
      this.#updateStatus();
    } else {
      availabilityField.value = AVAILABILITY_TOKENS['not-applicable'];
      statusLine.hidden = true;
    }
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
