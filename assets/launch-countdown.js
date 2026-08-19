import { Component } from '@theme/component';
import { prefersReducedMotion } from '@theme/utilities';

/**
 * Live countdown to the launch instant carried in `data-launch-at`, rendered by
 * `blocks/launch-countdown.liquid` on the password page only. Temporary: this
 * file is deleted along with the block when the password gate comes off.
 *
 * Every tick recomputes from `Date.now()` against the absolute target rather
 * than decrementing a counter, so there is no drift accumulation and a
 * background-throttled tab self-corrects the moment it is foregrounded.
 *
 * Padding mirrors the Liquid exactly: hours / minutes / seconds to two digits,
 * days at natural width (days can exceed 99 and must not be truncated). A
 * mismatch shows up as a visible jump between first paint and the first tick.
 *
 * @typedef {object} Refs
 * @property {HTMLElement} days
 * @property {HTMLElement} hours
 * @property {HTMLElement} minutes
 * @property {HTMLElement} seconds
 *
 * @extends {Component<Refs>}
 */
export class LaunchCountdown extends Component {
  requiredRefs = ['days', 'hours', 'minutes', 'seconds'];

  /**
   * The launch instant, in epoch milliseconds. Undefined when `data-launch-at`
   * is missing or unparseable, which leaves the server-rendered values alone.
   * @type {number|undefined}
   */
  #targetTime = undefined;

  /**
   * The interval ID for the once-a-second render.
   * @type {number|undefined}
   */
  #interval = undefined;

  connectedCallback() {
    super.connectedCallback();

    const target = new Date(this.dataset.launchAt ?? '');

    // A bad date leaves the server-rendered digits in place rather than
    // blanking them. The four refs are unconditionally present in the markup,
    // so the requiredRefs check above has already passed either way.
    if (Number.isNaN(target.getTime())) return;

    this.#targetTime = target.getTime();

    this.#render();
    this.#interval = setInterval(this.#render, 1000);
    document.addEventListener('visibilitychange', this.#handleVisibilityChange);
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    this.#stop();
    document.removeEventListener('visibilitychange', this.#handleVisibilityChange);
  }

  /**
   * Re-renders on returning to the tab, so a throttled interval never leaves
   * stale digits on screen.
   */
  #handleVisibilityChange = () => {
    if (!document.hidden) this.#render();
  };

  #stop() {
    if (this.#interval === undefined) return;

    clearInterval(this.#interval);
    this.#interval = undefined;
  }

  #render = () => {
    if (this.#targetTime === undefined) return;

    const remaining = Math.max(0, Math.floor((this.#targetTime - Date.now()) / 1000));

    this.#write(this.refs.days, String(Math.floor(remaining / 86400)));
    this.#write(this.refs.hours, this.#pad(Math.floor((remaining % 86400) / 3600)));
    this.#write(this.refs.minutes, this.#pad(Math.floor((remaining % 3600) / 60)));
    this.#write(this.refs.seconds, this.#pad(remaining % 60));

    if (remaining > 0) return;

    // Freeze at zeros. The store stays password-gated until the operator takes
    // the gate off, so nothing here claims the store is open.
    this.#stop();
    this.dataset.elapsed = '';
  };

  /**
   * Pads a value to two digits, matching the Liquid side.
   * @param {number} value
   * @returns {string}
   */
  #pad(value) {
    return String(value).padStart(2, '0');
  }

  /**
   * Writes a value to a digit element only when it actually changed, and
   * retriggers the tick animation on that element.
   * @param {HTMLElement} element
   * @param {string} value
   */
  #write(element, value) {
    if (element.textContent === value) return;

    element.textContent = value;

    if (prefersReducedMotion()) return;

    element.removeAttribute('data-tick');
    // A visibilitychange resync can clear and re-set the attribute inside one
    // paint frame, which would silently skip the animation restart. Forcing a
    // reflow between the two is what makes it retrigger.
    void element.offsetWidth;
    element.setAttribute('data-tick', '');
    element.addEventListener('animationend', () => element.removeAttribute('data-tick'), { once: true });
  }
}

if (!customElements.get('launch-countdown-component')) {
  customElements.define('launch-countdown-component', LaunchCountdown);
}
