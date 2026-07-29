# Shopify MCP notes

Known gaps in the two Shopify MCP servers that may be registered: `shopify-dev` (docs search
+ code validation) and `shopify` (Admin data). Load this before a task that reads or writes
Admin data through the MCP, so it isn't misrouted.

- **Admin API access depends on the app's currently-granted scopes, which change; do not
  assume a fixed set.** Whenever you make or plan a change that relies on an Admin API
  capability (a write, a new resource type, a media upload), verify the app actually holds
  the scopes it needs rather than trusting any value recorded here. Get an Admin API token by
  exchanging `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` (`POST
  https://${MYSHOPIFY_DOMAIN}/admin/oauth/access_token`, `grant_type=client_credentials`) and
  list what it grants with `GET /admin/oauth/access_scopes.json`. The `shopify` Admin MCP also
  registers write tools (`create-product`, `manage-product-variants`, `update-product`) and
  they are callable; whether a given call succeeds is governed by the granted scopes, so
  check the scopes before relying on it. Prefer the token for reads the MCP truncates (e.g.
  `get-product-by-id` caps variants at 20 and cannot enumerate a full option set). Never
  commit the token or the exchange script.
- **SEO fields are not exposed by the MCP at all.** Products and collections carry
  `seo { title description }` in the Admin GraphQL API; the Page resource has no `seo` field
  and stores its SEO title/description in metafields
  (`metafield(namespace: "global", key: "title_tag" | "description_tag")`). Read or write any
  of these via the exchanged token (bullet above), not the MCP. Also note the render-time
  fallbacks: a null stored SEO title renders as the resource title on the storefront, so a
  crawl cannot tell you what is actually stored.
- **Media / image upload is not an MCP tool.** The MCP exposes no media or file upload tool,
  so theme imagery ships through the `assets/` directory. Product / media imagery goes
  through the Admin UI or the Admin GraphQL API (staged upload, then `fileCreate` / product
  media mutations), which the exchanged token can drive when the granted scopes cover it;
  verify the scopes per the bullet above before relying on that path.
- **No `templateSuffix`.** It is on neither `create-product` nor `update-product`, and the
  MCP does not return it on reads. Assigning a product's theme template is an Admin UI step,
  and a product whose suffix does not resolve has nothing behind it: this theme ships no
  default `templates/product.json`.
- **Shopify Flow is unreachable.** No MCP tool reads or writes Flow. A `.flow-export` file
  cannot be round-tripped through the MCP; Flow automations are inspected and edited only in
  the Admin Flow app. Do not attempt to reconstruct or diff Flow state from the MCP.
