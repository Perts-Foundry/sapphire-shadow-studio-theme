# ADA compliance for your Shopify store: the complete guide

**Your Shopify store almost certainly falls under ADA Title III, and e-commerce sites are the #1 target for accessibility lawsuits — accounting for 77% of all digital accessibility cases filed in 2024.** The good news: meaningful compliance is achievable for $0–$2,000 if you do most work yourself, compared to the $30,000+ average cost of defending a lawsuit. Courts and settlements consistently reference **WCAG 2.1 Level AA** as the benchmark standard, which requires meeting 50 specific success criteria across four principles: perceivable, operable, understandable, and robust. As a Virginia-based business on Shopify's Horizon theme, you face moderate geographic risk (Virginia isn't a top-filing state, but you can be sued anywhere you sell) and some theme-specific accessibility gaps that need code-level fixes. This guide covers everything you need to know — from the legal landscape to a line-by-line technical checklist — to protect your custom embroidered sweater business.

---

## The legal reality: why your store is covered and what's at stake

Title III of the ADA (42 U.S.C. § 12182) prohibits discrimination by "places of public accommodation." While the 1990 statute never mentions websites, the DOJ has maintained since 1996 that websites of public accommodations must be accessible. Courts remain split — the 9th Circuit ruled websites are covered in *Robles v. Domino's Pizza* (2019), while the 11th Circuit narrowed coverage in *Gil v. Winn-Dixie* (2021) — but critically, the *Winn-Dixie* court emphasized that decision applied to a site with "limited functionality" and no e-commerce. **A full e-commerce store like yours would likely be covered even under the narrower standard.**

Your 4th Circuit (covering Virginia) hasn't definitively ruled on whether websites are places of public accommodation. In *Griffin v. Dep't of Labor FCU* (2019), the court dismissed on standing grounds without reaching the merits. In *Laufer v. Naranda Hotels*, the 4th Circuit allowed a "tester" plaintiff to sue over an inaccessible hotel website, signaling receptiveness to these claims.

The DOJ's April 2024 final rule under Title II formally adopted WCAG 2.1 Level AA for government websites — the first time the standard appeared in federal regulation. While Title II applies to government entities, not private businesses, this signals what courts will expect of e-commerce stores. The DOJ never finalized equivalent Title III regulations, and the current administration shelved the rulemaking in September 2025. This paradoxically **increases** your risk: without formal rules, private litigation fills the gap, and lawsuit volume continues to climb.

### The numbers that matter for your business

Over **4,000 digital accessibility lawsuits** were filed in federal court in 2024, with the first half of 2025 showing a 37% increase over the same period. **67–73% of cases target businesses with annual revenue under $25 million**, and Shopify stores are specifically among the platforms targeted. Virginia isn't in the top 10 filing states (New York, California, and Florida dominate), but if you sell to customers in those states, you can be sued there.

Under federal ADA Title III, plaintiffs can obtain **injunctive relief** (a court order to fix your site) and **attorney's fees** — but not monetary damages. The real financial exposure comes from state laws: California's Unruh Act provides **$4,000 minimum statutory damages per violation**, and New York's Human Rights Law permits compensatory and punitive damages. Virginia has no equivalent state statute adding damages beyond federal ADA for private e-commerce businesses.

Typical small business settlement amounts range from **$5,000 to $20,000**, but total costs including defense attorney fees ($5,000–$15,000), plaintiff's attorney fees ($10,000–$50,000 if court-ordered), and mandatory remediation ($500–$15,000) can reach **$20,000–$95,000**. One Shopify merchant reported paying $10,000 in settlement; another faced a $30,000 demand from a three-employee food brand. As one merchant put it in Shopify's own reporting: "Instead of investing back into the company, it went into some attorney's pocket."

### Virginia-specific exposure

Virginia's Information Technology Access Act (VITA) and the 2025 update HB 2541 apply to **state agencies and their vendors** — not private e-commerce businesses selling to consumers. Unless you sell to Virginia government entities (which would trigger Section 508 and HB 2541 requirements for Accessibility Conformance Reports), **no Virginia state law directly requires your website to be accessible**. Your exposure is entirely federal ADA Title III, applied through court interpretation. Section 508 of the Rehabilitation Act likewise does not apply to your business unless you contract with federal agencies or receive federal funding.

---

## Who files these lawsuits and how they find you

The ADA website lawsuit ecosystem is dominated by a small number of prolific actors. Over **80% of ADA cases** come from "high-volume plaintiffs" filing at least 8 cases per year. A single California law firm, So Cal Equal Access Group, filed **2,598 federal ADA Title III lawsuits** in 2024 alone. One serial plaintiff, Perla Mageno, has filed over 600 lawsuits — if each settled for $10,000, that represents $6 million from one individual.

The typical pattern works like this: plaintiff law firms use **automated scanning bots** to crawl thousands of websites for WCAG violations. They identify targets, document specific failures (missing alt text, keyboard navigation issues, contrast problems), then either send a demand letter or file a federal complaint directly — often with no prior contact. Multiple Shopify merchants report being blindsided. As one merchant wrote: "We NEVER received anything before being served... no email, no phone call... NOTHING asking us to make changes... just BOOM, a Lawsuit."

For every lawsuit filed, defense attorneys estimate **7–10 demand letters** are sent — an estimated 1,500 demand letters per week during peak periods. The plaintiff typically receives a nominal amount ($500–$4,500) while the **attorney receives the bulk** of the settlement. Multiple merchants confirm that plaintiffs' attorneys never followed up to check whether fixes were actually made: "They didn't care if my site was accessible. They just cared about how fast they could get the money."

In 2025, approximately **40% of ADA filings are now pro se (self-represented) plaintiffs using AI to draft complaints**, further lowering the barrier to filing.

### The five violations that trigger most lawsuits

Based on court filings and accessibility expert analysis, these issues appear most frequently in ADA complaints against e-commerce stores:

- **Missing or inadequate image alt text** — cited in the vast majority of complaints; for a sweater business with many product images, this is your highest-risk area
- **Keyboard navigation failures** — site requires a mouse to operate, trapping keyboard-only users
- **Screen reader incompatibility** — content not properly structured for assistive technology (missing ARIA labels, improper heading hierarchy, empty buttons)
- **Poor color contrast** — text below the 4.5:1 ratio requirement, especially light gray on white backgrounds common in modern themes
- **Inaccessible forms** — missing labels on newsletter signups, search fields, contact forms, and checkout inputs

---

## Your Horizon theme: what's accessible and what's not

Shopify's Horizon theme, launched May 2025 as part of the Summer '25 Edition, represents a new theme framework replacing Dawn. It's mobile-first, fully block-based with up to 8 levels of nested blocks, and Shopify markets it as having "built-in accessibility." However, **Shopify's own Theme Store requirements cover only approximately 16–22% of WCAG 2.2 AA success criteria** — meaning even a perfect Lighthouse score of 90+ leaves the majority of accessibility requirements unverified.

### What Horizon handles natively

Shopify's hosted checkout has a published VPAT (June 2025) and is tested against WCAG 2.0/2.1/2.2 Level A and AA with quarterly usability testing by disabled users. It mostly "Supports" accessibility criteria, with some "Partially Supports" areas around vaulted payment sections and address suggestion functionality. On a Basic plan, **you cannot modify checkout** — which is actually protective, since Shopify maintains its accessibility.

The Horizon theme provides baseline semantic HTML structure (header, nav, main, footer), a skip-to-content link, responsive mobile-first layouts, basic keyboard navigation for native HTML elements, and the `lang="en"` attribute. Shopify Admin provides fields for product image alt text (with AI-suggested alternatives), theme image alt text, and color customization settings.

### Known Horizon accessibility gaps requiring code fixes

Independent analysis by accessibility specialist Nic Chan (Converge Accessibility, June 2025) identified critical regressions in Horizon compared to pre-Horizon first-party themes:

**Missing focus styles** on interactive elements — keyboard users cannot see which element is currently selected. This violates WCAG 2.4.7 (Focus Visible) and is one of the most commonly exploited issues in lawsuits. Requires custom CSS in your theme files via GitHub.

**Auto-playing animated sections without pause/stop controls** — violates WCAG 2.2.2 (Pause, Stop, Hide). Horizon's animation-heavy design introduces moving content lasting more than 5 seconds with no mechanism to pause. Requires adding JavaScript controls and respecting `prefers-reduced-motion` via theme code.

**Mega menu navigation bug** — the desktop mega menu reportedly closes immediately when moving the cursor from the navigation trigger to the submenu, potentially violating WCAG 1.4.13 (Content on Hover or Focus). Shopify has acknowledged this is under development.

**AI-generated blocks have no accessibility quality assurance** — Horizon's AI block generation feature produces non-deterministic code. Testing found that even requesting "enhanced accessibility" in AI prompts produced code that "fell short." Every AI-generated section must be manually verified.

### What you cannot fix

Three areas fall outside your control: Shopify-hosted checkout issues on the Basic plan (no customization available), third-party app widget accessibility (Shopify Inbox, review widgets, popup apps commonly inject inaccessible HTML), and AI-generated block accessibility guarantees. **Every customer-facing app you install is a potential liability** — apps have no strict accessibility requirements in the Shopify App Store.

---

## Do NOT install an accessibility overlay widget

This deserves its own section because it is the single most counterproductive action you could take. Overlay widgets (accessiBe, UserWay, AudioEye, EqualWeb) are JavaScript tools that claim to automatically make websites accessible. **They do not work, they increase your legal risk, and the leading provider was fined $1 million by the FTC.**

In January 2025, the FTC fined accessiBe for "false, misleading, or unsubstantiated" claims about its product's ability to achieve WCAG compliance. According to UsableNet's 2024 data, **25% of all accessibility lawsuits — over 1,000 cases — specifically cited overlay widgets as the problem**. Plaintiff law firms use tools like BuiltWith to identify every website running an overlay and then target them systematically. A DOJ representative reportedly referred to overlay use as "legal suicide."

The technical reason is straightforward: **screen readers parse actual HTML/DOM structure, not JavaScript overlays**. Overlays run after page load — by then, assistive technology has already parsed the page structure. They cannot fix missing form labels in source code, improper heading hierarchy, keyboard navigation failures, or meaningful alt text. In *Murphy v. Eyebobs*, a company using accessiBe was sued, lost, and was required to perform actual source-code remediation. The overlay had actually trapped screen reader users, making the site less accessible.

Over **700 accessibility professionals** from Google, Microsoft, Apple, Shopify, BBC, and eBay signed the Overlay Fact Sheet (overlayfactsheet.com) opposing these products. **72% of disabled respondents** in a WebAIM survey said overlays were "not at all" or "not very" effective. Multiple blind users report that sites became harder to use after overlays were installed — and in some cases, disabling the overlay restored functionality.

If Shopify support suggests installing an overlay (which merchants report has happened), **decline the advice**. Source-code remediation is the only legally and technically defensible approach.

---

## Complete WCAG 2.1 AA technical requirements for your store

WCAG 2.1 Level AA conformance requires meeting **50 success criteria** across four principles. Below are the requirements most critical for an e-commerce store selling custom embroidered sweaters, organized by what you can handle in Shopify Admin versus what requires code edits via your GitHub repository.

### Perceivable: users must be able to perceive all content

**Product image alt text** is your highest-priority item. Every product image needs descriptive alt text entered in Shopify Admin → Products → Media → Add alt text. For your sweaters, good alt text describes the product specifically: "Navy blue crew neck wool sweater with white floral embroidery pattern on chest" — not "sweater" or "IMG_4532.jpg." Don't prefix with "image of" (screen readers already announce the element type). Keep descriptions to **10–12 words**, ending with a period. Color swatches need alt text like "Select Navy Blue," not just a hex code. Decorative images (background textures, dividers) should have empty `alt=""` or be implemented via CSS. Size charts presented as images must be recreated as accessible HTML tables — 64% of e-commerce sites fail this requirement according to Baymard Institute.

**Color contrast** requires a **4.5:1 minimum ratio** for normal text (under 24px regular or 18.5px bold) and **3:1 for large text** (24px+ regular or 18.5px+ bold). UI components and graphical objects (button borders, form input borders, icons, focus indicators) require 3:1 contrast against adjacent colors. Common failures in modern Shopify themes include light gray product descriptions, faded placeholder text, and button text on colored backgrounds. WebAIM reports **81% of homepages fail contrast requirements**. Check your theme's color settings and adjust via Shopify Admin where possible; custom CSS fixes via GitHub for remaining issues.

**Color must not be the sole means of conveying information.** Sale prices need a "Sale:" label, not just red text. Form errors need icon + text message, not just a red border. Out-of-stock variants need "Out of Stock" text, not just a grayed-out appearance. Color swatches must include text labels or tooltips.

**Video and media content** requires synchronized captions for all prerecorded video with audio (including product demos and embroidery process videos), audio descriptions for important visual information not in the audio track, and auto-playing media must be muted with a mechanism to pause, stop, or control volume. The Space key must pause/play any video.

### Operable: users must be able to operate all functionality

**All functionality must be operable via keyboard alone.** This means the entire critical path — navigate header → browse products → open product page → select size/color → adjust quantity → add to cart → view cart → complete checkout — must work using only Tab, Shift+Tab, Enter, Space, Arrow keys, and Escape. Test this yourself by unplugging your mouse and attempting to buy a sweater.

**Visible focus indicators** are required on every focusable element with at least 3:1 contrast against adjacent colors and a minimum 2px thickness. **Never use `*:focus { outline: none; }` without a replacement.** Horizon has reported missing focus styles — this requires a custom CSS fix in your GitHub repository using `:focus-visible` selectors.

**No keyboard traps** — users must never get stuck. The Escape key must close all overlays. Focus must be trapped within open modals (so Tab cycles only through modal elements) but must return to the trigger element when the modal closes. Common traps include cookie consent banners, newsletter popups, and cart drawers.

**Auto-moving content lasting more than 5 seconds must have pause/stop/hide controls.** This applies to homepage carousels, auto-scrolling product sliders, animated banners, and background video. Horizon's animated sections may lack these controls — requires JavaScript implementation via your theme code. Your theme should also respect the `prefers-reduced-motion` CSS media query (Horizon documentation indicates support, but verify).

**Touch targets** should be a minimum of **44×44 CSS pixels** (WCAG 2.1 AAA recommendation, widely expected in practice) for all interactive elements: add-to-cart buttons, quantity selectors, variant selectors, filter checkboxes, and pagination controls.

### Understandable: content and interface must be understandable

**Every form input needs a programmatically associated label** — not just placeholder text. This applies to your newsletter signup, search field, contact form, and any quantity or variant selectors. Use `<label for="id">` for association. Required fields should be marked with "(required)" text, not just an asterisk. Add `autocomplete` attributes to user data fields: `autocomplete="given-name"`, `"email"`, `"street-address"`.

**Form errors must be automatically detected and described in text** using `role="alert"` or `aria-live="polite"` for screen reader announcement. Display errors near the relevant field using `aria-invalid="true"` and `aria-describedby`. Provide correction suggestions ("Please use format: name@example.com").

**Consistent navigation** across all pages, with headings and labels that describe their topic or purpose. Heading hierarchy must follow h1–h6 in proper sequence: each page needs one h1 (product name on product pages), never skip levels, and use headings for structure, not just styling.

### Robust: content must work with assistive technologies

**All UI components need programmatically determinable name, role, and state.** Custom dropdowns need proper ARIA roles. Accordions need `aria-expanded`. Modals need `role="dialog"` and `aria-modal="true"`. Tabs need `role="tablist/tab/tabpanel"` with `aria-selected`. Follow the first rule of ARIA: use native HTML elements first — "no ARIA is better than bad ARIA." WebAIM found that pages using ARIA average 41% more detected accessibility errors than those without.

**Status messages must be announced without receiving focus** via ARIA live regions. "Item added to cart" needs `role="status"` with `aria-live="polite"`. Form errors need `role="alert"` (assertive). Cart count updates, search results counts, and filter result changes all need `aria-live="polite"` regions. This is a code-level requirement across your theme templates.

### Dynamic content: the complexity layer

Your product image galleries/carousels need Previous/Next `<button>` controls (not just swipe), slide position indicators for screen readers ("Slide 2 of 5" via `aria-live`), off-screen slides marked `aria-hidden="true"`, and a container with `role="region"` and `aria-label`.

Modals and drawers (cart drawer, quick view, cookie consent, newsletter popup) need `role="dialog"` + `aria-modal="true"` + `aria-labelledby`, focus moved into the modal on open, focus trapped within, Escape key closure, and focus returned to the trigger on close.

Product variant selectors (size/color) need careful attention: color swatches often use `display: none` on radio inputs, which completely removes keyboard access and screen reader discoverability. Each variant needs an `aria-label` with the color/size name. Dynamic price and availability changes triggered by variant selection need `aria-live="polite"` regions.

---

## How to audit your store right now

Automated testing tools catch only **30–40% of WCAG issues** — they identify missing alt text, contrast failures, missing form labels, empty links, and ARIA errors, but cannot evaluate alt text quality, logical reading order, keyboard trap behavior, or complex interaction patterns. Use automated tools as a starting point, then follow with manual testing.

### Free automated tools to run immediately

**WAVE** (WebAIM browser extension) provides inline visual indicators directly on your page — install it, run it on your homepage, a product page, a collection page, and your cart page. **Google Lighthouse** (built into Chrome DevTools → Lighthouse tab) gives an accessibility score out of 100 and flags specific violations. **axe DevTools** (Deque's Chrome extension, used in Inspect mode) has a zero-false-positive design philosophy and integrates with CI/CD pipelines. Run all three on your key pages and document every error.

### Manual testing you must do yourself

**Keyboard test:** Unplug your mouse. Navigate your entire store using only Tab, Shift+Tab, Enter, Space, Arrow keys, and Escape. Can you reach every link and button? Is there a visible focus indicator on each element? Can you select a sweater variant, add it to cart, and reach checkout? Are you trapped anywhere? This takes 1–2 hours and reveals issues no automated tool can find.

**Screen reader test:** Download NVDA (free, Windows, nvaccess.org) or activate VoiceOver (free, built into Mac with Cmd+F5). Navigate your store and note: Are product images described meaningfully? Are buttons labeled? Is the reading order logical? Can you complete a purchase? Budget 2–3 hours.

**Content review:** Verify every product image has descriptive alt text. Check heading hierarchy (h1 → h2 → h3, no skipping). Verify all forms have proper labels. Confirm links make sense out of context (not just "click here"). Check that color isn't the only way information is conveyed. Budget 1–2 hours.

### Your GitHub advantage: Shopify Lighthouse CI

Since you manage your Horizon theme via GitHub, set up Shopify's official **Lighthouse CI GitHub Action** (`shopify/lighthouse-ci-action`). This uploads your theme code to a benchmark shop, runs Lighthouse tests, and can block pull requests that degrade your accessibility score below a threshold. Configure it to require a minimum accessibility score of 0.9:

```yaml
name: Shopify Lighthouse CI
on: [push]
jobs:
  lhci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: shopify/lighthouse-ci-action@v1
        with:
          store: ${{ secrets.SHOP_STORE }}
          access_token: ${{ secrets.SHOP_ACCESS_TOKEN }}
          lhci_min_score_accessibility: 0.9
```

This requires a Custom App access token with `write_themes` and `read_products` scopes. It won't catch everything (Lighthouse covers a fraction of WCAG), but it prevents regressions on every code push — a genuine competitive advantage over merchants who don't use version control.

---

## Practical compliance steps, costs, and legal protection

### Cost comparison: compliance vs. lawsuit

| Approach | Cost | Coverage |
|----------|------|----------|
| DIY (free tools + your time) | $0 + 10–15 hours | Catches ~60–70% of issues |
| DIY + targeted professional audit (3–5 pages) | $750–$1,500 | Catches ~85–90% of issues |
| Full professional audit + remediation | $3,750–$7,750 | Comprehensive |
| Average ADA lawsuit (settlement + legal + remediation) | **$20,000–$95,000** | Reactive, no choice |

The **IRS Disabled Access Credit** (Section 44) allows small businesses to claim up to **$5,000 per year** for accessibility expenditures — potentially covering most or all of a professional audit.

### Publish an accessibility statement

An accessibility statement is not legally required under the ADA but **strongly recommended** as evidence of good faith. It provides a feedback channel that could resolve issues before they escalate to litigation, and it documents awareness and active effort — critical factors in ADA cases. Generate one free using the **W3C WAI Accessibility Statement Generator** (w3.org/WAI/planning/statements/generator/). Include: your commitment to accessibility, the standard you're targeting (WCAG 2.1 Level AA), your current conformance status (be honest — partial conformance is fine), known limitations you're working on, a feedback mechanism (phone and email), response timeframe (e.g., "within 5 business days"), and date of last assessment. **Add this as a linked page in your Shopify store footer.**

### Insurance and legal protection

**EPLI (Employment Practices Liability Insurance)** is the primary vehicle for ADA website lawsuit coverage. **Vouch** launched the first dedicated digital accessibility coverage as an add-on to General Liability in January 2024. **NEXT Insurance** offers EPLI as an add-on with $25,000–$50,000 coverage. Ask your insurance agent specifically about third-party ADA website claims — many standard policies exclude them. Insurance covers legal defense costs and settlements but not website remediation or regulatory fines.

**There is no official government "ADA compliance certification"** for websites. Any company selling one is misleading you. What does exist: a WCAG Conformance Statement authored after a professional audit (a "report card"), and VPATs/ACRs (Voluntary Product Accessibility Templates) starting at ~$350 — primarily useful if you ever sell to government entities.

### If you receive a demand letter

**Do not panic, do not pay immediately, and do not respond directly.** Within 24–48 hours, consult an attorney experienced in ADA web accessibility cases (Seyfarth Shaw LLP is the premier defense firm; Allyant can connect you with defense attorneys; your local Virginia bar can provide referrals). Your attorney will assess whether the letter is legitimate, whether the law firm is a known serial filer, and what the claims actually state.

Many demand letters are **boilerplate** — not all cited issues may exist on your site. Some claims may be technically incorrect (e.g., claiming empty alt text on decorative images is a violation when it's actually correct). Have an accessibility expert validate the specific claims. Begin remediation immediately and **document everything with timestamps** to demonstrate good faith. Most cases settle — over 80% never reach trial — and small business settlements typically range from $5,000 to $20,000. One Shopify merchant got her case dismissed by calling the plaintiff's attorney, explaining they were a small family business making fixes, and providing evidence of remediation.

---

## Priority action checklist for your Shopify Horizon theme store

### 🔴 Critical priority (do this week — highest lawsuit risk)

| # | Action | Where | Details |
|---|--------|-------|---------|
| 1 | Add descriptive alt text to ALL product images | **Shopify Admin** → Products → Media → Alt text | Describe each sweater: color, material, embroidery design, fit. "Navy blue crew neck wool sweater with white floral embroidery on chest" |
| 2 | Add alt text to ALL theme/banner/hero images | **Shopify Admin** → Theme Editor → Section → Image → Alt text | Describe informational images; use empty alt for purely decorative ones |
| 3 | Run WAVE + Lighthouse on your 5 key pages | **Browser** (no code needed) | Homepage, collection, product, cart, contact. Document all errors with screenshots and dates |
| 4 | Keyboard navigation test | **Browser** (unplug mouse) | Tab through entire purchase flow. Document any traps or unreachable elements |
| 5 | Fix visible focus indicators on all interactive elements | **GitHub** → theme CSS file | Add `:focus-visible` styles with 3:1 contrast, 2px+ outline. Horizon has reported missing focus styles |
| 6 | Ensure color contrast meets 4.5:1 for body text | **Shopify Admin** (theme color settings) + **GitHub** (custom CSS overrides) | Use WebAIM Contrast Checker. Fix light grays, faded placeholder text, button text on colored backgrounds |
| 7 | Add proper `<label>` elements to all form inputs | **GitHub** → Liquid templates | Newsletter signup, search field, contact form. Placeholder text alone is insufficient |
| 8 | Remove any overlay widget if installed | **Shopify Admin** → Apps | Uninstall accessiBe, UserWay, or any "accessibility toolbar" immediately |

### 🟠 High priority (do within 2 weeks)

| # | Action | Where | Details |
|---|--------|-------|---------|
| 9 | Add `aria-live="polite"` regions for cart updates | **GitHub** → cart Liquid/JS files | "Item added to cart" announcements, cart count changes, price updates on variant selection |
| 10 | Fix auto-playing animations with pause/stop controls | **GitHub** → section Liquid/JS files | Add visible Pause button to any carousel, slideshow, or animated banner. Respect `prefers-reduced-motion` |
| 11 | Implement proper modal/drawer accessibility | **GitHub** → drawer/modal JS files | Cart drawer, newsletter popup, cookie consent: focus trap, Escape key, `role="dialog"`, `aria-modal="true"`, focus return |
| 12 | Fix heading hierarchy across all page templates | **GitHub** → Liquid templates | One h1 per page (product name or page title). Sequential h2→h3→h4. Never skip levels |
| 13 | Add `aria-label` to icon-only buttons | **GitHub** → Liquid templates | Cart icon, search icon, close buttons, social media icons: `aria-label="Search products"`, `aria-label="Close"` |
| 14 | Ensure color swatches have text alternatives | **GitHub** → product template Liquid | Each swatch needs `aria-label="Navy Blue"` and visible text label/tooltip. Don't use `display: none` on radio inputs |
| 15 | Publish accessibility statement | **Shopify Admin** → Pages → add new page + footer link | Use W3C WAI generator. Reference WCAG 2.1 AA. Include feedback email and phone |

### 🟡 Medium priority (do within 1 month)

| # | Action | Where | Details |
|---|--------|-------|---------|
| 16 | Screen reader test with NVDA or VoiceOver | **Your computer** | Navigate full purchase flow. Note any confusing announcements or missing information |
| 17 | Add `autocomplete` attributes to all user data form fields | **GitHub** → form Liquid templates | `autocomplete="email"`, `"given-name"`, `"street-address"` on contact/newsletter forms |
| 18 | Implement skip navigation link (verify/enhance) | **GitHub** → theme.liquid layout | "Skip to content" visible on keyboard focus, targeting `<main>` with `tabindex="-1"` |
| 19 | Add captions to any product videos | **Shopify Admin** or video hosting platform | Synchronized captions for all prerecorded video. Auto-generated captions must be reviewed for accuracy |
| 20 | Audit and test all third-party apps | **Browser** (keyboard + screen reader) | Every customer-facing app widget. Disable or replace any that introduce accessibility barriers |
| 21 | Set up Shopify Lighthouse CI GitHub Action | **GitHub** → repository workflows | Configure minimum accessibility score of 0.9. Blocks PRs that degrade accessibility |
| 22 | Convert any image-based size charts to HTML tables | **GitHub** → product template or **Shopify Admin** → page content | Use `<table>`, `<th>`, and `scope` attributes. Provide both image and table versions |
| 23 | Implement form error handling with ARIA | **GitHub** → form JS/Liquid files | `role="alert"` for errors, `aria-invalid="true"` on invalid fields, `aria-describedby` linking to error messages |

### 🟢 Lower priority (do within 3 months, then maintain)

| # | Action | Where | Details |
|---|--------|-------|---------|
| 24 | Verify touch targets are ≥44×44px | **GitHub** → CSS files | Add-to-cart, quantity +/-, variant buttons, filter checkboxes. Use CSS `min-width`/`min-height` |
| 25 | Ensure page titles are descriptive | **Shopify Admin** → SEO settings per page | "Navy Embroidered Sweater — [Store Name]" not just "Product" |
| 26 | Add `lang` attributes to foreign-language content | **GitHub** → Liquid templates | Mark any non-English text passages with `lang` attribute |
| 27 | Create accessible PDFs for any downloadable content | **External tool** (Adobe Acrobat, Google Docs export) | Tag headings, set reading order, add alt text to images, set document language. Offer HTML alternatives |
| 28 | Consider professional audit of 3–5 key pages | **External** (hire consultant) | $750–$1,500 for focused expert review. Catches issues automated tools and self-testing miss |
| 29 | Get EPLI insurance with ADA website coverage | **External** (insurance provider) | Ask about third-party ADA claims. Vouch and NEXT Insurance offer relevant add-ons |
| 30 | Document all accessibility work with dates | **Your records** | Maintain a log of every fix, scan, and test. Demonstrates good faith if challenged |

### Ongoing maintenance

Run WAVE and Lighthouse **after every theme update** (Shopify pushes Horizon updates regularly — v1.0.5 specifically included accessibility improvements). Re-test after adding any new app, product, or design change. Check alt text on new product images as they're added. Review your accessibility statement quarterly and update it with current status. Keep your Horizon theme updated via GitHub and use the Lighthouse CI action to prevent regressions. Annually, consider a professional re-audit of key pages ($1,000–$2,000).

---

## Conclusion

ADA compliance for your Shopify store is not optional — it's a legal requirement enforced through an aggressive private litigation ecosystem that disproportionately targets small e-commerce businesses. The Horizon theme provides a decent foundation but has specific gaps (focus styles, auto-play controls, dynamic content ARIA attributes) that require code-level fixes through your GitHub repository. Your highest-risk items are product image alt text (fixable in Shopify Admin today, zero cost) and keyboard/screen reader compatibility (requires theme code work).

The most important insight from this research: **compliance is a spectrum, not a binary state, and documented good-faith effort matters**. Merchants who had published accessibility statements, maintained remediation records, and demonstrated active improvement efforts were far more likely to get cases dismissed or settle favorably. One merchant got her case dismissed entirely by showing evidence of fixes in progress. Conversely, the single worst action you can take is installing an overlay widget — it provides false confidence while actively increasing your lawsuit exposure.

Start with the critical-priority items this week (alt text, keyboard test, focus indicators, contrast), set up Lighthouse CI in your GitHub repository to prevent regressions, publish an accessibility statement, and work through the remaining items over the next 1–3 months. Total investment: $0–$2,000 and approximately 20–30 hours of work, against potential lawsuit costs of $20,000–$95,000. The math is unambiguous.