# Testing and optimizing Shopify store speed: A complete guide

Shopify provides robust native tools for speed testing that align directly with Google's Core Web Vitals, making third-party paid solutions largely unnecessary for most merchants. Your Horizon theme—Shopify's newest flagship framework launched in Summer 2025—already includes significant performance optimizations, but meaningful improvements require understanding where admin settings end and code changes begin. The key finding: **admin-level optimizations handle approximately 40% of speed improvements** (app management, image sizing, theme settings), while **code-level changes unlock the remaining 60%** (script loading, CSS optimization, Liquid efficiency).

## Native Shopify speed tools give you real user data

Shopify replaced its single "speed score" in January 2024 with three Core Web Vitals metrics that match exactly what Google uses for search rankings. Access these through **Online Store → Themes** (quick summary banner) or **Analytics → Reports** (search "web performance" for detailed breakdowns).

The dashboard measures **LCP (Largest Contentful Paint)** for loading speed, **INP (Interaction to Next Paint)** for responsiveness, and **CLS (Cumulative Layout Shift)** for visual stability. These metrics come from real Chrome browser users visiting your store—not simulated tests—making them more accurate than lab-based tools. Shopify shows the 75th percentile, meaning 75% of your visitors experienced this score or better. Data updates with a **36-hour delay**, so changes won't reflect immediately.

The native reports include "Over Time" views that annotate when you installed apps, updated themes, or modified code—invaluable for diagnosing what caused performance drops. You can also break down metrics by page type (homepage, product, collection) and device (mobile vs desktop). For a Horizon store, expect desktop Lighthouse scores around **94** but mobile scores closer to **57** before optimization, primarily due to heavy imagery.

What Shopify's native tools don't measure: Time to First Byte, First Contentful Paint, Total Blocking Time, or Speed Index. For these deeper diagnostics, supplement with external tools.

## External tools worth using (all free)

**Google PageSpeed Insights** at pagespeed.web.dev remains the gold standard because it shows both "field data" (real user metrics from Chrome) and "lab data" (Lighthouse simulation). Test your homepage, a product page, and a collection page separately—Shopify weights product pages at 50% of your overall speed score. Always test in incognito mode, logged out, with password protection disabled.

For Shopify stores, realistic mobile scores of **50-70** are excellent—perfect 100 scores are essentially impossible with any apps installed. When PageSpeed warns about "eliminate render-blocking resources" or "reduce third-party code impact," these typically point to app scripts rather than Shopify's infrastructure.

**WebPageTest.org** provides the most detailed waterfall charts showing exactly when each resource loads. This free tool uses real browsers at actual connection speeds and helps identify specific bottlenecks—particularly useful for seeing which app scripts delay your page. **Chrome DevTools** (right-click → Inspect → Performance tab) enables real-time debugging with the ability to block specific URLs and test their impact.

Skip paid tools like GTmetrix Pro, Pingdom premium, or Ahrefs site audit—free tiers and native Shopify tools cover everything a Basic plan store needs.

## How Shopify's infrastructure handles performance automatically

Before optimizing anything, understand what Shopify already does: your store runs on a world-class CDN with HTTP/2 and HTTP/3 support, browser caching set to one year for static assets, automatic GZIP compression for CSS/JavaScript/HTML, and an image CDN that compresses uploads, converts to WebP where supported, and generates multiple responsive sizes automatically.

This means you can safely ignore certain PageSpeed recommendations: anything about server-level configuration, HTTP header optimization, CDN implementation, or compression settings is already handled. Third-party speed tools frequently flag these as "issues" without recognizing they're managed at the platform level.

The Horizon theme specifically includes **automatic lazy loading** for images below the fold, **responsive image generation** across all sections, and intelligent script loading that only loads JavaScript and CSS needed for sections actually present on the page.

## Admin-level optimizations you can do today

The highest-impact admin change is **app management**. Navigate to Apps → Apps and sales channel settings and audit every installed app. Uninstalled apps sometimes leave behind code in your theme—check your Web Performance reports for annotations correlating speed drops with app installations. Shopify recommends keeping apps under 20, but fewer always performs better.

In **Theme Customizer** (Online Store → Themes → Customize), reduce the number of sections per page template, choose single hero images over slideshows, and disable page transition animations if your store doesn't need them. Horizon's motion effects look impressive but cost performance.

For images, follow these sizing guidelines: hero images at **1,280×720 pixels**, product images at **2,048×2,048 pixels** (square), and keep total page weight under 2MB. Use Shopify's **Files** section for uploads rather than external hosting to ensure proper CDN delivery and automatic optimization.

Review **Online Store → Navigation** for excessive URL redirects that slow page loads. Check for broken links using free tools like Broken Link Checker.

## Code-level optimizations for your GitHub-backed theme

Since your Horizon theme connects to a GitHub repository, you can implement optimizations impossible through the admin interface. Set up your workflow with Shopify CLI: run `shopify theme dev` for local development with hot reload, `shopify theme push --unpublished` to create staging themes for testing, and `shopify theme check` before every commit to catch performance issues.

**Critical Liquid optimization**: Replace all `include` tags with `render` tags throughout your theme. The deprecated `include` tag creates performance overhead by sharing variable scope, while `render` creates isolated, compiled snippets:

```liquid
{% render 'product-card', product: product %}
```

Optimize loops by sorting collections *before* iteration, using `limit:` parameters, and avoiding nested loops deeper than two levels. Target **200ms maximum Liquid rendering time**—you can measure this with the Shopify Theme Inspector Chrome extension.

**Script loading** makes the largest single performance difference. Add `defer` to any script that depends on DOM content, and `async` to independent scripts like analytics. Never use the default `script_tag` filter for large files—instead write explicit script tags with loading attributes:

```html
<script src="{{ 'main.js' | asset_url }}" defer></script>
```

Keep JavaScript bundles under **16KB minified** and avoid heavy frameworks like jQuery, React, or Vue unless absolutely necessary—native browser APIs are significantly faster.

**Font strategy**: Self-host fonts in WOFF2 format (30% smaller than WOFF), limit to 2-3 font files maximum, and always use `font-display: swap` to prevent invisible text during loading. Preload your primary font in theme.liquid's `<head>` before the font CSS loads.

For images requiring custom handling beyond admin uploads, implement explicit srcset attributes for responsive loading and ensure above-the-fold images (hero, featured products) never have `loading="lazy"`—lazy loading the LCP element destroys your score.

## The admin versus code divide clarified

**Admin-only optimizations**: App installation/removal, theme preset selection, image uploads, checkout settings, payment configuration, domain settings, and staff permissions.

**Code-required optimizations**: Critical CSS inlining, defer/async script loading, custom srcset implementations, font-display declarations, removing unused CSS/JavaScript, Liquid loop restructuring, preload resource hints, and IIFE wrapping for scripts.

**Admin + code overlap**: Image compression (admin handles basics, code enables fine-tuning), lazy loading (Horizon includes it, code can customize which elements), font selection (admin chooses fonts, code controls loading strategy), and analytics (admin installs pixels, code consolidates via Google Tag Manager).

The practical rule: if you can accomplish a speed improvement through admin settings, do it there first—it's simpler to maintain and survives theme updates. Reserve code changes for optimizations that genuinely require template modification.

## Horizon theme considerations

Horizon is Shopify's newest free theme foundation, loading pages **15-20% faster than Dawn** with support for nested blocks up to 8 levels deep. The theme automatically skips JavaScript and CSS from sections not present on a given page, making it inherently performant.

However, Horizon emphasizes visual storytelling with heavy imagery and motion effects that punish mobile performance. Your optimization priority should focus on image sizing, reducing hero videos, and potentially disabling motion-safe animations through theme settings or CSS overrides.

Known Horizon issues as of its Summer 2025 launch include occasional bugs with sticky headers and mobile variant selectors—monitor Shopify's theme update changelog for fixes before assuming performance issues stem from your customizations.

For your GitHub workflow, never work directly on main branch—use a staging branch connected to an unpublished theme for testing. Run `shopify theme check` in your CI pipeline before merging to catch regressions. Consider adding Lighthouse CI GitHub Action for automated performance testing on pull requests.

## Conclusion

Testing your Shopify store speed requires just two tools: Shopify's native Web Performance Dashboard for real user metrics and Google PageSpeed Insights for diagnostic details. Both are free and provide everything needed for optimization decisions.

Start with admin-level changes—audit apps, resize images, simplify page sections—before touching code. When code changes are necessary, prioritize script defer/async attributes, Liquid loop optimization, and font loading strategy. Your Horizon theme already includes sophisticated performance features; the goal is removing friction rather than adding complexity. Track your Core Web Vitals weekly through Shopify's dashboard, correlate changes with the event annotations, and maintain your GitHub repository as the single source of truth for all theme modifications.