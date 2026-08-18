import { Component } from '@theme/component';

/**
 * @typedef {object} Refs
 * @property {HTMLElement[]} [previewTriggers] - The generated collection links in the mega menu list.
 * @property {HTMLElement[]} [previewPanels] - The pre-rendered product panels, one per collection plus the default.
 */

/**
 * Swaps the mega menu's featured-products column to match the collection link
 * under the pointer or keyboard focus.
 *
 * Every panel is rendered server side, so this only toggles which one is shown.
 * The default panel carries an empty `data-preview-panel`, which is also what
 * `reset` restores when the pointer leaves the list.
 *
 * @extends {Component<Refs>}
 */
class MegaMenuPreview extends Component {
  /**
   * Shows the panel belonging to the hovered or focused collection link.
   *
   * @param {PointerEvent | FocusEvent} event
   */
  preview(event) {
    const trigger = event.target;

    if (!(trigger instanceof HTMLElement)) return;

    const handle = trigger.dataset.previewTarget;

    if (handle == null) return;

    this.#activate(handle);
  }

  /**
   * Restores the default panel.
   */
  reset() {
    this.#activate('');
  }

  /**
   * @param {string} handle - The collection handle to show, or an empty string for the default panel.
   */
  #activate(handle) {
    const panels = this.refs.previewPanels;

    if (!panels) return;

    for (const panel of panels) {
      const isActive = panel.dataset.previewPanel === handle;

      if (isActive === !panel.hidden) continue;

      if (isActive) {
        panel.hidden = false;
        // Unhiding and fading in on the same frame would skip the transition.
        requestAnimationFrame(() => {
          panel.classList.add('mega-menu__content-list--active');
        });
      } else {
        panel.classList.remove('mega-menu__content-list--active');
        panel.hidden = true;
      }
    }
  }
}

if (!customElements.get('mega-menu-preview')) {
  customElements.define('mega-menu-preview', MegaMenuPreview);
}
