import { Component } from '@theme/component';

/**
 * @typedef {object} PolicyNavRefs
 * @property {HTMLElement} nav - The nav shell, rendered hidden by the section.
 * @property {HTMLUListElement} list - The empty list this component fills.
 * @property {HTMLElement} content - The policy body to scan for headings.
 */

/**
 * Builds the "On this page" jump nav for a shop policy page.
 *
 * The shell (nav element and its heading) is rendered server-side, because a
 * locale key cannot be read from JS. This component scans the policy body for
 * `h2`s, gives each one a slugified id, fills the list, and unhides the shell
 * only when there are enough sections for a jump nav to earn its space.
 *
 * The ids are assigned at runtime, so they are in-page jump targets only and
 * are not durable link targets: a reworded heading changes its id.
 *
 * @extends {Component<PolicyNavRefs>}
 */
class PolicyNavComponent extends Component {
  requiredRefs = ['nav', 'list', 'content'];

  /** Below this, the nav is more chrome than help. */
  static MIN_HEADINGS = 3;

  connectedCallback() {
    super.connectedCallback();
    this.#build();
  }

  #build() {
    const { nav, list, content } = this.refs;

    if (!(nav instanceof HTMLElement) || !(list instanceof HTMLElement) || !(content instanceof HTMLElement)) return;

    const headings = /** @type {HTMLHeadingElement[]} */ ([...content.querySelectorAll('h2')]).filter(
      (heading) => heading.textContent?.trim()
    );

    if (headings.length < PolicyNavComponent.MIN_HEADINGS) return;

    const fragment = document.createDocumentFragment();

    for (const heading of headings) {
      const text = heading.textContent?.trim() ?? '';

      if (!heading.id) heading.id = uniqueId(slugify(text) || 'section');

      const link = document.createElement('a');
      link.className = 'policy__nav-link';
      link.href = `#${encodeURIComponent(heading.id)}`;
      link.textContent = text;

      const item = document.createElement('li');
      item.className = 'policy__nav-item';
      item.append(link);
      fragment.append(item);
    }

    list.replaceChildren(fragment);
    nav.hidden = false;
  }
}

/**
 * Turns heading text into an id-safe slug.
 *
 * @param {string} text - The heading's visible text.
 * @returns {string} A lowercase hyphenated slug, or an empty string if nothing survived.
 */
function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 50)
    .replace(/^-+|-+$/g, '');
}

/**
 * Suffixes a slug until nothing in the document already claims it.
 *
 * @param {string} base - The preferred id.
 * @returns {string} An id that is unique in the current document.
 */
function uniqueId(base) {
  let candidate = base;
  let suffix = 2;

  while (document.getElementById(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

if (!customElements.get('policy-nav-component')) {
  customElements.define('policy-nav-component', PolicyNavComponent);
}
