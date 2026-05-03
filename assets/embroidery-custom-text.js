import { Component } from '@theme/component';

/**
 * Embroidery custom text component
 * Handles custom text input with price adjustment for embroidery products
 */
class EmbroideryCustomTextComponent extends Component {
  refs = {};
  #priceAdjustmentElement = null;

  /**
   * Handle checkbox change event
   * Shows/hides text input and enables/disables it
   * @param {Event} event - The change event
   */
  handleCheckboxChange(event) {
    const isChecked = event.target.checked;
    const { inputWrapper, textInput, priceAdjustmentInput, errorMessage } = this.refs;

    if (isChecked) {
      // Show input wrapper and enable text input
      inputWrapper.hidden = false;
      textInput.disabled = false;
      textInput.focus();

      // Set price adjustment
      const priceAdjustment = this.dataset.priceAdjustment || '500';
      priceAdjustmentInput.value = priceAdjustment;

      // Show price adjustment in the UI
      this.showPriceAdjustment(parseInt(priceAdjustment));
    } else {
      // Hide input wrapper and disable text input
      inputWrapper.hidden = true;
      textInput.disabled = true;
      textInput.value = '';
      this.updateCharCount(0);

      // Reset price adjustment
      priceAdjustmentInput.value = '0';

      // Clear error message
      errorMessage.hidden = true;
      errorMessage.textContent = '';

      // Hide price adjustment in the UI
      this.hidePriceAdjustment();
    }
  }

  /**
   * Handle text input event
   * Updates character count
   * @param {Event} event - The input event
   */
  handleTextInput(event) {
    const { textInput } = this.refs;
    const length = textInput.value.length;
    this.updateCharCount(length);
  }

  /**
   * Update character count display
   * @param {number} count - Current character count
   */
  updateCharCount(count) {
    const { charCount } = this.refs;
    charCount.textContent = `${count}/15`;
  }

  /**
   * Validate the custom text input
   * @returns {boolean} - True if valid, false otherwise
   */
  validate() {
    const { checkbox, textInput, errorMessage } = this.refs;

    // If checkbox is not checked, validation passes
    if (!checkbox.checked) {
      return true;
    }

    // If checkbox is checked, text input must not be empty
    const value = textInput.value.trim();

    if (value === '') {
      errorMessage.textContent = 'Please enter custom text or uncheck the option';
      errorMessage.hidden = false;
      textInput.setAttribute('aria-invalid', 'true');
      return false;
    }

    // Clear any previous error
    errorMessage.hidden = true;
    errorMessage.textContent = '';
    textInput.removeAttribute('aria-invalid');
    return true;
  }

  /**
   * Show price adjustment in the UI
   * @param {number} adjustmentCents - Price adjustment in cents
   */
  showPriceAdjustment(adjustmentCents) {
    // Find the product price element
    const productPrice = document.querySelector('product-price');
    if (!productPrice) return;

    // Create adjustment element if it doesn't exist
    if (!this.#priceAdjustmentElement) {
      this.#priceAdjustmentElement = document.createElement('div');
      this.#priceAdjustmentElement.className = 'embroidery-price-adjustment';
      this.#priceAdjustmentElement.setAttribute('role', 'status');
      this.#priceAdjustmentElement.setAttribute('aria-live', 'polite');
    }

    // Format the price adjustment
    const adjustmentDollars = (adjustmentCents / 100).toFixed(2);
    this.#priceAdjustmentElement.textContent = `+$${adjustmentDollars} for custom embroidery`;

    // Insert after the price container if not already present
    const priceContainer = productPrice.querySelector('[ref="priceContainer"]');
    if (priceContainer && !this.#priceAdjustmentElement.parentElement) {
      priceContainer.insertAdjacentElement('afterend', this.#priceAdjustmentElement);
    }
  }

  /**
   * Hide price adjustment in the UI
   */
  hidePriceAdjustment() {
    if (this.#priceAdjustmentElement && this.#priceAdjustmentElement.parentElement) {
      this.#priceAdjustmentElement.remove();
    }
  }

  /**
   * Connect callback - runs when component is added to DOM
   */
  connectedCallback() {
    super.connectedCallback();

    // Listen for form submission attempts to validate
    const form = this.closest('form');
    if (form) {
      form.addEventListener('submit', this.handleFormSubmit.bind(this));
    }
  }

  /**
   * Handle form submit event
   * Validates the input before allowing submission
   * @param {Event} event - The submit event
   */
  handleFormSubmit(event) {
    if (!this.validate()) {
      event.preventDefault();
      event.stopImmediatePropagation();

      // Focus the text input to help user correct the error
      const { textInput } = this.refs;
      textInput.focus();
    }
  }
}

customElements.define('embroidery-custom-text-component', EmbroideryCustomTextComponent);
