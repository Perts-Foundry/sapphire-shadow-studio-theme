import { Component } from '@theme/component';
import { prefersReducedMotion } from '@theme/utilities';

// Touch screens leave :hover (and an unmatched mouseenter) stuck on the last-tapped
// element, so hover-based autoplay suspension must only apply on hover-capable
// devices. The whole bar is tappable via .announcement-bar__link, so without this
// a single tap would suspend rotation with no mouseleave ever arriving to undo it.
// Mirrors the same constant in assets/slideshow.js.
const mediaQueryHover = matchMedia('(hover: hover)');

/**
 * Announcement banner custom element that allows fading between content.
 * Based on the Slideshow component.
 *
 * @typedef {object} Refs
 * @property {HTMLElement} slideshowContainer
 * @property {HTMLElement[]} [slides]
 * @property {HTMLButtonElement} [previous]
 * @property {HTMLButtonElement} [next]
 *
 * @extends {Component<Refs>}
 */
export class AnnouncementBar extends Component {
  #current = 0;

  /**
   * The interval ID for automatic playback.
   * @type {number|undefined}
   */
  #interval = undefined;

  /**
   * Whether the visitor explicitly asked for rotation by pressing play. Lets
   * resume() tell an automatic restart (which reduced motion should suppress)
   * from resuming something the visitor turned on themselves (which it should
   * not). Set in play(), cleared in pause().
   * @type {boolean}
   */
  #playbackRequested = false;

  connectedCallback() {
    super.connectedCallback();

    if (mediaQueryHover.matches) {
      this.addEventListener('mouseenter', this.suspend);
      this.addEventListener('mouseleave', this.resume);
    }
    this.addEventListener('focusin', this.#handleFocusIn);
    this.addEventListener('focusout', this.#handleFocusOut);
    document.addEventListener('visibilitychange', this.#handleVisibilityChange);

    // Start through resume() rather than play() so the reduced-motion gate there
    // governs the initial start too.
    this.resume();
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    this.suspend();
    this.removeEventListener('mouseenter', this.suspend);
    this.removeEventListener('mouseleave', this.resume);
    this.removeEventListener('focusin', this.#handleFocusIn);
    this.removeEventListener('focusout', this.#handleFocusOut);
    document.removeEventListener('visibilitychange', this.#handleVisibilityChange);
  }

  next() {
    this.current += 1;
  }

  previous() {
    this.current -= 1;
  }

  /**
   * Starts automatic slide playback.
   * @param {number} [interval] - The time interval in seconds between slides.
   */
  play(interval = this.autoplayInterval) {
    if (!this.autoplay) return;
    // Idempotent, so a second call cannot orphan the running interval. Matches
    // the guard in assets/slideshow.js.
    if (this.#interval) return;

    // Reaching play() while reduced motion is on means the visitor pressed the
    // play button: resume() diverts every automatic start path away from here
    // unless this flag is already set. Record it so later resume() calls honour
    // the request. See resume().
    //
    // Guarded on the media query rather than set unconditionally: resume() also
    // routes through play(), so an unconditional set would latch the flag for
    // every visitor and then ignore reduced motion being switched on later in
    // the session.
    if (prefersReducedMotion()) this.#playbackRequested = true;

    this.paused = false;
    // Silence the live region while announcements rotate on their own; see pause().
    if (this.hasAttribute('aria-live')) this.setAttribute('aria-live', 'off');

    this.#interval = setInterval(() => {
      if ((mediaQueryHover.matches && this.matches(':hover')) || document.hidden) return;

      this.next();
    }, interval);
  }

  /**
   * Pauses automatic slide playback.
   */
  pause() {
    // An explicit stop revokes the reduced-motion override from play(). resume()
    // already no-ops on `paused`, so this only matters for the resume() path that
    // clears `paused` on its way back to play().
    this.#playbackRequested = false;

    this.paused = true;
    // Rotation has stopped, so a slide change is now deliberate and worth
    // announcing. While rotating, announcing each one means a screen reader
    // interrupting itself on the autoplay interval indefinitely.
    if (this.hasAttribute('aria-live')) this.setAttribute('aria-live', 'polite');
    this.suspend();
  }

  get paused() {
    return this.hasAttribute('paused');
  }

  set paused(paused) {
    this.toggleAttribute('paused', paused);
  }

  /**
   * Suspends automatic slide playback.
   */
  suspend() {
    clearInterval(this.#interval);
    this.#interval = undefined;
  }

  /**
   * Resumes automatic slide playback if autoplay is enabled.
   */
  resume() {
    if (!this.autoplay || this.paused) return;

    // Reduced motion suppresses automatic rotation entirely. resume() is the right
    // seam for the check rather than play(): every automatic start path (initial
    // connect, hover-out, focus-out, tab becoming visible) comes through here,
    // while play() is also what the explicit play button calls, and a visitor who
    // presses play is asking for rotation regardless of the OS setting.
    //
    // #playbackRequested is what makes that last clause true. Without it the
    // check here fires again on the first hover-out or focus-out after the play
    // button was pressed, because play() clears `paused` and so the guard above
    // stops shielding it, and the rotation the visitor asked for dies silently.
    //
    // Land in the paused state rather than just returning: that shows the play
    // button instead of the pause button, keeps the live region on "polite", and
    // makes later resume() calls no-op on the `paused` check.
    if (prefersReducedMotion() && !this.#playbackRequested) {
      this.pause();
      return;
    }

    this.pause();
    this.play();
  }

  get autoplay() {
    return Boolean(this.autoplayInterval);
  }

  get autoplayInterval() {
    const interval = this.getAttribute('autoplay');
    const value = parseInt(`${interval}`, 10);

    if (Number.isNaN(value)) return undefined;

    return value * 1000;
  }

  get current() {
    return this.#current;
  }

  set current(current) {
    this.#current = current;

    let relativeIndex = current % (this.refs.slides ?? []).length;
    if (relativeIndex < 0) {
      relativeIndex += (this.refs.slides ?? []).length;
    }

    this.refs.slides?.forEach((slide, index) => {
      slide.setAttribute('aria-hidden', `${index !== relativeIndex}`);
    });
  }

  /**
   * Stop rotating while the page is hidden. This suspends rather than pauses:
   * pause() latches the `paused` attribute, which resume() treats as a deliberate
   * user choice and refuses to undo, so a tab switch would have stopped the bar
   * permanently and left the pause control showing the wrong state.
   */
  #handleVisibilityChange = () => (document.hidden ? this.suspend() : this.resume());

  /**
   * Hold rotation while focus is inside the bar, so a keyboard user reading an
   * announcement does not have it swapped out from under them. Hover already did
   * this for pointer users.
   */
  #handleFocusIn = () => this.suspend();

  /**
   * Resume once focus actually leaves. focusout bubbles, so moving between two
   * elements inside the bar fires it too; resuming on those would restart the
   * timer mid-interaction.
   */
  #handleFocusOut = (/** @type {FocusEvent} */ event) => {
    const { relatedTarget } = event;
    if (relatedTarget instanceof Node && this.contains(relatedTarget)) return;

    this.resume();
  };
}

if (!customElements.get('announcement-bar-component')) {
  customElements.define('announcement-bar-component', AnnouncementBar);
}
