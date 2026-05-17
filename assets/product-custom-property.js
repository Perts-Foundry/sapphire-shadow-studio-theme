// assets/product-custom-property.js
import { Component } from '@theme/component';

/**
 * @typedef {object} ProductCustomPropertyRefs
 * @property {HTMLInputElement | HTMLTextAreaElement} textInput - The text input.
 * @property {HTMLElement} characterCount - The character count element.
 */

/**
 * A custom element that manages product custom properties
 * @extends Component<ProductCustomPropertyRefs>
 */
class ProductCustomProperty extends Component {
  connectedCallback() {
    super.connectedCallback();

    // Wire a contextual validation message on required text/textarea inputs.
    // (Checkbox input type renders via snippets/checkbox.liquid and has no
    // textInput ref; required checkboxes rely on the browser default message,
    // which is fine since they're only used for short opt-in labels.)
    const input = this.refs.textInput;
    if (input?.hasAttribute('required')) {
      input.addEventListener('invalid', this.#handleInvalid);
    }
  }

  handleInput() {
    this.#updateCharacterCount();
    // Clear any custom validity message as soon as the user starts typing,
    // so the field can be re-validated against required + maxlength on the
    // next submit attempt.
    this.refs.textInput?.setCustomValidity('');
  }

  /**
   * Sets a short contextual validation message on the native bubble so it
   * matches the style of blocks/applique-pattern-select.liquid and the
   * return-policy acknowledgement, instead of the generic browser default.
   * The bubble anchors to the field, so we don't need to name it in the copy.
   */
  #handleInvalid = () => {
    this.refs.textInput?.setCustomValidity('Please fill out this field before adding to cart.');
  };

  #updateCharacterCount() {
    const { characterCount, textInput } = this.refs;
    const currentLength = textInput.value.length;
    const maxLength = textInput.maxLength;

    const template = characterCount.getAttribute('data-template');
    if (!template) return;

    const updatedText = template.replace('[current]', currentLength.toString()).replace('[max]', maxLength.toString());

    characterCount.textContent = updatedText;
  }
}

customElements.define('product-custom-property-component', ProductCustomProperty);
