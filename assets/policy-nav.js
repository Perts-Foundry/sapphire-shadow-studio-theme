import { Component } from '@theme/component';

/**
 * @typedef {object} PolicyNavRefs
 * @property {HTMLElement} nav - The nav shell, rendered hidden by snippets/policy-page.liquid.
 * @property {HTMLUListElement} list - The empty list this component fills.
 */

/**
 * Builds the "On this page" jump nav for a shop policy page.
 *
 * Policy pages are Shopify-rendered (no policy template type exists), so the
 * shell cannot be server-rendered where it belongs, between the page title
 * and the body. The snippet renders it (hidden) at the end of `<main>`,
 * because the layout is the only theme Liquid that runs on these pages, and
 * this component relocates it under `.shopify-policy__title`, fills the list
 * from the body's `h2`s, and unhides it only when there are enough sections
 * for a jump nav to earn its space. The shell is server-rendered at all
 * because its heading comes from a locale key JS cannot read.
 *
 * The ids are assigned at runtime from the heading text and double as the
 * shareable /policies/...#section links (an incoming hash is scrolled to
 * after assignment, since native fragment scroll ran before the ids
 * existed). They are only as durable as the wording: a reworded heading
 * changes its id and nothing checks sent links. A heading that already
 * carries an id keeps it, which is the one way to author an id that
 * survives rewording (in the Admin policy body; not available on the
 * auto-managed privacy policy, whose body Shopify rewrites).
 *
 * @extends {Component<PolicyNavRefs>}
 */
class PolicyNavComponent extends Component {
  requiredRefs = ['nav', 'list'];

  /** Below this, the nav is more chrome than help. */
  static MIN_HEADINGS = 3;

  connectedCallback() {
    super.connectedCallback();
    this.#build();
  }

  #build() {
    const { nav, list } = this.refs;

    if (!(nav instanceof HTMLElement) || !(list instanceof HTMLElement)) return;

    const title = document.querySelector('.shopify-policy__container .shopify-policy__title');
    const content = document.querySelector('.shopify-policy__body');
    if (!title || !content) return;

    const headings = /** @type {HTMLHeadingElement[]} */ ([...content.querySelectorAll('h2')]).filter(
      (heading) => heading.textContent?.trim()
    );

    // Ids are assigned to every section heading, not only when the nav shows:
    // they are the shareable /policies/...#section links, and tying their
    // existence to the nav threshold would break sent links if a policy ever
    // shrank below it.
    for (const heading of headings) {
      if (!heading.id) heading.id = uniqueId(slugify(heading.textContent?.trim() ?? '') || 'section');

      // Without this, activating a jump link scrolls but leaves focus on the
      // link, so the next Tab continues from the nav instead of the section the
      // reader just jumped to. Same mechanism as the skip link's `#main` target.
      heading.tabIndex = -1;

      heading.append(buildPermalink(heading.id));
    }

    if (headings.length >= PolicyNavComponent.MIN_HEADINGS) {
      const fragment = document.createDocumentFragment();

      for (const heading of headings) {
        const link = document.createElement('a');
        link.className = 'policy-nav__link';
        link.href = `#${encodeURIComponent(heading.id)}`;
        link.textContent = heading.textContent?.trim() ?? '';

        const item = document.createElement('li');
        item.className = 'policy-nav__item';
        item.append(link);
        fragment.append(item);
      }

      list.replaceChildren(fragment);
      // Move only the nav node, not this custom element: re-inserting the
      // element would re-fire connectedCallback and rebuild mid-build.
      title.after(nav);
      nav.hidden = false;
    }

    this.#scrollToIncomingHash(content);
  }

  /**
   * Honors a `#section` in the URL on arrival. The ids above do not exist at
   * parse time, so the browser's native fragment scroll finds nothing and
   * gives up; once they are assigned, a link someone was sent has to be
   * finished by hand. rAF so the scroll happens after this frame's layout,
   * the same rule the form-summary pattern follows.
   *
   * @param {HTMLElement} content - The policy body the ids were assigned in.
   */
  #scrollToIncomingHash(content) {
    let hash = '';
    try {
      hash = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return;
    }
    if (!hash) return;

    const target = document.getElementById(hash);
    if (!target || !content.contains(target)) return;

    requestAnimationFrame(() => {
      target.scrollIntoView();
      target.focus({ preventScroll: true });
    });
  }
}

/**
 * Builds the copy-link permalink appended to each section heading, mirroring
 * the FAQ's per-question permalink (same chain icon, same copy-to-clipboard
 * with a temporary "Link copied!" title, same 14px icon in a 24px target).
 * Unlike the FAQ's, it lives inside the heading: an h2 is not interactive,
 * so there is no nested-interactive problem to position around.
 *
 * @param {string} id - The heading's assigned id.
 * @returns {HTMLAnchorElement} The permalink element.
 */
function buildPermalink(id) {
  const anchor = document.createElement('a');
  anchor.className = 'policy-anchor';
  anchor.href = `#${encodeURIComponent(id)}`;
  anchor.setAttribute('aria-label', 'Copy link to this section');
  anchor.setAttribute('title', 'Copy link');
  anchor.append(buildLinkIcon());

  anchor.addEventListener('click', () => {
    const url = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(id)}`;
    navigator.clipboard?.writeText(url).then(() => {
      anchor.setAttribute('title', 'Link copied!');
      setTimeout(() => anchor.setAttribute('title', 'Copy link'), 2000);
    });
  });

  return anchor;
}

/**
 * The FAQ permalink's chain icon, built with DOM APIs rather than innerHTML.
 *
 * @returns {SVGSVGElement} A 24x24-viewBox chain-link icon.
 */
function buildLinkIcon() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'policy-anchor__icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const paths = [
    'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
    'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  ];
  for (const d of paths) {
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }

  return svg;
}

/**
 * Turns heading text into an id-safe slug.
 *
 * COUPLED TO `slugify` IN scripts/policies/lib/policies.mjs, which pins these ids into
 * marketing/policies/manifest.json as the anchor contract for the shop policy bodies. The two
 * must agree character for character, or the manifest records ids this component never assigns.
 * scripts/policies/test/slugify-parity.test.mjs extracts this function by source and compares the
 * two over the committed headings, so a drift is caught at CI time; keep the declaration in the
 * form `function slugify(text) {` or that extraction stops finding it.
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
